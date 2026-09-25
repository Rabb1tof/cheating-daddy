const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createResponseStream } = require('../src/utils/responseStream');

function deferred() {
    let resolve;
    const promise = new Promise(done => (resolve = done));
    return { promise, resolve };
}

async function until(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected asynchronous event did not arrive');
}

function loadLocalAi(preferences = {}, responseText = index => `answer-${index}-first`) {
    const events = [];
    const savedTurns = [];
    const requests = [];
    const requestSignals = [];
    const gates = [];
    let port = 12000;
    const nativeRuntime = {
        ensureNativeBinary: async name => `/${name}`,
        ensureLlamaModel: async () => ({ modelPath: '/model.gguf', projectorPath: '/projector.gguf' }),
        ensureWhisperModel: async () => '/whisper.bin',
        getAvailablePort: async () => port++,
        getModelsDirectory: () => '/models',
        startNativeServer: () => ({}),
        stopNativeServer: () => {},
        waitForServer: async () => {},
    };
    const dependencies = {
        fs: { existsSync: () => true, readdirSync: () => [], rmSync: () => {} },
        path,
        './prompts': { getSystemPrompt: () => 'system prompt' },
        '../storage': { getPreferences: () => preferences },
        './gemini': {
            sendToRenderer: (channel, data) => events.push({ channel, data }),
            initializeNewSession: () => {},
            saveConversationTurn: (input, answer) => savedTurns.push({ input, answer }),
        },
        './responseStream': { createResponseStream },
        './native-ai-runtime': nativeRuntime,
    };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/localai.js'), 'utf8');
    vm.runInNewContext(
        source,
        {
            module,
            exports: module.exports,
            require: name => {
                if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
                return dependencies[name];
            },
            Buffer,
            AbortController,
            TextDecoder,
            Blob,
            FormData,
            process: { platform: 'win32' },
            console: { log: () => {}, error: () => {} },
            fetch: async (_url, options) => {
                const index = requests.length;
                const gate = deferred();
                gates.push(gate);
                requests.push(JSON.parse(options.body));
                requestSignals.push(options.signal);
                const encoder = new TextEncoder();
                const sse = content => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
                return {
                    ok: true,
                    body: {
                        async *[Symbol.asyncIterator]() {
                            yield sse(responseText(index));
                            await gate.promise;
                            yield sse(`-last`);
                        },
                    },
                };
            },
        },
        { filename: 'localai.js' }
    );
    return { local: module.exports, events, savedTurns, requests, requestSignals, gates };
}

test('local text and screenshot requests stream separately and serialize shared history', async () => {
    const harness = loadLocalAi();
    assert.equal(await harness.local.initializeLocalSession('model', 'whisper', 'interview', ''), true);

    const text = harness.local.sendLocalText('first question');
    await until(() => harness.requests.length === 1 && harness.events.some(event => event.channel === 'new-response'));
    const image = harness.local.sendLocalImage('image-base64', 'second question');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.requests.length, 1, 'the screenshot waits for the first answer');

    harness.gates[0].resolve();
    assert.equal((await text).success, true);
    await until(() => harness.requests.length === 2 && harness.events.filter(event => event.channel === 'new-response').length === 2);
    const secondMessages = harness.requests[1].messages;
    assert.equal(secondMessages[1].content, 'first question');
    assert.equal(secondMessages[2].content, 'answer-0-first-last');
    assert.equal(secondMessages[3].content[0].text, 'second question');

    harness.gates[1].resolve();
    assert.equal((await image).success, true);

    const starts = harness.events.filter(event => event.channel === 'new-response');
    const updates = harness.events.filter(event => event.channel === 'update-response');
    assert.notEqual(starts[0].data.id, starts[1].data.id);
    assert.equal(updates[0].data.id, starts[0].data.id);
    assert.equal(updates[1].data.id, starts[1].data.id);
    assert.deepEqual(harness.savedTurns, [
        { input: 'first question', answer: 'answer-0-first-last' },
        { input: 'second question', answer: 'answer-1-first-last' },
    ]);
    harness.local.closeLocalSession();
});

test('closing local session prevents a queued request from starting', async () => {
    const harness = loadLocalAi();
    await harness.local.initializeLocalSession('model', 'whisper', 'interview', '');
    const first = harness.local.sendLocalText('first');
    await until(() => harness.requests.length === 1);
    const second = harness.local.sendLocalText('second');
    harness.local.closeLocalSession();
    harness.gates[0].resolve();
    assert.equal((await first).success, false);
    assert.equal((await second).success, false);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.savedTurns.length, 0);
});

test('local answer memory checkbox omits previous turns from a follow-up prompt', async () => {
    const harness = loadLocalAi({ rememberRecentAnswers: false });
    await harness.local.initializeLocalSession('model', 'whisper', 'interview', '');
    const first = harness.local.sendLocalText('first');
    await until(() => harness.requests.length === 1);
    harness.gates[0].resolve();
    assert.equal((await first).success, true);

    const second = harness.local.sendLocalText('follow-up');
    await until(() => harness.requests.length === 2);
    assert.equal(harness.requests[1].messages.length, 2);
    assert.equal(harness.requests[1].messages[1].content, 'follow-up');
    harness.gates[1].resolve();
    assert.equal((await second).success, true);
    harness.local.closeLocalSession();
});

test('local recent answers use at most 1,800 UTF-8 bytes across three completed turns', async () => {
    const harness = loadLocalAi({}, () => 'Русский ответ 🧩 '.repeat(200));
    await harness.local.initializeLocalSession('model', 'whisper', 'interview', '');

    for (let index = 0; index < 2; index++) {
        const pending = harness.local.sendLocalText(`Вопрос ${index} 🧩 `.repeat(80));
        await until(() => harness.requests.length === index + 1);
        harness.gates[index].resolve();
        assert.equal((await pending).success, true);
    }

    const previousScreenshot = harness.local.sendLocalImage('PREVIOUS_IMAGE_BASE64', 'Описание скриншота 🧩 '.repeat(80));
    await until(() => harness.requests.length === 3);
    harness.gates[2].resolve();
    assert.equal((await previousScreenshot).success, true);

    const followUp = harness.local.sendLocalText('Следующий вопрос');
    await until(() => harness.requests.length === 4);
    const messages = harness.requests[3].messages;
    const previousTurns = messages.slice(1, -1);
    assert.equal(previousTurns.length, 6);
    assert.equal(previousTurns.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0) <= 1800, true);
    assert.equal(previousTurns.every(message => Buffer.byteLength(message.content, 'utf8') <= (message.role === 'assistant' ? 360 : 240)), true);
    assert.deepEqual(previousTurns.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(JSON.stringify(previousTurns).includes('PREVIOUS_IMAGE_BASE64'), false);
    assert.equal(JSON.stringify(previousTurns).includes('�'), false);
    assert.equal(messages.at(-1).content, 'Следующий вопрос');

    harness.gates[3].resolve();
    assert.equal((await followUp).success, true);
    harness.local.closeLocalSession();
});

test('local interrupt setting stops the old completion and keeps only the new answer in history', async () => {
    const harness = loadLocalAi({ interruptOnNewRequest: true });
    await harness.local.initializeLocalSession('model', 'whisper', 'interview', '');
    const first = harness.local.sendLocalText('first');
    await until(() => harness.requests.length === 1 && harness.events.some(event => event.channel === 'new-response'));
    const second = harness.local.sendLocalText('second');
    assert.equal(harness.requestSignals[0].aborted, true);

    harness.gates[0].resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(await first)), { success: true, interrupted: true });
    await until(() => harness.requests.length === 2);
    harness.gates[1].resolve();
    assert.equal((await second).success, true);
    assert.deepEqual(harness.savedTurns, [{ input: 'second', answer: 'answer-1-first-last' }]);
    harness.local.closeLocalSession();
});

test('cloud response chunks carry one ID per server response', async () => {
    const events = [];
    const sockets = [];
    class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        constructor() {
            super();
            this.readyState = FakeWebSocket.OPEN;
            sockets.push(this);
        }
        send() {}
        close() {
            this.emit('close', 1000, Buffer.alloc(0));
        }
    }
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/cloud.js'), 'utf8');
    vm.runInNewContext(
        source,
        {
            module,
            exports: module.exports,
            require: name => {
                if (name === 'ws') return FakeWebSocket;
                if (name === 'electron')
                    return { BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, data) => events.push({ channel, data }) } }] } };
                if (name === './responseStream') return { createResponseStream };
                throw new Error(`Unexpected dependency: ${name}`);
            },
            Buffer,
            setTimeout,
            clearTimeout,
            process: { stdout: { write: () => {} } },
            console: { log: () => {}, error: () => {} },
        },
        { filename: 'cloud.js' }
    );

    const connected = module.exports.connectCloud('test-token', 'interview', '');
    sockets[0].emit('open');
    await connected;
    const message = data => sockets[0].emit('message', Buffer.from(JSON.stringify(data)));
    message({ type: 'response_start' });
    message({ type: 'response_chunk', text: 'first ' });
    message({ type: 'response_chunk', text: 'answer' });
    message({ type: 'response_end' });
    message({ type: 'response_start' });
    message({ type: 'response_chunk', text: 'second' });

    const starts = events.filter(event => event.channel === 'new-response');
    const update = events.find(event => event.channel === 'update-response');
    assert.equal(starts.length, 2);
    assert.equal(update.data.id, starts[0].data.id);
    assert.equal(update.data.text, 'first answer');
    assert.notEqual(starts[0].data.id, starts[1].data.id);
    module.exports.closeCloud();
});
