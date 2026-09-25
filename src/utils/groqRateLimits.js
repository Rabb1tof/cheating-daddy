function readHeader(headers, name) {
    try {
        return headers?.get?.(name) ?? null;
    } catch {
        return null;
    }
}

function parseCount(value) {
    if (value == null || !/^\d+$/.test(String(value).trim())) return null;
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
}

function parseDurationMs(value) {
    if (value == null) return null;
    const duration = String(value).trim();
    if (!duration) return null;
    if (/^\d+(?:\.\d+)?$/.test(duration)) {
        const milliseconds = Math.ceil(Number(duration) * 1000);
        return Number.isSafeInteger(milliseconds) ? milliseconds : null;
    }

    const part = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/gy;
    const unitMs = { ms: 1, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    let offset = 0;
    let milliseconds = 0;
    while (offset < duration.length) {
        part.lastIndex = offset;
        const match = part.exec(duration);
        if (!match) return null;
        milliseconds += Number(match[1]) * unitMs[match[2]];
        offset = part.lastIndex;
    }
    milliseconds = Math.ceil(milliseconds);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (value == null || !String(value).trim()) return null;
    const raw = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return parseDurationMs(raw);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function parseGroqRateLimits(response, { kind, model, observedAt = Date.now() }) {
    const headers = response?.headers;
    const requestsPerDay = {
        limit: parseCount(readHeader(headers, 'x-ratelimit-limit-requests')),
        remaining: parseCount(readHeader(headers, 'x-ratelimit-remaining-requests')),
        reset: parseDurationMs(readHeader(headers, 'x-ratelimit-reset-requests')),
    };
    const tokensPerMinute = {
        limit: parseCount(readHeader(headers, 'x-ratelimit-limit-tokens')),
        remaining: parseCount(readHeader(headers, 'x-ratelimit-remaining-tokens')),
        reset: parseDurationMs(readHeader(headers, 'x-ratelimit-reset-tokens')),
    };
    const status = Number.isInteger(response?.status) ? response.status : null;
    const retryAfterMs = status === 429 ? parseRetryAfterMs(readHeader(headers, 'retry-after'), observedAt) : null;
    if ([...Object.values(requestsPerDay), ...Object.values(tokensPerMinute), retryAfterMs].every(value => value === null)) return null;

    return {
        provider: 'groq',
        kind,
        model,
        observedAt,
        status,
        requestsPerDay,
        tokensPerMinute,
        retryAfterMs,
    };
}

function notifyGroqRateLimits(onRateLimits, response, context) {
    if (typeof onRateLimits !== 'function') return;
    try {
        const observation = parseGroqRateLimits(response, context);
        if (observation) Promise.resolve(onRateLimits(observation)).catch(() => {});
    } catch {
        // Quota display must never interfere with an inference request.
    }
}

module.exports = { parseGroqRateLimits, parseRetryAfterMs, notifyGroqRateLimits };
