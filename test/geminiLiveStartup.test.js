const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { connectWithSetupGuard, trackLiveTransport } = require('../src/utils/liveSetupGuard');
const { createResponseStream } = require('../src/utils/responseStream');
const promptModule = require('../src/utils/prompts');

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

function createHarness(connectBehavior, onStatus = () => {}, { groqKey = '', responseProvider = 'auto', preferences = {}, modelConfig = {}, prompts, imageStream, groqCompletion, onEvent = () => {} } = {}) {
    const events = [];
    const handlers = {};
    const sentInputs = [];
    const sentClientContents = [];
    const imageRequests = [];
    const groqRequests = [];
    let configuredResponseProvider = responseProvider;
    let callbacks;
    let liveConnectParams;
    let transportTerminated = 0;
    const session = {
        close: () => {},
        sendRealtimeInput: async input => sentInputs.push(input),
        sendClientContent: async input => sentClientContents.push(input),
    };
    const contextGlobal = { geminiSessionRef: { current: null } };

    class FakeGoogleGenAI {
        constructor() {
            this.models = {
                generateContentStream: async params => {
                    imageRequests.push(params);
                    return imageStream
                        ? imageStream(params)
                        : (async function* () {
                              yield { text: 'answer' };
                              yield { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
                          })();
                },
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
                    liveConnectParams = params;
                    callbacks = params.callbacks;
                    this.live.webSocketFactory.create();
                    return connectBehavior(params.callbacks, session);
                },
            };
        }
    }

    const dependencies = {
        '@google/genai': {
            GoogleGenAI: FakeGoogleGenAI,
            Modality: { AUDIO: 'AUDIO' },
            ActivityHandling: { NO_INTERRUPTION: 'NO_INTERRUPTION', START_OF_ACTIVITY_INTERRUPTS: 'START_OF_ACTIVITY_INTERRUPTS' },
        },
        electron: {
            BrowserWindow: {
                getAllWindows: () => [
                    {
                        webContents: {
                            send(channel, data) {
                                events.push({ channel, data });
                                onEvent(channel, data);
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
        './prompts':
            prompts || {
                getSystemPrompt: () => 'test prompt',
                getCompactSystemPrompt: () => 'test prompt',
                getScreenshotSystemPrompt: () => 'test screenshot prompt',
            },
        '../storage': {
            getApiKey: () => 'test-only',
            getGroqApiKey: () => groqKey,
            incrementCharUsage: () => {},
            getConfig: () => ({ geminiLiveModel: 'test-live', geminiImageModel: 'test-image', groqModel: 'test-groq', responseProvider: configuredResponseProvider, ...modelConfig }),
            getPreferences: () => ({ googleSearchEnabled: false, ...preferences }),
        },
        './groqTranscription': { GroqTranscriptionSession: class {} },
        './pcm': { resample24kTo16k: () => {} },
        './modelCatalog': { listModels: () => [] },
        './groqClient': {
            requestGroqCompletion: async request => {
                groqRequests.push(request);
                if (groqCompletion) return groqCompletion(request, groqRequests.length - 1);
                return { text: 'Groq answer', model: 'test-groq' };
            },
        },
        './responseStream': { createResponseStream },
        './recentAnswers': require('../src/utils/recentAnswers'),
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
            process: { stdout: { write: () => {} } },
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
        sentInputs,
        sentClientContents,
        imageRequests,
        groqRequests,
        setResponseProvider: value => (configuredResponseProvider = value),
        ref: contextGlobal.geminiSessionRef,
        get liveConnectParams() {
            return liveConnectParams;
        },
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

for (const responseProvider of ['auto', 'gemini']) test(`Gemini Live streams its own answers with saved Groq key and ${responseProvider} response setting`, async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, { groqKey: 'saved-groq-key', responseProvider });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    const started = await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US');
    assert.equal(started, true);

    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'First ' } } });
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'second' } } });
    const responseEvents = harness.events.filter(event => event.channel === 'new-response' || event.channel === 'update-response');
    assert.deepEqual(
        responseEvents.map(event => ({ channel: event.channel, text: event.data.text })),
        [
            { channel: 'new-response', text: 'First ' },
            { channel: 'update-response', text: 'First second' },
        ]
    );
    assert.equal(responseEvents[0].data.id, responseEvents[1].data.id);

    harness.setResponseProvider('groq');
    const result = await harness.handlers['send-text-message']({}, 'Follow up');
    assert.equal(result.success, true);
    assert.equal(harness.sentInputs.length, 0);
    harness.callbacks.onmessage({ serverContent: { turnComplete: true } });
    assert.equal(harness.sentInputs.length, 1);
    assert.equal(harness.sentInputs[0].text, 'Follow up');
    assert.equal(harness.groqRequests.length, 0);
});

test('Gemini Live interrupt setting changes activity handling and explicit text can barge in', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { interruptOnNewRequest: true },
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);
    assert.equal(harness.liveConnectParams.config.realtimeInputConfig.activityHandling, 'START_OF_ACTIVITY_INTERRUPTS');

    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Partial answer' } } });
    const sent = await harness.handlers['send-text-message']({}, 'New question');
    assert.equal(sent.success, true);
    assert.equal(harness.sentInputs.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.sentClientContents)), [
        { turns: [{ role: 'user', parts: [{ text: 'New question' }] }], turnComplete: true },
    ]);
    harness.callbacks.onmessage({ serverContent: { interrupted: true } });
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'New answer' } } });
    const responses = harness.events.filter(event => event.channel === 'new-response' || event.channel === 'update-response');
    assert.equal(responses[1].data.text, 'Partial answer\n\n[Interrupted]');
    assert.notEqual(responses[0].data.id, responses[2].data.id);
});

test('Gemini Live sends a queued typed request after reconnect when the old turn never completes', async () => {
    let connections = 0;
    const reconnected = deferred();
    const harness = createHarness(
        (_callbacks, session) => Promise.resolve(++connections === 1 ? session : { ...session }),
        status => {
            if (status === 'Reconnected! Listening...') reconnected.resolve();
        }
    );
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    const oldCallbacks = harness.callbacks;
    oldCallbacks.onmessage({ serverContent: { outputTranscription: { text: 'Unfinished answer' } } });
    assert.equal((await harness.handlers['send-text-message']({}, 'Queued follow-up')).success, true);
    assert.equal(harness.sentInputs.length, 0);
    oldCallbacks.onclose({ code: 1006, reason: 'network lost' });

    let reconnectTimeout;
    try {
        await Promise.race([
            reconnected.promise,
            new Promise((_, reject) => {
                reconnectTimeout = setTimeout(() => reject(new Error('Gemini Live reconnect timed out')), 4000);
            }),
        ]);
    } finally {
        clearTimeout(reconnectTimeout);
    }
    assert.equal(connections, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.sentInputs)), [{ text: 'Queued follow-up' }]);
    assert.notEqual(harness.ref.current, harness.session);
});

test('Groq keeps the first answer and builds the next prompt after it finishes by default', async () => {
    const firstGate = deferred();
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        groqKey: 'test-groq-key',
        responseProvider: 'groq',
        preferences: { rememberRecentAnswers: true },
        groqCompletion: async (_request, index) => {
            if (index === 0) await firstGate.promise;
            return { text: index === 0 ? 'First answer' : 'Second answer', model: 'test-groq' };
        },
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    const first = harness.handlers['send-text-message']({}, 'First question');
    await until(() => harness.groqRequests.length === 1);
    const second = harness.handlers['send-text-message']({}, 'Second question');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.groqRequests.length, 1);
    firstGate.resolve();
    assert.equal((await first).success, true);
    assert.equal((await second).success, true);
    assert.equal(harness.groqRequests.length, 2);
    assert.equal(harness.groqRequests[0].signal.aborted, false);
    assert.ok(harness.groqRequests[1].messages.some(message => typeof message.content === 'string' && message.content.includes('First answer')));
});

test('Groq interrupt setting aborts the old request without saving its partial answer', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        groqKey: 'test-groq-key',
        responseProvider: 'groq',
        preferences: { interruptOnNewRequest: true },
        groqCompletion: async (request, index) => {
            if (index === 0) {
                request.onProgress('Old partial');
                await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
            }
            return { text: 'New answer', model: 'test-groq' };
        },
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    const first = harness.handlers['send-text-message']({}, 'First question');
    await until(() => harness.groqRequests.length === 1);
    const second = harness.handlers['send-text-message']({}, 'Second question');
    const firstResult = await first;
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.interrupted, true);
    assert.equal(harness.groqRequests[0].signal.aborted, true);
    assert.equal((await second).success, true);
    const saved = harness.events.filter(event => event.channel === 'save-conversation-turn');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.turn.transcription, 'Second question');
});

test('Gemini HTTP screenshot aborts an older stream only when interruption is enabled', async () => {
    const firstGate = deferred();
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { interruptOnNewRequest: true },
        imageStream: () => {
            const index = harness.imageRequests.length - 1;
            return (async function* () {
                yield { text: index === 0 ? 'Old partial' : 'New answer' };
                if (index === 0) {
                    await firstGate.promise;
                    yield { text: ' old ending' };
                }
            })();
        },
    });
    harness.gemini.initializeNewSession('interview', '');
    const first = harness.gemini.sendImageToGeminiHttp('first-image', 'First screenshot');
    await until(() => harness.imageRequests.length === 1 && harness.events.some(event => event.channel === 'new-response'));
    const second = harness.gemini.sendImageToGeminiHttp('second-image', 'Second screenshot');
    await until(() => harness.imageRequests.length === 2);
    assert.equal(harness.imageRequests[0].config.abortSignal.aborted, true);
    firstGate.resolve();
    const firstResult = await first;
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.interrupted, true);
    assert.equal((await second).success, true);
    const saved = harness.events.filter(event => event.channel === 'save-screen-analysis');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.analysis.prompt, 'Second screenshot');
});

test('explicit Groq answers preserve Gemini Live transcription hybrid', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        groqKey: 'saved-groq-key',
        responseProvider: 'groq',
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    const started = await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US');
    assert.equal(started, true);

    harness.callbacks.onmessage({ serverContent: { inputTranscription: { text: 'Question' } } });
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Hidden Gemini answer' } } });
    harness.callbacks.onmessage({ serverContent: { turnComplete: true } });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(harness.groqRequests.length, 1);
    assert.equal(harness.groqRequests[0].messages.at(-1).content, 'Question');
    assert.equal(harness.events.some(event => event.channel === 'new-response' && event.data.text === 'Hidden Gemini answer'), false);
    assert.ok(harness.events.some(event => event.channel === 'new-response' && event.data.text === 'Groq answer'));

    harness.setResponseProvider('gemini');
    const typed = await harness.handlers['send-text-message']({}, 'Follow up');
    assert.equal(typed.success, true);
    assert.equal(harness.groqRequests.length, 2);
    assert.match(harness.groqRequests[1].messages.at(-1).content, /Groq answer/);
    assert.match(harness.groqRequests[1].messages.at(-1).content, /Current request: Follow up$/);
    assert.equal(harness.sentInputs.length, 0);
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

test('Gemini Live sends the detailed interview instructions and user context', async () => {
    const context = 'Resume: built payment APIs in Go. Vacancy: backend engineer for payment services.';
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { responseStyle: 'detailed' },
        prompts: promptModule,
    });

    const session = await harness.gemini.initializeGeminiSession('test-only', context, 'interview', 'ru-RU');
    assert.ok(session);
    assert.equal(harness.liveConnectParams.config.realtimeInputConfig.activityHandling, 'NO_INTERRUPTION');
    const instruction = harness.liveConnectParams.config.systemInstruction.parts[0].text;
    assert.match(instruction, /4-6 meaningful sentences/);
    assert.match(instruction, /Resume: built payment APIs in Go\. Vacancy: backend engineer for payment services\./);
    assert.match(instruction, /Russian \(ru-RU\)/);
    assert.doesNotMatch(instruction, /1-3 sentences max/);
});

test('Gemini screenshot uses the detailed resume and vacancy context and streams before completion', async () => {
    const context = 'Resume: shipped a billing platform. Vacancy: backend engineer for payment services.';
    let releaseSecondChunk;
    const secondChunkGate = new Promise(resolve => {
        releaseSecondChunk = resolve;
    });
    let resolveFirstChunk;
    const firstChunkSeen = new Promise(resolve => {
        resolveFirstChunk = resolve;
    });
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { responseStyle: 'detailed', selectedProfile: 'interview', selectedLanguage: 'en-US', customPrompt: context },
        prompts: promptModule,
        imageStream: () =>
            (async function* () {
                yield { text: 'First ' };
                await secondChunkGate;
                yield { text: 'second' };
                yield { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
            })(),
        onEvent: channel => {
            if (channel === 'new-response') resolveFirstChunk();
        },
    });

    const pending = harness.gemini.sendImageToGeminiHttp('fake-base64', 'What is shown?');
    await firstChunkSeen;
    const instruction = harness.imageRequests[0].config.systemInstruction;
    assert.match(instruction, /4-6 natural sentences/);
    assert.match(instruction, /Resume: shipped a billing platform\. Vacancy: backend engineer for payment services\./);
    const firstResponses = harness.events.filter(event => ['new-response', 'update-response'].includes(event.channel));
    assert.deepEqual(firstResponses.map(event => ({ channel: event.channel, text: event.data.text })), [{ channel: 'new-response', text: 'First ' }]);

    releaseSecondChunk();
    const result = await pending;
    assert.equal(result.text, 'First second');
    const completedResponses = harness.events.filter(event => ['new-response', 'update-response'].includes(event.channel));
    assert.deepEqual(
        completedResponses.map(event => ({ channel: event.channel, text: event.data.text })),
        [
            { channel: 'new-response', text: 'First ' },
            { channel: 'update-response', text: 'First second' },
        ]
    );
    assert.equal(completedResponses[0].data.id, completedResponses[1].data.id);
});

test('Groq screenshot keeps a long Russian context within the free-tier request budget', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        groqKey: 'test-groq-key',
        modelConfig: { screenshotProvider: 'groq', groqImageModel: 'test-vision' },
        preferences: {
            responseStyle: 'detailed',
            selectedProfile: 'interview',
            selectedLanguage: 'ru-RU',
            customPrompt: `Резюме: ${'разрабатывал платёжные сервисы 🧩 '.repeat(180)} Вакансия: backend engineer.`,
        },
        prompts: promptModule,
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    await harness.gemini.initializeGeminiSession(
        'test-only',
        `Резюме: ${'разрабатывал платёжные сервисы 🧩 '.repeat(180)} Вакансия: backend engineer.`,
        'interview',
        'ru-RU'
    );
    harness.gemini.saveConversationTurn('Предыдущий вопрос', 'Полный предыдущий ответ 🧩 '.repeat(100));
    const result = await harness.handlers['send-image-content']({}, {
        data: Buffer.alloc(1000, 1).toString('base64'),
        prompt: `Напиши полный код для задачи: ${'условие и пример 🧩 '.repeat(100)}`,
    });
    assert.equal(result.success, true);
    const request = harness.groqRequests[0];
    const system = request.messages[0].content;
    const userText = request.messages[1].content[0].text;
    const reservedTokens = 1024 + 3072 + 24 + Math.ceil(Buffer.byteLength(system, 'utf8') / 3) + Math.ceil(Buffer.byteLength(userText, 'utf8') / 3);
    assert.ok(reservedTokens <= 6500, `estimated ${reservedTokens} tokens exceeded the app budget`);
    assert.match(system, /complete requested code without placeholders/);
    assert.match(system, /Context truncated/);
    assert.match(system, /Russian \(ru-RU\)/);
    assert.match(userText, /Recent completed answers/);
});

test('Gemini screenshot memory uses completed answers from this session and clears on a new session', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.initializeNewSession('interview', '');
    harness.gemini.saveConversationTurn('Earlier question', 'Distinct earlier answer');
    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'First screenshot');
    assert.match(harness.imageRequests[0].contents[1].text, /Distinct earlier answer/);

    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'Second screenshot');
    assert.match(harness.imageRequests[1].contents[1].text, /Screenshot: First screenshot/);

    harness.gemini.initializeNewSession('interview', '');
    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'Fresh session screenshot');
    assert.doesNotMatch(harness.imageRequests[2].contents[1].text, /Distinct earlier answer|First screenshot/);
});

test('memory checkbox omits prior answers from Groq text and Gemini screenshots', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        groqKey: 'saved-groq-key',
        responseProvider: 'groq',
        preferences: { rememberRecentAnswers: false },
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);
    harness.gemini.saveConversationTurn('Earlier question', 'Distinct earlier answer');

    assert.equal((await harness.handlers['send-text-message']({}, 'Follow up')).success, true);
    assert.equal(harness.groqRequests[0].messages.length, 2);
    assert.doesNotMatch(JSON.stringify(harness.groqRequests[0].messages), /Distinct earlier answer/);

    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'Screenshot');
    assert.doesNotMatch(harness.imageRequests[0].contents[1].text, /Distinct earlier answer/);
});

test('a completed typed Gemini Live answer enters session memory for a later screenshot', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    assert.equal((await harness.handlers['send-text-message']({}, 'Typed interview question')).success, true);
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Typed answer' } } });
    harness.callbacks.onmessage({ serverContent: { generationComplete: true } });
    const saved = harness.events.filter(event => event.channel === 'save-conversation-turn');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.turn.transcription, 'Typed interview question');
    assert.equal(saved[0].data.turn.ai_response, 'Typed answer');

    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'Follow-up screenshot');
    assert.match(harness.imageRequests[0].contents[1].text, /Typed answer/);
});

test('a completed screenshot is shared once with an idle Gemini Live connection as bounded context', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    assert.equal((await harness.gemini.sendImageToGeminiHttp('fake-base64', 'What is on screen?')).success, true);
    await until(() => harness.sentClientContents.length === 1);
    const injected = harness.sentClientContents[0];
    assert.equal(injected.turnComplete, false);
    assert.match(injected.turns[0].parts[0].text, /Screenshot: What is on screen\?/);
    assert.match(injected.turns[0].parts[0].text, /Answer: answer/);
    assert.ok(Buffer.byteLength(injected.turns[0].parts[0].text, 'utf8') <= 1300);
});

test('screenshot memory waits for the old Gemini Live answer and respects the memory checkbox', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Old answer' } } });
    await harness.gemini.sendImageToGeminiHttp('fake-base64', 'Screenshot while speaking');
    assert.equal(harness.sentClientContents.length, 0);
    harness.callbacks.onmessage({ serverContent: { turnComplete: true } });
    await until(() => harness.sentClientContents.length === 1);

    const withoutMemory = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { rememberRecentAnswers: false },
    });
    withoutMemory.gemini.setupGeminiIpcHandlers(withoutMemory.ref);
    assert.equal(await withoutMemory.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);
    await withoutMemory.gemini.sendImageToGeminiHttp('fake-base64', 'No memory');
    assert.equal(withoutMemory.sentClientContents.length, 0);
});

test('Gemini Live keeps updating its old response while a screenshot streams', async () => {
    let releaseScreenshot;
    const screenshotGate = new Promise(resolve => (releaseScreenshot = resolve));
    let firstScreenshotChunk;
    const screenshotStarted = new Promise(resolve => (firstScreenshotChunk = resolve));
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        imageStream: () => (async function* () {
            yield { text: 'Screen ' };
            await screenshotGate;
            yield { text: 'done' };
        })(),
        onEvent: (channel, data) => {
            if (channel === 'new-response' && data.text === 'Screen ') firstScreenshotChunk();
        },
    });
    await harness.gemini.initializeGeminiSession('test-only');
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Old ' } } });
    const screenshot = harness.gemini.sendImageToGeminiHttp('fake-base64', 'Explain the screenshot');
    await screenshotStarted;
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'answer' } } });
    releaseScreenshot();
    await screenshot;

    const events = harness.events.filter(event => ['new-response', 'update-response'].includes(event.channel));
    assert.deepEqual(events.map(event => [event.channel, event.data.text]), [
        ['new-response', 'Old '],
        ['new-response', 'Screen '],
        ['update-response', 'Old answer'],
        ['update-response', 'Screen done'],
    ]);
    assert.equal(events[0].data.id, events[2].data.id);
    assert.equal(events[1].data.id, events[3].data.id);
    assert.notEqual(events[0].data.id, events[1].data.id);
});

test('Gemini Live does not save a combined transcript when new speech arrives during the old answer', async () => {
    const harness = createHarness((_callbacks, session) => Promise.resolve(session));
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    harness.callbacks.onmessage({ serverContent: { inputTranscription: { text: 'First question. ' } } });
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Old ' } } });
    harness.callbacks.onmessage({ serverContent: { inputTranscription: { text: 'Second question.' } } });
    harness.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'answer' } } });
    harness.callbacks.onmessage({ serverContent: { generationComplete: true } });

    const responseEvents = harness.events.filter(event => event.channel === 'new-response' || event.channel === 'update-response');
    assert.deepEqual(responseEvents.map(event => event.data.text), ['Old ', 'Old answer']);
    assert.equal(responseEvents[0].data.id, responseEvents[1].data.id);
    assert.equal(harness.events.filter(event => event.channel === 'save-conversation-turn').length, 0);
});

test('explicit Gemini Live text aborts an in-flight screenshot when interruption is enabled', async () => {
    const screenshotGate = deferred();
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { interruptOnNewRequest: true },
        imageStream: () =>
            (async function* () {
                yield { text: 'Partial screenshot' };
                await screenshotGate.promise;
                yield { text: ' answer' };
            })(),
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    const screenshot = harness.gemini.sendImageToGeminiHttp('fake-base64', 'Explain screenshot');
    await until(() => harness.imageRequests.length === 1 && harness.events.some(event => event.channel === 'new-response'));
    const textResult = await harness.handlers['send-text-message']({}, 'New question');
    assert.equal(textResult.success, true);
    assert.equal(harness.imageRequests[0].config.abortSignal.aborted, true);
    assert.equal(harness.sentClientContents.length, 1);

    screenshotGate.resolve();
    assert.equal((await screenshot).interrupted, true);
    assert.equal(harness.events.filter(event => event.channel === 'save-screen-analysis').length, 0);
});

test('a recognized Gemini Live speech turn interrupts HTTP screenshot once when enabled', async () => {
    const screenshotGate = deferred();
    const harness = createHarness((_callbacks, session) => Promise.resolve(session), undefined, {
        preferences: { interruptOnNewRequest: true },
        imageStream: () =>
            (async function* () {
                yield { text: 'Partial screenshot' };
                await screenshotGate.promise;
                yield { text: ' ending' };
            })(),
    });
    harness.gemini.setupGeminiIpcHandlers(harness.ref);
    assert.equal(await harness.handlers['initialize-gemini']({}, 'test-only', '', 'interview', 'en-US'), true);

    const screenshot = harness.gemini.sendImageToGeminiHttp('fake-base64', 'First screenshot');
    await until(() => harness.imageRequests.length === 1 && harness.events.some(event => event.channel === 'new-response'));
    harness.callbacks.onmessage({ serverContent: { inputTranscription: { text: 'New spoken question' } } });
    assert.equal(harness.imageRequests[0].config.abortSignal.aborted, true);
    screenshotGate.resolve();
    assert.equal((await screenshot).interrupted, true);
});
