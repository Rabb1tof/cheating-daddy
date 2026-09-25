const test = require('node:test');
const assert = require('node:assert/strict');
const { listModels, groupGeminiModels } = require('../src/utils/modelCatalog');

test('Gemini catalog follows pagination and separates Live from generateContent models', async () => {
    const calls = [];
    const fetchMock = async (url, options) => {
        calls.push({ url: String(url), key: options.headers['x-goog-api-key'] });
        return {
            ok: true,
            json: async () =>
                calls.length === 1
                    ? { models: [{ name: 'models/gemini-3.8-live', displayName: 'Live' }], nextPageToken: 'next' }
                    : { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] },
        };
    };

    const result = await listModels('gemini', fetchMock, { gemini: 'test-key' });
    assert.deepEqual(
        result.live.map(model => model.id),
        ['gemini-3.8-live']
    );
    assert.deepEqual(
        result.image.map(model => model.id),
        ['gemini-3.8-flash']
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /pageToken=next/);
    assert.equal(calls[0].key, 'test-key');
    assert.doesNotMatch(calls[0].url, /test-key/);
});

test('Gemini Live suggestions include native audio without transcription, translation, or TTS models', () => {
    const models = [
        { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025' },
        { name: 'models/gemini-live-example' },
        { name: 'models/gemini-live-transcription-example' },
        { name: 'models/gemini-native-audio-translation-example' },
        { name: 'models/gemini-native-audio-preview-tts' },
        { name: 'models/gemini-native-audio-speech-to-text' },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    ];

    const result = groupGeminiModels(models);
    assert.deepEqual(
        result.live.map(model => model.id),
        ['gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-live-example']
    );
    assert.deepEqual(
        result.image.map(model => model.id),
        ['gemini-3.8-flash']
    );
});

test('Groq catalog excludes inactive and non-chat models from response suggestions', async () => {
    const fetchMock = async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer test-key');
        return {
            ok: true,
            json: async () => ({
                data: [
                    { id: 'whisper-large-v3-turbo', active: true },
                    { id: 'qwen/qwen3.8-27b', active: true },
                    { id: 'retired-model', active: false },
                ],
            }),
        };
    };
    const result = await listModels('groq', fetchMock, { groq: 'test-key' });
    assert.deepEqual(
        result.speech.map(model => model.id),
        ['whisper-large-v3-turbo']
    );
    assert.deepEqual(
        result.chat.map(model => model.id),
        ['qwen/qwen3.8-27b']
    );
    assert.deepEqual(
        result.image.map(model => model.id),
        ['qwen/qwen3.8-27b']
    );
});

test('catalog errors expose provider response without leaking credentials', async () => {
    const fetchMock = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: { message: 'Model list is disabled' } }),
    });
    await assert.rejects(listModels('groq', fetchMock, { groq: 'test-key' }), /Groq model list failed \(403\): Model list is disabled/);
});
