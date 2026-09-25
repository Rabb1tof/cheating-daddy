const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroqClient, GroqApiError } = require('../src/utils/groqClient');

const messages = [{ role: 'user', content: 'Hello' }];

function sseResponse(chunks = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']) {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeClock(start = 0) {
    let time = start;
    const waits = [];
    return {
        now: () => time,
        sleep: async ms => {
            waits.push(ms);
            time += ms;
        },
        waits,
    };
}

test('parses SSE events across line and UTF-8 transport boundaries', async () => {
    const source = new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"При"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"вет"}}]}\n\ndata: [DONE]\n\n'
    );
    const chunks = Array.from(source, byte => Uint8Array.of(byte));
    const progress = [];
    const client = createGroqClient();
    const result = await client.requestGroqCompletion({
        apiKey: 'test-key',
        model: 'custom-model',
        messages,
        onProgress: text => progress.push(text),
        fetchImpl: async () => sseResponse(chunks),
    });

    assert.deepEqual(result, { text: 'Привет', model: 'custom-model' });
    assert.deepEqual(progress, ['При', 'Привет']);
});

test('marks an answer truncated when the SSE finish reason is length', async () => {
    const stream =
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: [DONE]\n\n';
    const chunks = Array.from(new TextEncoder().encode(stream), byte => Uint8Array.of(byte));
    const client = createGroqClient();
    const result = await client.requestGroqCompletion({
        apiKey: 'key',
        model: 'vision-model',
        messages,
        kind: 'image',
        fetchImpl: async () => sseResponse(chunks),
    });
    assert.deepEqual(result, { text: 'partial', model: 'vision-model', truncated: true });
});

test('serializes requests and enforces text/image spacing', async () => {
    const clock = fakeClock();
    const client = createGroqClient(clock);
    const calls = [];
    let releaseFirst;
    const fetchImpl = async (_url, options) => {
        calls.push({ time: clock.now(), model: JSON.parse(options.body).model });
        if (calls.length === 1)
            return new Promise(resolve => {
                releaseFirst = resolve;
            });
        return sseResponse();
    };
    const first = client.requestGroqCompletion({ apiKey: 'key', model: 'one', messages, fetchImpl });
    const second = client.requestGroqCompletion({ apiKey: 'key', model: 'two', messages, kind: 'image', fetchImpl });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    releaseFirst(sseResponse());
    await Promise.all([first, second]);
    await client.requestGroqCompletion({ apiKey: 'key', model: 'three', messages, fetchImpl });

    assert.deepEqual(
        calls.map(call => call.time),
        [0, 30_000, 60_000]
    );
});

test('reserves an estimated rolling token budget without real delays', async () => {
    const clock = fakeClock();
    const client = createGroqClient(clock);
    const calls = [];
    const largeMessages = [{ role: 'user', content: 'a'.repeat(9_000) }];
    const fetchImpl = async () => {
        calls.push(clock.now());
        return sseResponse();
    };
    await client.requestGroqCompletion({ apiKey: 'key', model: 'one', messages: largeMessages, fetchImpl });
    await client.requestGroqCompletion({ apiKey: 'key', model: 'one', messages: largeMessages, fetchImpl });

    assert.deepEqual(calls, [0, 60_000]);
    assert.ok(clock.waits.includes(60_000));
    await assert.rejects(
        client.requestGroqCompletion({ apiKey: 'key', model: 'one', messages: [{ role: 'user', content: 'a'.repeat(20_000) }], fetchImpl }),
        /Shorten the conversation history/
    );
});

test('falls back after normal pacing and honors Retry-After on the limited model', async () => {
    const clock = fakeClock(1_000);
    const client = createGroqClient(clock);
    const calls = [];
    const fetchImpl = async (_url, options) => {
        const model = JSON.parse(options.body).model;
        calls.push({ model, time: clock.now() });
        if (model === 'primary') {
            return new Response(JSON.stringify({ error: { message: 'rate limited', code: 'rate_limit_exceeded' } }), {
                status: 429,
                headers: { 'retry-after': '75' },
            });
        }
        return sseResponse();
    };
    const options = { apiKey: 'key', model: 'primary', fallbackModel: 'backup', messages, fetchImpl };
    assert.deepEqual(await client.requestGroqCompletion(options), { text: 'ok', model: 'backup' });
    assert.deepEqual(await client.requestGroqCompletion(options), { text: 'ok', model: 'backup' });
    await assert.rejects(
        client.requestGroqCompletion({ apiKey: 'key', model: 'primary', messages, fetchImpl }),
        error => error instanceof GroqApiError && error.status === 429 && error.retryAfterMs === 75_000
    );
    assert.deepEqual(calls, [
        { model: 'primary', time: 1_000 },
        { model: 'backup', time: 9_000 },
        { model: 'backup', time: 17_000 },
        { model: 'primary', time: 76_000 },
    ]);
});

test('falls back on model errors, but not on an unrelated bad request', async () => {
    for (const [status, message] of [
        [403, 'Forbidden'],
        [404, 'Not found'],
        [400, 'model was decommissioned'],
    ]) {
        const clock = fakeClock();
        const client = createGroqClient(clock);
        const models = [];
        const fetchImpl = async (_url, options) => {
            const model = JSON.parse(options.body).model;
            models.push(model);
            return model === 'primary' ? new Response(JSON.stringify({ error: { message } }), { status }) : sseResponse();
        };
        const result = await client.requestGroqCompletion({ apiKey: 'key', model: 'primary', fallbackModel: 'backup', messages, fetchImpl });
        assert.equal(result.model, 'backup');
        assert.deepEqual(models, ['primary', 'backup']);
    }

    const client = createGroqClient(fakeClock());
    let calls = 0;
    await assert.rejects(
        client.requestGroqCompletion({
            apiKey: 'key',
            model: 'primary',
            fallbackModel: 'backup',
            messages,
            fetchImpl: async () => {
                calls++;
                return new Response(JSON.stringify({ error: { message: 'bad temperature' } }), { status: 400 });
            },
        }),
        error => error instanceof GroqApiError && error.status === 400 && /bad temperature/.test(error.message)
    );
    assert.equal(calls, 1);
});

test('does not retry a failed fallback', async () => {
    const client = createGroqClient(fakeClock());
    const models = [];
    await assert.rejects(
        client.requestGroqCompletion({
            apiKey: 'key',
            model: 'primary',
            fallbackModel: 'backup',
            messages,
            fetchImpl: async (_url, options) => {
                models.push(JSON.parse(options.body).model);
                return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 404 });
            },
        }),
        error => error instanceof GroqApiError && error.status === 404 && error.model === 'backup'
    );
    assert.deepEqual(models, ['primary', 'backup']);
});

test('sends reasoning fields only for known compatible models', async () => {
    const client = createGroqClient(fakeClock());
    const bodies = [];
    const fetchImpl = async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return sseResponse();
    };
    for (const model of ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'custom-model']) {
        await client.requestGroqCompletion({ apiKey: 'key', model, messages, disableThinking: true, fetchImpl });
    }

    assert.equal(bodies[0].max_completion_tokens, 512);
    assert.deepEqual([bodies[0].reasoning_format, bodies[0].reasoning_effort], ['hidden', 'none']);
    assert.deepEqual([bodies[1].include_reasoning, bodies[1].reasoning_effort], [false, 'low']);
    assert.equal('reasoning_format' in bodies[2], false);
    assert.equal('reasoning_effort' in bodies[2], false);
    assert.equal('include_reasoning' in bodies[2], false);
});

test('reserves a larger image completion allowance in the request and token budget', async () => {
    const client = createGroqClient(fakeClock());
    let body;
    const fetchImpl = async (_url, options) => {
        body = JSON.parse(options.body);
        return sseResponse();
    };
    await client.requestGroqCompletion({ apiKey: 'key', model: 'vision-model', messages, kind: 'image', fetchImpl });
    assert.equal(body.max_completion_tokens, 1_024);

    const largeImageMessages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'a'.repeat(8_000) },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,test' } },
            ],
        },
    ];
    await assert.rejects(
        client.requestGroqCompletion({ apiKey: 'key', model: 'vision-model', messages: largeImageMessages, kind: 'image', fetchImpl }),
        /Shorten the conversation history/
    );
});

test('aborting a queued request prevents any API call after the first request completes', async () => {
    const client = createGroqClient();
    const controller = new AbortController();
    let releaseFirst;
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        if (calls === 1)
            return new Promise(resolve => {
                releaseFirst = resolve;
            });
        return sseResponse();
    };
    const first = client.requestGroqCompletion({ apiKey: 'key', model: 'one', messages, fetchImpl });
    const queued = client.requestGroqCompletion({ apiKey: 'key', model: 'two', messages, fetchImpl, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('session closed'));
    await assert.rejects(queued, /session closed/);
    releaseFirst(sseResponse());
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
});

test('aborting during pacing or fetch rejects promptly without another request', async () => {
    const pacingClient = createGroqClient({ now: () => 0, sleep: () => new Promise(() => {}) });
    let pacingCalls = 0;
    const pacingFetch = async () => {
        pacingCalls++;
        return sseResponse();
    };
    await pacingClient.requestGroqCompletion({ apiKey: 'key', model: 'one', messages, fetchImpl: pacingFetch });
    const pacingController = new AbortController();
    const paced = pacingClient.requestGroqCompletion({
        apiKey: 'key',
        model: 'one',
        messages,
        fetchImpl: pacingFetch,
        signal: pacingController.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    pacingController.abort(new Error('stop pacing'));
    await assert.rejects(paced, /stop pacing/);
    assert.equal(pacingCalls, 1);

    const activeClient = createGroqClient();
    const activeController = new AbortController();
    let passedSignal;
    const active = activeClient.requestGroqCompletion({
        apiKey: 'key',
        model: 'one',
        messages,
        signal: activeController.signal,
        fetchImpl: async (_url, options) => {
            passedSignal = options.signal;
            return new Promise(() => {});
        },
    });
    await new Promise(resolve => setImmediate(resolve));
    activeController.abort(new Error('stop active request'));
    await assert.rejects(active, /stop active request/);
    assert.equal(passedSignal.aborted, true);
});

test('bounds HTTP and queue waits with explicit timeouts without real timers', async () => {
    const timers = new Map();
    let nextId = 0;
    const client = createGroqClient({
        setTimer: (callback, ms) => {
            const id = ++nextId;
            timers.set(id, { callback, ms });
            return id;
        },
        clearTimer: id => timers.delete(id),
    });
    let passedSignal;
    const active = client.requestGroqCompletion({
        apiKey: 'key',
        model: 'one',
        messages,
        fetchImpl: async (_url, options) => {
            passedSignal = options.signal;
            return new Promise(() => {});
        },
    });
    await new Promise(resolve => setImmediate(resolve));
    const httpTimer = [...timers.values()].find(timer => timer.ms === 25_000);
    assert.ok(httpTimer);
    httpTimer.callback();
    await assert.rejects(active, error => error instanceof GroqApiError && error.code === 'timeout' && error.model === 'one');
    assert.equal(passedSignal.aborted, true);
    assert.equal(timers.size, 0);

    const clock = fakeClock();
    const queueClient = createGroqClient(clock);
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return sseResponse();
    };
    await queueClient.requestGroqCompletion({ apiKey: 'key', model: 'one', messages, fetchImpl });
    await assert.rejects(
        queueClient.requestGroqCompletion({ apiKey: 'key', model: 'one', messages, fetchImpl, timeoutMs: 5_000 }),
        error => error instanceof GroqApiError && error.code === 'timeout'
    );
    assert.equal(calls, 1);
});
