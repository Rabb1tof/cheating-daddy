// Response-header limits and token usage observed by this app are ephemeral.
const groq = new Map();
const gemini = new Map();
const listeners = new Set();
let generation = 0;
let geminiGeneration = 0;

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
        gemini: [...gemini.values()].sort((left, right) => right.observedAt - left.observedAt).map(item => ({ ...item })),
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

function getGeminiUsageGeneration() {
    return geminiGeneration;
}

function clearGeminiUsage() {
    geminiGeneration += 1;
    gemini.clear();
    notify();
}

const GEMINI_TOKEN_FIELDS = [
    'promptTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'cachedContentTokenCount',
    'totalTokenCount',
];

function addReportedCounts(previous, current) {
    if (previous === null || current === null) return null;
    return optionalCount(previous + current);
}

// These are token counts reported in responses to this app. Live messages are
// snapshots; only completed HTTP requests are summed within a session.
function recordGeminiUsage(observation, requestGeneration = geminiGeneration) {
    if (requestGeneration !== geminiGeneration || observation?.provider !== 'gemini') return false;
    if (!['live', 'image', 'text'].includes(observation.kind)) return false;
    if (typeof observation.model !== 'string' || !observation.model.trim() || observation.model.length > 200) return false;
    if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) return false;
    const sessionId = observation.sessionId ?? null;
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100)) return false;

    const metadata = observation.usageMetadata;
    if (!metadata || typeof metadata !== 'object') return false;
    const item = {
        provider: 'gemini',
        kind: observation.kind,
        model: observation.model,
        sessionId,
        observedAt: observation.observedAt,
        observationCount: 1,
    };
    for (const field of GEMINI_TOKEN_FIELDS) {
        // Live calls this responseTokenCount; HTTP calls it candidatesTokenCount.
        const value = field === 'candidatesTokenCount' ? metadata.candidatesTokenCount ?? metadata.responseTokenCount : metadata[field];
        item[field] = optionalCount(value);
    }
    if (GEMINI_TOKEN_FIELDS.every(field => item[field] === null)) return false;

    const key = `${item.kind}\0${item.model}\0${item.sessionId || ''}`;
    const previous = gemini.get(key);
    if (previous && previous.observedAt > item.observedAt) return false;
    if (previous) {
        item.observationCount = previous.observationCount + 1;
        if (item.kind !== 'live') {
            for (const field of GEMINI_TOKEN_FIELDS) item[field] = addReportedCounts(previous[field], item[field]);
        }
    }
    gemini.set(key, item);
    if (gemini.size > 12) {
        const oldest = [...gemini.entries()].sort((left, right) => left[1].observedAt - right[1].observedAt)[0][0];
        gemini.delete(oldest);
    }
    notify();
    return true;
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

module.exports = {
    getProviderLimits,
    subscribeProviderLimits,
    getGroqLimitsGeneration,
    clearGroqLimits,
    recordGroqLimits,
    getGeminiUsageGeneration,
    clearGeminiUsage,
    recordGeminiUsage,
};
