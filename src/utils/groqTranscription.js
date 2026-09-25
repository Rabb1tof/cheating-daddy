const { parseRetryAfterMs, notifyGroqRateLimits } = require('./groqRateLimits');

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const MIN_REQUEST_INTERVAL_MS = 10000;
const MAX_BATCH_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 20;
const MAX_PENDING_SEGMENTS = 2;
const REQUEST_TIMEOUT_MS = 20000;

function pcmToWavBuffer(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % BYTES_PER_SAMPLE !== 0) {
        throw new Error('Expected non-empty 16-bit mono PCM audio');
    }

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function rms(pcm) {
    let sum = 0;
    const sampleCount = pcm.length / BYTES_PER_SAMPLE;
    for (let i = 0; i < pcm.length; i += BYTES_PER_SAMPLE) {
        const sample = pcm.readInt16LE(i);
        sum += sample * sample;
    }
    return Math.sqrt(sum / sampleCount);
}

class SpeechSegmenter {
    constructor(options = {}) {
        this.threshold = options.threshold ?? 300;
        this.minSpeechMs = options.minSpeechMs ?? 300;
        this.endSilenceMs = options.endSilenceMs ?? 700;
        this.maxSegmentMs = options.maxSegmentMs ?? 20000;
        this.preRollMs = options.preRollMs ?? 200;
        this.reset();
    }

    reset() {
        this.preRoll = [];
        this.preRollDurationMs = 0;
        this.chunks = [];
        this.durationMs = 0;
        this.voicedMs = 0;
        this.silenceMs = 0;
        this.active = false;
    }

    push(pcm) {
        if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % BYTES_PER_SAMPLE !== 0) {
            throw new Error('Expected non-empty 16-bit mono PCM audio');
        }

        const durationMs = (pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
        const voiced = rms(pcm) >= this.threshold;

        if (!this.active) {
            if (!voiced) {
                this.preRoll.push({ pcm, durationMs });
                this.preRollDurationMs += durationMs;
                while (this.preRollDurationMs > this.preRollMs && this.preRoll.length > 1) {
                    this.preRollDurationMs -= this.preRoll.shift().durationMs;
                }
                return [];
            }

            this.active = true;
            this.chunks = this.preRoll.map(chunk => chunk.pcm);
            this.durationMs = this.preRollDurationMs;
            this.preRoll = [];
            this.preRollDurationMs = 0;
        }

        this.chunks.push(pcm);
        this.durationMs += durationMs;
        if (voiced) {
            this.voicedMs += durationMs;
            this.silenceMs = 0;
        } else {
            this.silenceMs += durationMs;
        }

        if (this.silenceMs >= this.endSilenceMs || this.durationMs >= this.maxSegmentMs) {
            const segment = this.flush();
            return segment ? [segment] : [];
        }
        return [];
    }

    flush() {
        const segment = this.active && this.voicedMs >= this.minSpeechMs ? Buffer.concat(this.chunks) : null;
        this.reset();
        return segment;
    }
}

async function transcribePcm(pcm, { apiKey, model, signal, onRateLimits, fetchImpl = fetch }) {
    const form = new FormData();
    form.append('file', new Blob([pcmToWavBuffer(pcm)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    // The response language is a separate user preference. Let Whisper detect
    // the spoken language, which may differ from the desired answer language.

    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    if (signal?.aborted) abortRequest();
    else signal?.addEventListener('abort', abortRequest, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: requestController.signal,
        });
        notifyGroqRateLimits(onRateLimits, response, { kind: 'speech', model, observedAt: Date.now() });
        if (!response.ok) {
            let message = `Groq transcription failed (${response.status})`;
            try {
                const error = await response.json();
                if (error?.error?.message) message += `: ${String(error.error.message).slice(0, 300)}`;
            } catch (_) {
                // The status code still gives the user a useful error if the body is not JSON.
            }
            const error = new Error(message);
            error.status = response.status;
            const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
            error.retryAfterMs = retryAfterMs > 0 ? retryAfterMs : 60000;
            throw error;
        }

        const result = await response.json();
        return typeof result.text === 'string' ? result.text.trim() : '';
    } catch (error) {
        if (timedOut) throw new Error('Groq transcription timed out after 20 seconds');
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortRequest);
    }
}

class GroqTranscriptionSession {
    constructor({
        apiKey,
        model,
        fallbackModel,
        onTranscript,
        onError,
        onTranscribing = () => {},
        onFallback = () => {},
        onRateLimits,
        transcribe = transcribePcm,
        requestIntervalMs = MIN_REQUEST_INTERVAL_MS,
    }) {
        this.apiKey = apiKey;
        this.model = model;
        this.fallbackModel = fallbackModel && fallbackModel !== model ? fallbackModel : null;
        this.onTranscript = onTranscript;
        this.onError = onError;
        this.onTranscribing = onTranscribing;
        this.onFallback = onFallback;
        this.onRateLimits = onRateLimits;
        this.transcribe = transcribe;
        this.requestIntervalMs = requestIntervalMs;
        this.segmenters = new Map();
        this.queue = [];
        this.processing = false;
        this.active = true;
        this.abortController = new AbortController();
        this.lastRequestAt = 0;
        this.pausedUntil = 0;
        this.overflowNotified = false;
        this.waitTimer = null;
        this.wakeWaiter = null;
    }

    push(source, pcm) {
        if (!this.active) return;
        if (Date.now() < this.pausedUntil) return;
        if (!this.segmenters.has(source)) this.segmenters.set(source, new SpeechSegmenter());
        for (const segment of this.segmenters.get(source).push(pcm)) {
            if (this.queue.length >= MAX_PENDING_SEGMENTS) {
                if (!this.overflowNotified) {
                    this.onError(new Error('Groq transcription is falling behind; an older audio segment was skipped'));
                    this.overflowNotified = true;
                }
                this.queue.shift();
            }
            this.queue.push(segment);
        }
        this.drain();
    }

    async wait(ms) {
        if (ms <= 0) return;
        await new Promise(resolve => {
            this.wakeWaiter = resolve;
            this.waitTimer = setTimeout(resolve, ms);
        });
        this.waitTimer = null;
        this.wakeWaiter = null;
    }

    async transcribeWithFallback(pcm) {
        const options = {
            apiKey: this.apiKey,
            model: this.model,
            signal: this.abortController.signal,
            onRateLimits: this.onRateLimits,
        };
        try {
            return await this.transcribe(pcm, options);
        } catch (error) {
            if (!this.fallbackModel || ![400, 403, 404, 429].includes(error.status)) throw error;

            // A model-specific 429 can recover on another model. Space the
            // fallback normally; only pause after the fallback is exhausted.
            await this.wait(this.requestIntervalMs);
            if (!this.active) return '';

            const fallbackModel = this.fallbackModel;
            this.lastRequestAt = Date.now();
            const transcript = await this.transcribe(pcm, { ...options, model: fallbackModel });
            this.model = fallbackModel;
            this.fallbackModel = null;
            this.pausedUntil = 0;
            this.onFallback(fallbackModel);
            return transcript;
        }
    }

    async drain() {
        if (this.processing || !this.active) return;
        this.processing = true;
        try {
            while (this.active && this.queue.length > 0) {
                const waitMs = Math.max(0, this.lastRequestAt + this.requestIntervalMs - Date.now());
                await this.wait(waitMs);
                if (!this.active) break;

                // Batch short utterances heard during the spacing interval into one request.
                const chunks = [this.queue.shift()];
                this.overflowNotified = false;
                let bytes = chunks[0].length;
                while (this.queue.length > 0 && bytes + this.queue[0].length <= MAX_BATCH_BYTES) {
                    const next = this.queue.shift();
                    chunks.push(next);
                    bytes += next.length;
                }
                const pcm = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
                this.lastRequestAt = Date.now();
                try {
                    this.onTranscribing();
                    const transcript = await this.transcribeWithFallback(pcm);
                    if (this.active && transcript) await this.onTranscript(transcript);
                } catch (error) {
                    if (this.active) {
                        if (error.status === 429) {
                            this.pausedUntil = Date.now() + error.retryAfterMs;
                            this.queue = [];
                            for (const segmenter of this.segmenters.values()) segmenter.reset();
                            this.onError(new Error(`${error.message}. Paused transcription for ${Math.ceil(error.retryAfterMs / 1000)} seconds`));
                        } else if ([400, 401, 403, 404].includes(error.status)) {
                            this.pausedUntil = Infinity;
                            this.queue = [];
                            this.onError(new Error(`${error.message}. Restart the session after correcting the Groq settings`));
                        } else {
                            this.onError(error);
                        }
                    }
                }
            }
        } finally {
            this.processing = false;
        }
    }

    close() {
        this.active = false;
        this.abortController.abort();
        if (this.waitTimer) clearTimeout(this.waitTimer);
        if (this.wakeWaiter) this.wakeWaiter();
        this.queue = [];
        this.segmenters.clear();
    }
}

module.exports = { SpeechSegmenter, GroqTranscriptionSession, pcmToWavBuffer, transcribePcm };
