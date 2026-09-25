const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getProviderLimits,
    subscribeProviderLimits,
    getGroqLimitsGeneration,
    clearGroqLimits,
    recordGroqLimits,
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
    assert.deepEqual(getProviderLimits(), { groq: [] });
    assert.equal(recordGroqLimits(observation('chat', 'old', 200), generation), false);
    assert.deepEqual(getProviderLimits(), { groq: [] });
});

test('retains only 12 most recent distinct observations', () => {
    clearGroqLimits();
    for (let index = 0; index < 13; index++) recordGroqLimits(observation('chat', `model-${index}`, index));
    const models = getProviderLimits().groq.map(item => item.model);
    assert.equal(models.length, 12);
    assert.equal(models.includes('model-0'), false);
    assert.equal(models[0], 'model-12');
});
