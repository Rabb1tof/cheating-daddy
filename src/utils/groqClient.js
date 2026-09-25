const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const { parseRetryAfterMs, notifyGroqRateLimits } = require('./groqRateLimits');
const WINDOW_MS = 60_000;
const TOKEN_BUDGET = 6_500;
const TEXT_COMPLETION_TOKENS = 512;
const IMAGE_COMPLETION_TOKENS = 1_024;
const TEXT_GAP_MS = 8_000;
const IMAGE_GAP_MS = 30_000;
const MODEL_COOLDOWN_MS = 60_000;
// A queued request may need the full rolling-token window before its 25s HTTP attempt.
const REQUEST_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 25_000;
const IMAGE_TOKEN_RESERVE = 3_072; // Groq currently counts 2,048 tokens per image; leave a margin.

class GroqApiError extends Error {
    constructor(message, { status, model, code, retryAfterMs } = {}) {
        super(message);
        this.name = 'GroqApiError';
        this.status = status;
        this.model = model;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}

function abortReason(signal) {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error('Groq request cancelled');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal.aborted) throw abortReason(signal);
}

function waitWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(abortReason(signal));
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(abortReason(signal));
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function raceWithAbort(promise, signal) {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        function onAbort() {
            signal.removeEventListener('abort', onAbort);
            reject(abortReason(signal));
        }
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function estimateRequestTokens(messages, completionTokens) {
    let tokens = completionTokens;
    for (const message of messages) {
        tokens += 12; // Role and message framing.
        const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            if (part.type === 'image_url') {
                tokens += IMAGE_TOKEN_RESERVE;
            } else if (part.type === 'text' && typeof part.text === 'string') {
                tokens += Math.ceil(Buffer.byteLength(part.text, 'utf8') / 3);
            }
        }
    }
    return tokens;
}

function reasoningOptions(model, disableThinking) {
    if (!disableThinking) return {};
    if (model === 'qwen/qwen3.8-27b') return { reasoning_format: 'hidden', reasoning_effort: 'none' };
    if (model === 'openai/gpt-oss-20b' || model === 'openai/gpt-oss-120b') {
        return { include_reasoning: false, reasoning_effort: 'low' };
    }
    return {}; // Unknown/custom models may reject reasoning parameters.
}

function isModelInvalid400(error) {
    if (error.status !== 400) return false;
    const detail = `${error.code || ''} ${error.message}`;
    return (
        /model/i.test(detail) &&
        /invalid|not[_ -]?found|unknown|decommissioned|does not exist|not available|not supported|unsupported|permission|access/i.test(detail)
    );
}

function shouldFallback(error) {
    return error instanceof GroqApiError && ([403, 404, 429].includes(error.status) || isModelInvalid400(error));
}

async function readApiError(response, model, now) {
    const raw = await response.text().catch(() => '');
    let details;
    try {
        details = JSON.parse(raw).error;
    } catch {
        details = null;
    }
    const reason = details?.message || raw.slice(0, 1_000) || `HTTP ${response.status}`;
    const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers?.get?.('retry-after'), now) : null;
    return new GroqApiError(`Groq ${response.status} for ${model}: ${reason}`, {
        status: response.status,
        model,
        code: details?.code,
        retryAfterMs,
    });
}

async function readCompletion(response, model, onProgress, signal) {
    if (!response.body?.getReader) throw new GroqApiError(`Groq returned no response stream for ${model}`, { model });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pendingLine = '';
    let eventData = [];
    let text = '';
    let truncated = false;

    async function dispatchEvent() {
        if (eventData.length === 0) return;
        const data = eventData.join('\n');
        eventData = [];
        if (data === '[DONE]') return;

        let event;
        try {
            event = JSON.parse(data);
        } catch {
            throw new GroqApiError(`Groq returned malformed streaming data for ${model}`, { model });
        }
        if (event.error) {
            throw new GroqApiError(`Groq stream error for ${model}: ${event.error.message || JSON.stringify(event.error)}`, { model });
        }
        if (event.choices?.[0]?.finish_reason === 'length') truncated = true;
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
            text += delta;
            if (onProgress) await raceWithAbort(onProgress(text), signal);
        }
    }

    async function consumeLine(line) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) return dispatchEvent();
        if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
    }

    const onAbort = () => {
        reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await raceWithAbort(reader.read(), signal);
            if (done) break;
            pendingLine += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = pendingLine.indexOf('\n')) !== -1) {
                await consumeLine(pendingLine.slice(0, newline));
                pendingLine = pendingLine.slice(newline + 1);
            }
        }
        pendingLine += decoder.decode();
        if (pendingLine) await consumeLine(pendingLine);
        await dispatchEvent();
    } finally {
        signal.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        } catch {
            /* Cancellation can leave a read pending briefly. */
        }
    }

    throwIfAborted(signal);
    if (!text.trim()) throw new GroqApiError(`Groq returned an empty answer from ${model}`, { model });
    return { text, truncated };
}

function createGroqClient({ now = Date.now, sleep = waitWithSignal, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let queue = Promise.resolve();
    let requests = [];
    let lastRequest = null;
    const modelCooldownUntil = new Map();

    async function acquireSlot(kind, model, tokens, signal, ensureActive, deadline) {
        while (true) {
            ensureActive();
            const time = now();
            requests = requests.filter(request => request.time + WINDOW_MS > time);
            const used = requests.reduce((total, request) => total + request.tokens, 0);
            const tokenWait = used + tokens > TOKEN_BUDGET ? requests[0].time + WINDOW_MS - time : 0;
            const gap = kind === 'image' || lastRequest?.kind === 'image' ? IMAGE_GAP_MS : TEXT_GAP_MS;
            const spacingWait = lastRequest ? lastRequest.time + gap - time : 0;
            const waitMs = Math.max(0, tokenWait, spacingWait, (modelCooldownUntil.get(model) || 0) - time);
            if (waitMs === 0) return;
            await raceWithAbort(sleep(Math.min(waitMs, deadline - time), signal), signal);
        }
    }

    function markRequestSent(kind, tokens) {
        const time = now();
        requests.push({ time, tokens });
        lastRequest = { time, kind };
    }

    function enqueue(task) {
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result;
    }

    async function requestGroqCompletion({
        apiKey,
        model,
        fallbackModel,
        messages,
        kind = 'text',
        maxCompletionTokens,
        disableThinking = false,
        onProgress,
        onRateLimits,
        fetchImpl = fetch,
        signal,
        timeoutMs = REQUEST_TIMEOUT_MS,
    }) {
        if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('Groq API key is required');
        if (typeof model !== 'string' || !model.trim()) throw new TypeError('Groq model is required');
        if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('Groq messages must be a non-empty array');
        if (kind !== 'text' && kind !== 'image') throw new TypeError('Groq kind must be text or image');
        if (maxCompletionTokens !== undefined && (kind !== 'text' || !Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 1))
            throw new TypeError('maxCompletionTokens must be a positive integer for text requests');
        if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
        if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
        if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean'))
            throw new TypeError('signal must be an AbortSignal');

        const completionTokens = kind === 'image' ? IMAGE_COMPLETION_TOKENS : maxCompletionTokens ?? TEXT_COMPLETION_TOKENS;
        const tokens = estimateRequestTokens(messages, completionTokens);
        if (tokens > TOKEN_BUDGET) {
            throw new GroqApiError(
                `Groq request is estimated at ${tokens} tokens, above the ${TOKEN_BUDGET}-token per-minute budget. Shorten the conversation history.`
            );
        }

        const controller = new AbortController();
        const deadline = now() + timeoutMs;
        const timeoutError = () => new GroqApiError(`Groq request timed out after ${timeoutMs} ms, including queue wait`, { code: 'timeout' });
        const onExternalAbort = () => controller.abort(abortReason(signal));
        if (signal?.aborted) onExternalAbort();
        else signal?.addEventListener('abort', onExternalAbort, { once: true });
        const timer = setTimer(() => controller.abort(timeoutError()), timeoutMs);
        const ensureActive = () => {
            if (now() >= deadline && !controller.signal.aborted) controller.abort(timeoutError());
            throwIfAborted(controller.signal);
        };

        const queued = enqueue(async () => {
            ensureActive();
            const fallback =
                typeof fallbackModel === 'string' && fallbackModel.trim() && fallbackModel.trim() !== model.trim() ? fallbackModel.trim() : null;
            const primary = model.trim();
            const firstModel =
                fallback && (modelCooldownUntil.get(primary) || 0) > now() && (modelCooldownUntil.get(fallback) || 0) <= now() ? fallback : primary;
            const candidates = firstModel === primary && fallback ? [primary, fallback] : [firstModel];

            for (let index = 0; index < candidates.length; index++) {
                const selectedModel = candidates[index];
                await acquireSlot(kind, selectedModel, tokens, controller.signal, ensureActive, deadline);
                ensureActive();
                markRequestSent(kind, tokens);

                const attemptController = new AbortController();
                const onRequestAbort = () => attemptController.abort(abortReason(controller.signal));
                controller.signal.addEventListener('abort', onRequestAbort, { once: true });
                const httpTimer = setTimer(
                    () =>
                        attemptController.abort(
                            new GroqApiError(`Groq HTTP request timed out after ${HTTP_TIMEOUT_MS} ms for ${selectedModel}`, {
                                code: 'timeout',
                                model: selectedModel,
                            })
                        ),
                    HTTP_TIMEOUT_MS
                );

                try {
                    let response;
                    try {
                        response = await raceWithAbort(
                            fetchImpl(GROQ_CHAT_URL, {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${apiKey.trim()}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    model: selectedModel,
                                    messages,
                                    stream: true,
                                    temperature: 0.7,
                                    max_completion_tokens: completionTokens,
                                    ...reasoningOptions(selectedModel, disableThinking),
                                }),
                                signal: attemptController.signal,
                            }),
                            attemptController.signal
                        );
                    } catch (error) {
                        if (attemptController.signal.aborted) throw abortReason(attemptController.signal);
                        throw new GroqApiError(`Could not reach Groq for ${selectedModel}: ${error.message}`, { model: selectedModel });
                    }

                    notifyGroqRateLimits(onRateLimits, response, { kind: 'chat', model: selectedModel, observedAt: now() });
                    ensureActive();
                    if (!response.ok) {
                        const error = await raceWithAbort(readApiError(response, selectedModel, now()), attemptController.signal);
                        if (error.status === 429) {
                            modelCooldownUntil.set(
                                selectedModel,
                                Math.max(modelCooldownUntil.get(selectedModel) || 0, now() + MODEL_COOLDOWN_MS, now() + (error.retryAfterMs || 0))
                            );
                        }
                        if (index + 1 < candidates.length && shouldFallback(error)) continue;
                        throw error;
                    }

                    const { text, truncated } = await readCompletion(response, selectedModel, onProgress, attemptController.signal);
                    ensureActive();
                    return truncated ? { text, model: selectedModel, truncated: true } : { text, model: selectedModel };
                } finally {
                    clearTimer(httpTimer);
                    controller.signal.removeEventListener('abort', onRequestAbort);
                }
            }
        });
        try {
            return await raceWithAbort(queued, controller.signal);
        } finally {
            clearTimer(timer);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }

    return { requestGroqCompletion };
}

const defaultClient = createGroqClient();

module.exports = {
    requestGroqCompletion: defaultClient.requestGroqCompletion,
    createGroqClient,
    GroqApiError,
};
