const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getProviderLimits,
    subscribeProviderLimits,
    getGroqLimitsGeneration,
    clearGroqLimits,
    recordGroqLimits,
    getGeminiUsageGeneration,
    clearGeminiUsage,
    recordGeminiUsage,
} = require('../src/utils/providerLimits');

function observation(kind, model, observedAt) {
    return {
        provider: 'groq',
        kind,
        model,
        observedAt,
        status: 429,
        requestsPerDay: { limit: 1000, remaining: 12, reset: 30000 },
        tokensPerMinute: { limit: 6000, remaining: 2400, reset: 15000 },
        retryAfterMs: 3000,
        apiKey: 'must-never-be-exposed',
    };
}

test('stores sanitized Groq observations by kind and model, newest first', () => {
    clearGroqLimits();
    const events = [];
    const unsubscribe = subscribeProviderLimits(snapshot => events.push(snapshot));
    assert.equal(recordGroqLimits(observation('chat', 'model-a', 100)), true);
    assert.equal(recordGroqLimits(observation('speech', 'model-b', 200)), true);
    assert.equal(recordGroqLimits(observation('chat', 'model-a', 50)), false);
    const state = getProviderLimits();
    assert.deepEqual(
        state.groq.map(item => item.model),
        ['model-b', 'model-a']
    );
    assert.equal(state.groq[0].requestsPerDay.remaining, 12);
    assert.equal(state.groq[0].tokensPerMinute.remaining, 2400);
    assert.equal(JSON.stringify(state).includes('must-never-be-exposed'), false);
    assert.equal(events.length, 2);
    unsubscribe();
});

test('key rotation clears observations and ignores old in-flight responses', () => {
    clearGroqLimits();
    const generation = getGroqLimitsGeneration();
    recordGroqLimits(observation('chat', 'old', 100), generation);
    clearGroqLimits();
    assert.deepEqual(getProviderLimits().groq, []);
    assert.equal(recordGroqLimits(observation('chat', 'old', 200), generation), false);
    assert.deepEqual(getProviderLimits().groq, []);
});

test('retains only 12 most recent distinct observations', () => {
    clearGroqLimits();
    for (let index = 0; index < 13; index++) recordGroqLimits(observation('chat', `model-${index}`, index));
    const models = getProviderLimits().groq.map(item => item.model);
    assert.equal(models.length, 12);
    assert.equal(models.includes('model-0'), false);
    assert.equal(models[0], 'model-12');
});

function geminiObservation(kind, model, sessionId, observedAt, usageMetadata) {
    return { provider: 'gemini', kind, model, sessionId, observedAt, usageMetadata, apiKey: 'must-never-be-exposed' };
}

test('Gemini Live retains the latest reported snapshot rather than summing server messages', () => {
    clearGeminiUsage();
    recordGeminiUsage(geminiObservation('live', 'live-a', 'session-1', 100, {
        promptTokenCount: 120,
        responseTokenCount: 40,
        totalTokenCount: 160,
    }));
    recordGeminiUsage(geminiObservation('live', 'live-a', 'session-1', 200, {
        promptTokenCount: 150,
        responseTokenCount: 50,
        totalTokenCount: 200,
    }));
    const [latest] = getProviderLimits().gemini;
    assert.equal(latest.totalTokenCount, 200);
    assert.equal(latest.candidatesTokenCount, 50);
    assert.equal(latest.observationCount, 2);
    assert.equal(JSON.stringify(latest).includes('must-never-be-exposed'), false);
});

test('Gemini HTTP totals sum distinct completed requests within each session', () => {
    clearGeminiUsage();
    recordGeminiUsage(geminiObservation('image', 'image-a', 'session-1', 100, {
        promptTokenCount: 100,
        candidatesTokenCount: 30,
        totalTokenCount: 130,
    }));
    recordGeminiUsage(geminiObservation('image', 'image-a', 'session-1', 200, {
        promptTokenCount: 80,
        candidatesTokenCount: 20,
        totalTokenCount: 100,
    }));
    recordGeminiUsage(geminiObservation('image', 'image-a', 'session-2', 300, {
        totalTokenCount: 50,
    }));
    const bySession = Object.fromEntries(getProviderLimits().gemini.map(item => [item.sessionId, item]));
    assert.equal(bySession['session-1'].totalTokenCount, 230);
    assert.equal(bySession['session-1'].promptTokenCount, 180);
    assert.equal(bySession['session-1'].observationCount, 2);
    assert.equal(bySession['session-2'].totalTokenCount, 50);
    assert.equal(bySession['session-2'].promptTokenCount, null);
});

test('Gemini key rotation clears observations and rejects old requests', () => {
    clearGeminiUsage();
    const generation = getGeminiUsageGeneration();
    recordGeminiUsage(geminiObservation('text', 'model-a', null, 100, { totalTokenCount: 10 }), generation);
    clearGeminiUsage();
    assert.deepEqual(getProviderLimits().gemini, []);
    assert.equal(recordGeminiUsage(geminiObservation('text', 'model-a', null, 200, { totalTokenCount: 10 }), generation), false);
    assert.deepEqual(getProviderLimits().gemini, []);
});
