const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { connectWithSetupGuard, trackLiveTransport } = require('../src/utils/liveSetupGuard');

function createHarness(connectBehavior, onStatus = () => {}) {
    const events = [];
    const handlers = {};
    let callbacks;
    let transportTerminated = 0;
    const session = { close: () => {} };
    const contextGlobal = { geminiSessionRef: { current: null } };

    class FakeGoogleGenAI {
        constructor() {
            this.models = {
                generateContentStream: async () => (async function* () {
                    yield { text: 'answer' };
                    yield { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
                })(),
            };
            this.live = {
                webSocketFactory: {
                    create: () => ({
                        ws: {
                            readyState: 1,
                            terminate() {
                                transportTerminated++;
                                this.readyState = 3;
                            },
                        },
                    }),
                },
                connect: params => {
                    callbacks = params.callbacks;
                    this.live.webSocketFactory.create();
                    return connectBehavior(params.callbacks, session);
                },
            };
        }
    }

    const dependencies = {
        '@google/genai': { GoogleGenAI: FakeGoogleGenAI, Modality: { AUDIO: 'AUDIO' } },
        electron: {
            BrowserWindow: {
                getAllWindows: () => [
                    {
                        webContents: {
                            send(channel, data) {
                                events.push({ channel, data });
                                if (channel === 'update-status') onStatus(data, () => callbacks);
                            },
                        },
                    },
                ],
            },
            ipcMain: { handle: (channel, handler) => (handlers[channel] = handler) },
        },
        child_process: { spawn: () => {} },
        '../audioUtils': { saveDebugAudio: () => {} },
        './prompts': { getSystemPrompt: () => 'test prompt', getCompactSystemPrompt: () => 'test prompt' },
        '../storage': {
            getApiKey: () => 'test-only',
            getGroqApiKey: () => '',
            incrementCharUsage: () => {},
            getConfig: () => ({ geminiLiveModel: 'test-live', geminiImageModel: 'test-image' }),
            getPreferences: () => ({ googleSearchEnabled: false }),
        },
        './groqTranscription': { GroqTranscriptionSession: class {} },
        './pcm': { resample24kTo16k: () => {} },
        './modelCatalog': { listModels: () => [] },
        './groqClient': { requestGroqCompletion: () => {} },
        './providerLimits': {
            getGroqLimitsGeneration: () => 0,
            recordGroqLimits: () => {},
            getGeminiUsageGeneration: () => 0,
            recordGeminiUsage: observation => events.push({ channel: 'usage', observation }),
        },
        './liveSetupGuard': { connectWithSetupGuard, trackLiveTransport },
        './cloud': {},
        './transportLogger': {
            startTransportLog: () => {},
            logTransportEvent: (type, data) => events.push({ channel: 'log', type, data }),
            closeTransportLog: () => {},
        },
    };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/gemini.js'), 'utf8');
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
            setTimeout,
            clearTimeout,
            console: { log: () => {}, error: () => {} },
            global: contextGlobal,
        },
        { filename: 'gemini.js' }
    );
    return {
        gemini: module.exports,
        events,
        handlers,
        session,
        ref: contextGlobal.geminiSessionRef,
        get callbacks() {
            return callbacks;
        },
        get transportTerminated() {
            return transportTerminated;
        },
    };
}

test('Gemini Live close in the post-setup window fails startup without a connected status', async () => {
    const harness = createHarness((callbacks, session) => {
        callbacks.onopen();
        callbacks.onmessage({ setupComplete: {} });
        setTimeout(() => callbacks.onclose({ code: 1008, reason: 'selected model does not support Live' }), 5);
        return Promise.resolve(session);
    });

    const result = await harness.gemini.initializeGeminiSession('test-only');
    assert.equal(result, null);
    assert.equal(
        harness.events.some(event => event.data === 'Live session connected'),
        false
    );
    assert.ok(harness.events.some(event => event.type === 'gemini.live.connect.failed'));
    assert.ok(harness.events.some(event => String(event.data).includes('selected model does not support Live')));
    assert.equal(harness.transportTerminated, 1);
});

test('Gemini Live close before IPC assignment cannot publish a stale session', async () => {
    const harness = createHarness(
        (_callbacks, session) => Promise.resolve(session),
        (status, getCallbacks) => {
            if (status === 'Live session connected') {
                queueMicrotask(() => getCallbacks().onclose({ code: 1008, reason: 'model stopped' }));
            }
        }
    );
    harness.gemini.setupGeminiIpcHandlers(harness.ref);

    const success = await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US');
    assert.equal(success, false);
    assert.equal(harness.ref.current, null);
});

test('Gemini Live close clears only its own session reference', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    const success = await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US');
    assert.equal(success, true);
    assert.equal(harness.ref.current, harness.session);

    harness.callbacks.onclose({ code: 1008, reason: 'model stopped' });
    assert.equal(harness.ref.current, null);
    harness.ref.current = { newer: true };
    const eventCount = harness.events.length;
    harness.callbacks.onclose({ code: 1008, reason: 'old socket closed again' });
    assert.deepEqual(harness.ref.current, { newer: true });
    assert.equal(harness.events.length, eventCount);
});

test('Gemini Live publishes reported token usage without counting setup messages', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    await harness.gemini.initializeGeminiSession('test-only');
    harness.callbacks.onmessage({ usageMetadata: { promptTokenCount: 70, responseTokenCount: 20, totalTokenCount: 90 } });
    const observations = harness.events.filter(event => event.channel === 'usage');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].observation.kind, 'live');
    assert.equal(observations[0].observation.model, 'test-live');
    assert.equal(observations[0].observation.usageMetadata.totalTokenCount, 90);
});

test('Gemini screenshot stream publishes final response usage once', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    const result = await harness.gemini.sendImageToGeminiHttp('fake-base64', 'What is shown?');
    assert.equal(result.success, true);
    const observations = harness.events.filter(event => event.channel === 'usage');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].observation.kind, 'image');
    assert.equal(observations[0].observation.model, 'test-image');
    assert.equal(observations[0].observation.usageMetadata.totalTokenCount, 120);
});
