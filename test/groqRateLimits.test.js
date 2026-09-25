const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGroqRateLimits, parseRetryAfterMs } = require('../src/utils/groqRateLimits');
const { createGroqClient } = require('../src/utils/groqClient');
const { transcribePcm, GroqTranscriptionSession } = require('../src/utils/groqTranscription');

const messages = [{ role: 'user', content: 'hello' }];

function chatResponse(headers = {}) {
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers,
    });
}

test('parses documented Groq request/day and token/minute headers without exposing raw headers', () => {
    const response = new Response('', {
        status: 200,
        headers: {
            'x-ratelimit-limit-requests': '14400',
            'x-ratelimit-remaining-requests': '0',
            'x-ratelimit-reset-requests': '2m59.56s',
            'x-ratelimit-limit-tokens': '18000',
            'x-ratelimit-remaining-tokens': '17997',
            'x-ratelimit-reset-tokens': '7.66s',
            'x-unrelated-secret': 'never-report-this',
        },
    });

    assert.deepEqual(parseGroqRateLimits(response, { kind: 'chat', model: 'selected-model', observedAt: 1234 }), {
        provider: 'groq',
        kind: 'chat',
        model: 'selected-model',
        observedAt: 1234,
        status: 200,
        requestsPerDay: { limit: 14400, remaining: 0, reset: 179560 },
        tokensPerMinute: { limit: 18000, remaining: 17997, reset: 7660 },
        retryAfterMs: null,
    });
});

test('missing or malformed quota headers stay unknown; a 429 can report only Retry-After', () => {
    const invalid = new Response('', {
        status: 200,
        headers: {
            'x-ratelimit-limit-requests': '-1',
            'x-ratelimit-remaining-requests': 'not a number',
            'x-ratelimit-reset-requests': 'tomorrow',
            'x-ratelimit-limit-tokens': '9007199254740992',
        },
    });
    assert.equal(parseGroqRateLimits(invalid, { kind: 'speech', model: 'whisper', observedAt: 1000 }), null);

    const limited = new Response('', { status: 429, headers: { 'retry-after': '1.5' } });
    assert.deepEqual(parseGroqRateLimits(limited, { kind: 'speech', model: 'whisper', observedAt: 1000 }), {
        provider: 'groq',
        kind: 'speech',
        model: 'whisper',
        observedAt: 1000,
        status: 429,
        requestsPerDay: { limit: null, remaining: null, reset: null },
        tokensPerMinute: { limit: null, remaining: null, reset: null },
        retryAfterMs: 1500,
    });
    assert.equal(parseRetryAfterMs('Fri, 25 Sep 2026 12:00:02 GMT', Date.parse('Fri, 25 Sep 2026 12:00:00 GMT')), 2000);
    assert.equal(parseRetryAfterMs('invalid'), null);
});

test('chat observes each existing HTTP response, including a 429 before fallback, without extra calls', async () => {
    let time = 1000;
    const client = createGroqClient({ now: () => time, sleep: async ms => (time += ms) });
    const observations = [];
    let calls = 0;
    const result = await client.requestGroqCompletion({
        apiKey: 'test-key',
        model: 'primary',
        fallbackModel: 'backup',
        messages,
        onRateLimits: observation => {
            observations.push(observation);
            if (observation.model === 'primary') throw new Error('observer failure');
        },
        fetchImpl: async (_url, options) => {
            calls++;
            const model = JSON.parse(options.body).model;
            if (model === 'primary') {
                return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
                    status: 429,
                    headers: { 'retry-after': '30', 'x-ratelimit-remaining-requests': '4' },
                });
            }
            return chatResponse({ 'x-ratelimit-remaining-tokens': '250' });
        },
    });

    assert.deepEqual(result, { text: 'ok', model: 'backup' });
    assert.equal(calls, 2);
    assert.deepEqual(
        observations.map(({ kind, model, status }) => [kind, model, status]),
        [
            ['chat', 'primary', 429],
            ['chat', 'backup', 200],
        ]
    );
    assert.equal(observations[0].retryAfterMs, 30000);
    assert.equal(observations[0].requestsPerDay.remaining, 4);
    assert.equal(observations[1].tokensPerMinute.remaining, 250);
});

test('speech observes success and error responses; rejected async observers do not change transcription', async () => {
    const observations = [];
    let calls = 0;
    const options = {
        apiKey: 'test-key',
        model: 'whisper-large-v3-turbo',
        onRateLimits: observation => {
            observations.push(observation);
            return Promise.reject(new Error('observer failure'));
        },
        fetchImpl: async () => {
            calls++;
            return calls === 1
                ? new Response(JSON.stringify({ text: 'hello' }), {
                      status: 200,
                      headers: { 'x-ratelimit-remaining-requests': '9' },
                  })
                : new Response(JSON.stringify({ error: { message: 'slow down' } }), {
                      status: 429,
                      headers: { 'retry-after': '2', 'x-ratelimit-remaining-requests': '8' },
                  });
        },
    };

    assert.equal(await transcribePcm(Buffer.alloc(2), options), 'hello');
    await assert.rejects(transcribePcm(Buffer.alloc(2), options), error => error.status === 429 && error.retryAfterMs === 2000);
    assert.equal(calls, 2);
    assert.deepEqual(
        observations.map(({ kind, status, requestsPerDay }) => [kind, status, requestsPerDay.remaining]),
        [
            ['speech', 200, 9],
            ['speech', 429, 8],
        ]
    );
});

test('speech session passes the observer through primary and fallback transcription attempts', async () => {
    const options = [];
    const onRateLimits = () => {};
    const session = new GroqTranscriptionSession({
        apiKey: 'test-key',
        model: 'primary',
        fallbackModel: 'backup',
        onRateLimits,
        onTranscript: () => {},
        onError: () => {},
        requestIntervalMs: 0,
        transcribe: async (_pcm, attempt) => {
            options.push(attempt);
            if (attempt.model === 'primary') throw Object.assign(new Error('unavailable'), { status: 404 });
            return 'hello';
        },
    });
    try {
        assert.equal(await session.transcribeWithFallback(Buffer.alloc(2)), 'hello');
        assert.deepEqual(
            options.map(option => option.model),
            ['primary', 'backup']
        );
        assert.ok(options.every(option => option.onRateLimits === onRateLimits));
    } finally {
        session.close();
    }
});
