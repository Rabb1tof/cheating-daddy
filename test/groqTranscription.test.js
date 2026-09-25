const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechSegmenter, GroqTranscriptionSession, pcmToWavBuffer, transcribePcm } = require('../src/utils/groqTranscription');

function audioChunk(amplitude, durationMs = 100) {
    const samples = (24000 * durationMs) / 1000;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(amplitude, i * 2);
    return pcm;
}

function feedUtterance(session) {
    for (let i = 0; i < 5; i++) session.push('mic', audioChunk(1200));
    for (let i = 0; i < 8; i++) session.push('mic', audioChunk(0));
}

async function waitFor(predicate) {
    for (let i = 0; i < 20; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Timed out waiting for transcription');
}

test('speech segmentation ignores silence and short noise, then emits one utterance', () => {
    const segmenter = new SpeechSegmenter();
    const segments = [];
    for (let i = 0; i < 10; i++) segments.push(...segmenter.push(audioChunk(0)));
    segmenter.push(audioChunk(1000));
    for (let i = 0; i < 8; i++) segments.push(...segmenter.push(audioChunk(0)));
    assert.equal(segments.length, 0);

    for (let i = 0; i < 5; i++) segments.push(...segmenter.push(audioChunk(1200)));
    for (let i = 0; i < 8; i++) segments.push(...segmenter.push(audioChunk(0)));
    assert.equal(segments.length, 1);
    assert.ok(segments[0].length >= audioChunk(1200, 1100).length);
});

test('speech segmentation bounds a continuous utterance', () => {
    const segmenter = new SpeechSegmenter({ maxSegmentMs: 1000 });
    const segments = [];
    for (let i = 0; i < 15; i++) segments.push(...segmenter.push(audioChunk(1200)));
    assert.equal(segments.length, 1);
    assert.equal(segments[0].length, audioChunk(1200, 1000).length);
});

test('WAV framing and automatic input-language detection match Groq transcription input', async () => {
    const pcm = audioChunk(1200);
    const wav = pcmToWavBuffer(pcm);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    const transcript = await transcribePcm(pcm, {
        apiKey: 'test-key',
        model: 'whisper-large-v3-turbo',
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
            assert.equal(options.headers.Authorization, 'Bearer test-key');
            assert.equal(options.body.get('model'), 'whisper-large-v3-turbo');
            assert.equal(options.body.get('language'), null);
            assert.equal(options.body.get('response_format'), 'json');
            const uploaded = Buffer.from(await options.body.get('file').arrayBuffer());
            assert.deepEqual(uploaded, wav);
            return { ok: true, json: async () => ({ text: '  привет  ' }) };
        },
    });
    assert.equal(transcript, 'привет');
});

test('a retired speech model gets one serialized fallback attempt', async () => {
    const models = [];
    const transcripts = [];
    const session = new GroqTranscriptionSession({
        apiKey: 'test-key',
        model: 'old-speech-model',
        fallbackModel: 'whisper-large-v3-turbo',
        requestIntervalMs: 0,
        onTranscript: text => transcripts.push(text),
        onError: error => assert.fail(error.message),
        transcribe: async (_pcm, options) => {
            models.push(options.model);
            if (models.length === 1) throw Object.assign(new Error('Model unavailable'), { status: 404 });
            return 'hello';
        },
    });
    feedUtterance(session);
    await waitFor(() => transcripts.length === 1);
    assert.deepEqual(models, ['old-speech-model', 'whisper-large-v3-turbo']);
    assert.equal(session.model, 'whisper-large-v3-turbo');
    session.close();
});

test('a model-specific 429 tries a distinct fallback after request spacing', async () => {
    const models = [];
    const transcripts = [];
    const session = new GroqTranscriptionSession({
        apiKey: 'test-key',
        model: 'primary',
        fallbackModel: 'secondary',
        requestIntervalMs: 1,
        onTranscript: text => transcripts.push(text),
        onError: error => assert.fail(error.message),
        transcribe: async (_pcm, options) => {
            models.push(options.model);
            if (options.model === 'primary') throw Object.assign(new Error('Rate limited'), { status: 429, retryAfterMs: 60000 });
            return 'fallback answer';
        },
    });
    feedUtterance(session);
    await waitFor(() => transcripts.length === 1);
    assert.deepEqual(models, ['primary', 'secondary']);
    session.close();
});

test('a 429 pauses new transcription instead of repeatedly retrying', async () => {
    let calls = 0;
    const errors = [];
    const session = new GroqTranscriptionSession({
        apiKey: 'test-key',
        model: 'whisper-large-v3-turbo',
        requestIntervalMs: 0,
        onTranscript: () => assert.fail('Unexpected transcript'),
        onError: error => errors.push(error.message),
        transcribe: async () => {
            calls++;
            throw Object.assign(new Error('Rate limited'), { status: 429, retryAfterMs: 30000 });
        },
    });
    feedUtterance(session);
    await waitFor(() => errors.length === 1);
    feedUtterance(session);
    assert.equal(calls, 1);
    assert.ok(session.pausedUntil > Date.now());
    session.close();
});

test('a text-model quota error stops spending speech quota', async () => {
    let speechCalls = 0;
    const errors = [];
    const session = new GroqTranscriptionSession({
        apiKey: 'test-key',
        model: 'whisper-large-v3-turbo',
        requestIntervalMs: 0,
        transcribe: async () => {
            speechCalls++;
            return 'question';
        },
        onTranscript: async () => {
            throw Object.assign(new Error('Text models rate limited'), { status: 429, retryAfterMs: 30000 });
        },
        onError: error => errors.push(error.message),
    });
    feedUtterance(session);
    await waitFor(() => errors.length === 1);
    feedUtterance(session);
    assert.equal(speechCalls, 1);
    assert.ok(session.pausedUntil > Date.now());
    session.close();
});
