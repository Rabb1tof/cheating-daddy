const { getApiKey, getGroqApiKey } = require('../storage');

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

async function readJson(response, provider) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = body.error?.message || body.message || response.statusText;
        throw new Error(`${provider} model list failed (${response.status}): ${String(detail).slice(0, 300)}`);
    }
    return body;
}

function groupGeminiModels(models) {
    const normalized = models
        .filter(model => typeof model.name === 'string' && model.name.startsWith('models/'))
        .map(model => ({ id: model.name.slice('models/'.length), name: model.displayName || model.name }));

    return {
        // Gemini's model catalog does not expose a reliable Live capability flag.
        // Keep this a suggestion list; the API validates compatibility at connect time.
        live: normalized.filter(model => /live/i.test(model.id) && !/transcrib|translat/i.test(model.id)),
        image: models
            .filter(
                model =>
                    typeof model.name === 'string' &&
                    model.name.startsWith('models/') &&
                    model.supportedGenerationMethods?.includes('generateContent')
            )
            .map(model => ({ id: model.name.slice('models/'.length), name: model.displayName || model.name })),
    };
}

function groupGroqModels(models) {
    const active = models.filter(model => model.active !== false && typeof model.id === 'string');
    const speech = active.filter(model => /whisper|transcrib/i.test(model.id));
    const chat = active.filter(model => !/whisper|transcrib|tts|speech|guard|embed/i.test(model.id));
    return {
        speech: speech.map(model => ({ id: model.id, name: model.id })),
        chat: chat.map(model => ({ id: model.id, name: model.id })),
        // Groq's models endpoint does not publish a vision capability field.
        // Show the available chat models and let the API report an incompatible ID.
        image: chat.map(model => ({ id: model.id, name: model.id })),
    };
}

async function listModels(provider, fetchImpl = fetch, credentials = { gemini: getApiKey(), groq: getGroqApiKey() }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        if (provider === 'gemini') {
            const key = credentials.gemini;
            if (!key) throw new Error('Add a Gemini API key first');
            const models = [];
            let nextPageToken = '';
            do {
                const url = new URL(GEMINI_MODELS_URL);
                url.searchParams.set('pageSize', '1000');
                if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
                const response = await fetchImpl(url, { headers: { 'x-goog-api-key': key }, signal: controller.signal });
                const body = await readJson(response, 'Gemini');
                models.push(...(body.models || []));
                nextPageToken = body.nextPageToken || '';
            } while (nextPageToken);
            return groupGeminiModels(models);
        }

        if (provider === 'groq') {
            const key = credentials.groq;
            if (!key) throw new Error('Add a Groq API key first');
            const response = await fetchImpl(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
            const body = await readJson(response, 'Groq');
            return groupGroqModels(body.data || []);
        }
        throw new Error('Unknown model provider');
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { listModels, groupGeminiModels, groupGroqModels };
