// Only limits observed in responses to this application's own requests are
// available with an API key. This state is deliberately ephemeral.
const groq = new Map();
const listeners = new Set();
let generation = 0;

function optionalCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metric(value) {
    return {
        limit: optionalCount(value?.limit),
        remaining: optionalCount(value?.remaining),
        reset: optionalCount(value?.reset),
    };
}

function getProviderLimits() {
    return {
        groq: [...groq.values()]
            .sort((left, right) => right.observedAt - left.observedAt)
            .map(item => ({
                ...item,
                requestsPerDay: { ...item.requestsPerDay },
                tokensPerMinute: { ...item.tokensPerMinute },
            })),
    };
}

function notify() {
    const snapshot = getProviderLimits();
    for (const listener of listeners) {
        try {
            listener(snapshot);
        } catch {
            // A quota display must not affect provider requests.
        }
    }
}

function subscribeProviderLimits(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getGroqLimitsGeneration() {
    return generation;
}

function clearGroqLimits() {
    generation += 1;
    groq.clear();
    notify();
}

function recordGroqLimits(observation, requestGeneration = generation) {
    if (requestGeneration !== generation || observation?.provider !== 'groq') return false;
    if (!['chat', 'speech'].includes(observation.kind)) return false;
    if (typeof observation.model !== 'string' || !observation.model.trim() || observation.model.length > 200) return false;
    if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) return false;

    const item = {
        provider: 'groq',
        kind: observation.kind,
        model: observation.model,
        observedAt: observation.observedAt,
        status: Number.isInteger(observation.status) && observation.status >= 100 && observation.status <= 599 ? observation.status : null,
        requestsPerDay: metric(observation.requestsPerDay),
        tokensPerMinute: metric(observation.tokensPerMinute),
        retryAfterMs: optionalCount(observation.retryAfterMs),
    };
    const key = `${item.kind}\0${item.model}`;
    if ((groq.get(key)?.observedAt ?? -1) > item.observedAt) return false;
    groq.set(key, item);
    if (groq.size > 12) {
        const oldest = [...groq.entries()].sort((left, right) => left[1].observedAt - right[1].observedAt)[0][0];
        groq.delete(oldest);
    }
    notify();
    return true;
}

module.exports = { getProviderLimits, subscribeProviderLimits, getGroqLimitsGeneration, clearGroqLimits, recordGroqLimits };
