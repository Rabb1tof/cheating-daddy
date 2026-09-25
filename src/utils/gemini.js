const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt, getCompactSystemPrompt } = require('./prompts');
const { getApiKey, getGroqApiKey, incrementCharUsage, getConfig, getPreferences } = require('../storage');
const { GroqTranscriptionSession } = require('./groqTranscription');
const { resample24kTo16k } = require('./pcm');
const { listModels } = require('./modelCatalog');
const { requestGroqCompletion } = require('./groqClient');
const { getGroqLimitsGeneration, recordGroqLimits } = require('./providerLimits');
const { trackLiveTransport, connectWithSetupGuard } = require('./liveSetupGuard');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let currentResponseLanguage = 'en-US';
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';
let groqTranscriptionSession = null;
let groqAudioMode = 'speaker_only';
let groqTextModelOverride = null;
let groqRequestController = new AbortController();
let geminiTranscriptionFlushTimer = null;

function cancelGroqRequests() {
    groqRequestController.abort();
    groqRequestController = new AbortController();
    if (geminiTranscriptionFlushTimer) clearTimeout(geminiTranscriptionFlushTimer);
    geminiTranscriptionFlushTimer = null;
}

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
let geminiReconnectBlockedReason = null;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;
const GEMINI_LIVE_SETUP_TIMEOUT_MS = 15000;

function isNonRetryableGeminiError(error) {
    const detail = [error?.message, error?.reason, error?.code, error?.status].filter(Boolean).join(' ').toLowerCase();
    return /\b(401|403|404|429|1008)\b|quota|resource.?exhausted|rate.?limit|permission|unauthori[sz]ed|api.?key|model.?not.?found|model.?unavailable|invalid.?model|free.?tier/.test(
        detail
    );
}

function safeGeminiErrorText(error, apiKey) {
    const detail = error?.message || error?.reason || (error?.code ? `code ${error.code}` : 'Unknown error');
    let text = String(detail);
    if (apiKey) text = text.split(apiKey).join('[redacted]');
    return text
        .replace(/([?&](?:key|api_key|apiKey)=)[^\s&]+/gi, '$1[redacted]')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]')
        .slice(0, 500);
}

function geminiErrorStatus(error) {
    const status = String(error?.status || error?.code || '');
    return /^[\w-]{1,32}$/.test(status) ? status : null;
}

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    cancelGroqRequests();
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    currentTranscription = '';
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];
    if (getPreferences().googleSearchEnabled === true) {
        tools.push({ googleSearch: {} });
    }
    return tools;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}

function observeGroqLimitsForKey(apiKey) {
    const generation = getGroqLimitsGeneration();
    return observation => {
        // Requests already in flight may finish after the user changes keys.
        if (getGroqApiKey()?.trim() === apiKey) recordGroqLimits(observation, generation);
    };
}

function feedGroqAudio(source, pcm) {
    if (!groqTranscriptionSession) return false;
    if (groqAudioMode === 'mic_only' && source === 'system') return true;
    if (groqAudioMode === 'speaker_only' && source === 'mic') return true;
    groqTranscriptionSession.push(source, pcm);
    return true;
}

function receiveGroqAudio(source, data, mimeType) {
    if (mimeType !== 'audio/pcm;rate=24000' || typeof data !== 'string') {
        throw new Error('Groq transcription expects 24 kHz mono PCM audio');
    }
    const pcm = Buffer.from(data, 'base64');
    if (pcm.length === 0 || pcm.length > 24000 * 2 * 2 || pcm.length % 2 !== 0) {
        throw new Error('Invalid PCM audio chunk');
    }
    feedGroqAudio(source, pcm);
}

async function initializeGroqTranscriptionSession(profile = 'interview', customPrompt = '', language = 'en-US') {
    const apiKey = getGroqApiKey()?.trim();
    const config = getConfig();
    const primarySpeechModel = config.groqSpeechModel?.trim();
    const fallbackSpeechModel = config.groqSpeechFallbackModel?.trim();
    const primaryTextModel = config.groqModel?.trim();
    const fallbackTextModel = config.groqFallbackModel?.trim();
    if (!apiKey || !primarySpeechModel || !primaryTextModel) {
        throw new Error('Groq API key, speech model, and text model are required');
    }

    const warnings = [];
    let available = null;
    try {
        available = await listModels('groq', fetch, { groq: apiKey });
    } catch (error) {
        if (/\((401|403)\)/.test(error.message)) throw error;
        warnings.push(`Groq model catalog could not be checked: ${error.message}. Configured IDs will be tried when used.`);
    }
    const speechIds = new Set(available?.speech.map(model => model.id) || []);
    const textIds = new Set(available?.chat.map(model => model.id) || []);
    // /models lists suggestions, but its capability grouping is heuristic. A typed ID
    // can still work at inference time, so warn instead of blocking the session.
    if (available && !speechIds.has(primarySpeechModel))
        warnings.push(`Speech model "${primarySpeechModel}" is absent from the current catalog; Groq will validate it on first use.`);
    if (available && !textIds.has(primaryTextModel))
        warnings.push(`Text model "${primaryTextModel}" is absent from the current catalog; Groq will validate it on first use.`);
    if (available && fallbackSpeechModel && !speechIds.has(fallbackSpeechModel))
        warnings.push(`Speech fallback "${fallbackSpeechModel}" is absent from the current catalog.`);
    if (available && fallbackTextModel && !textIds.has(fallbackTextModel))
        warnings.push(`Text fallback "${fallbackTextModel}" is absent from the current catalog.`);

    groqTextModelOverride = null;

    groqTranscriptionSession?.close();
    currentProviderMode = 'byok';
    sessionParams = null;
    isUserClosing = false;
    groqAudioMode = getPreferences().audioMode || 'speaker_only';
    currentResponseLanguage = language;
    currentSystemPrompt = getSystemPrompt(profile, customPrompt, false, language);
    initializeNewSession(profile, customPrompt);

    groqTranscriptionSession = new GroqTranscriptionSession({
        apiKey,
        model: primarySpeechModel,
        fallbackModel: fallbackSpeechModel,
        onRateLimits: observeGroqLimitsForKey(apiKey),
        onTranscribing: () => sendToRenderer('update-status', 'Transcribing...'),
        onTranscript: async transcript => {
            sendToRenderer('update-status', 'Generating response...');
            const result = await sendToGroq(transcript);
            if (!result.success && [400, 401, 403, 404, 429].includes(result.status)) {
                const error = new Error(result.error);
                error.status = result.status;
                error.retryAfterMs = result.retryAfterMs || 60000;
                throw error;
            }
            return result;
        },
        onError: error => {
            console.error('Groq transcription error:', error);
            sendToRenderer('update-status', `Groq transcription error: ${error.message}`);
        },
        onFallback: fallback => sendToRenderer('update-status', `Using Groq speech fallback: ${fallback}`),
    });
    sendToRenderer('update-status', 'Listening...');
    return { success: true, warning: warnings.join(' ') };
}

function sendFinalTranscriptionToGroq() {
    const transcription = currentTranscription.trim();
    currentTranscription = '';
    if (hasGroqKey() && transcription) void sendToGroq(transcription);
}

function scheduleFinalTranscriptionToGroq() {
    if (!hasGroqKey()) return;
    if (geminiTranscriptionFlushTimer) clearTimeout(geminiTranscriptionFlushTimer);
    // Gemini may emit final input transcription just after turnComplete.
    geminiTranscriptionFlushTimer = setTimeout(() => {
        geminiTranscriptionFlushTimer = null;
        sendFinalTranscriptionToGroq();
    }, 350);
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function groqSystemPrompt() {
    return getCompactSystemPrompt(currentProfile, currentCustomPrompt, currentResponseLanguage);
}

function groqTextMessages(transcription) {
    return [
        { role: 'system', content: groqSystemPrompt() },
        ...groqConversationHistory.slice(-4).map(({ role, content }) => ({ role, content: content.slice(0, 900) })),
        { role: 'user', content: transcription.slice(0, 1800) },
    ];
}

function displayGroqProgress(signal) {
    let shown = false;
    return {
        update(text) {
            if (signal.aborted) return;
            const visible = stripThinkingTags(text);
            if (!visible) return;
            sendToRenderer(shown ? 'update-response' : 'new-response', visible);
            shown = true;
        },
        finish(text) {
            const visible = stripThinkingTags(text);
            if (visible) sendToRenderer(shown ? 'update-response' : 'new-response', visible);
            return visible;
        },
    };
}

async function sendToGroq(transcription) {
    const apiKey = getGroqApiKey()?.trim();
    const input = typeof transcription === 'string' ? transcription.trim() : '';
    if (!apiKey) return { success: false, error: 'Groq API key is required', status: 401 };
    if (!input) return { success: false, error: 'Empty text message' };

    const config = getConfig();
    const primaryModel = groqTextModelOverride || config.groqModel?.trim();
    if (!primaryModel) return { success: false, error: 'Choose a Groq text model in settings', status: 400 };
    const signal = groqRequestController.signal;
    const messages = groqTextMessages(input);
    const display = displayGroqProgress(signal);
    logTransportEvent('groq.text.request', { model: primaryModel, transcription: input });
    sendToRenderer('update-status', 'Generating response...');

    try {
        const result = await requestGroqCompletion({
            apiKey,
            model: primaryModel,
            fallbackModel: config.groqFallbackModel?.trim(),
            messages,
            kind: 'text',
            disableThinking: config.disableGroqThinking === true,
            signal,
            onProgress: text => display.update(text),
            onRateLimits: observeGroqLimitsForKey(apiKey),
        });
        if (signal.aborted) return { success: false, error: 'Session closed' };
        const answer = display.finish(result.text);
        if (!answer) throw new Error(`Groq returned no visible answer (${result.model})`);
        const displayedAnswer = result.truncated ? `${answer}\n\n[Answer reached the 512-token limit. Ask a narrower question to continue.]` : answer;
        if (result.truncated) sendToRenderer('update-response', displayedAnswer);

        groqTextModelOverride = result.model === config.groqModel?.trim() ? null : result.model;
        groqConversationHistory.push({ role: 'user', content: input.slice(0, 1800) }, { role: 'assistant', content: answer.slice(0, 1800) });
        groqConversationHistory = groqConversationHistory.slice(-6);
        const inputChars = messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0);
        incrementCharUsage('groq', result.model, inputChars + answer.length);
        saveConversationTurn(input, displayedAnswer);
        logTransportEvent('groq.text.completed', { model: result.model, response: answer });
        const warning = result.truncated
            ? 'Groq answer reached the 512-token limit'
            : result.model !== config.groqModel?.trim()
              ? `Using Groq text fallback: ${result.model}`
              : '';
        sendToRenderer('update-status', warning || 'Listening...');
        return { success: true, text: displayedAnswer, model: result.model, warning, truncated: result.truncated === true };
    } catch (error) {
        if (signal.aborted) return { success: false, error: 'Session closed' };
        console.error('Error calling Groq API:', error);
        logTransportEvent('groq.text.error', { error: error.message });
        sendToRenderer('update-status', `Groq error: ${error.message}`);
        return { success: false, error: error.message, status: error.status, retryAfterMs: error.retryAfterMs };
    }
}

async function sendImageToGroq(base64Data, prompt) {
    const apiKey = getGroqApiKey()?.trim();
    const model = getConfig().groqImageModel?.trim();
    if (!apiKey) return { success: false, error: 'Groq API key is required for screenshots' };
    if (!model) return { success: false, error: 'Choose a Groq screenshot model in settings' };
    const signal = groqRequestController.signal;
    const input = String(prompt || '').slice(0, 1200);
    const display = displayGroqProgress(signal);
    const messages = [
        { role: 'system', content: groqSystemPrompt() },
        {
            role: 'user',
            content: [
                { type: 'text', text: input },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
            ],
        },
    ];
    logTransportEvent('groq.image.request', { model, prompt: input, imageBytes: Buffer.byteLength(base64Data, 'base64') });

    try {
        const result = await requestGroqCompletion({
            apiKey,
            model,
            messages,
            kind: 'image',
            disableThinking: getConfig().disableGroqThinking === true,
            signal,
            onProgress: text => display.update(text),
            onRateLimits: observeGroqLimitsForKey(apiKey),
        });
        if (signal.aborted) return { success: false, error: 'Session closed' };
        const answer = display.finish(result.text);
        if (!answer) throw new Error(`Groq returned no visible screenshot answer (${result.model})`);
        const displayedAnswer = result.truncated
            ? `${answer}\n\n[Answer reached the 1024-token limit. Ask about a smaller part of the screenshot to continue.]`
            : answer;
        if (result.truncated) sendToRenderer('update-response', displayedAnswer);
        incrementCharUsage('groq', result.model, messages[0].content.length + input.length + answer.length);
        saveScreenAnalysis(input, displayedAnswer, result.model);
        logTransportEvent('groq.image.completed', { model: result.model, response: answer });
        return { success: true, text: displayedAnswer, model: result.model, truncated: result.truncated === true };
    } catch (error) {
        if (signal.aborted) return { success: false, error: 'Session closed' };
        console.error('Error calling Groq image API:', error);
        logTransportEvent('groq.image.error', { error: error.message });
        sendToRenderer('update-status', `Groq screenshot error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const response = await ai.models.generateContentStream({
            model: 'gemma-4-26b-a4b-it',
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemma-4-26b-a4b-it', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
        geminiReconnectBlockedReason = null;
    }

    try {
        // Open the transport log before setup so failures before connect are recorded too.
        if (!isReconnect) initializeNewSession(profile, customPrompt);

        const client = new GoogleGenAI({
            vertexai: false,
            apiKey: apiKey,
            httpOptions: { apiVersion: 'v1beta' },
        });
        const closeTransport = trackLiveTransport(client);

        // Get enabled tools first to determine Google Search status
        const enabledTools = await getEnabledTools();
        const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

        const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled, language);
        currentSystemPrompt = systemPrompt; // Store for Groq
        currentResponseLanguage = language;

        const session = await connectWithSetupGuard(
            guard =>
                client.live.connect({
                    model: getConfig().geminiLiveModel,
                    callbacks: {
                        onopen: function () {
                            if (guard.isAbandoned()) return;
                            logTransportEvent('gemini.live.opened', {});
                        },
                        onmessage: function (message) {
                            if (guard.isAbandoned()) return;
                            console.log('----------------', message);
                            logTransportEvent('gemini.live.message', message);

                            // Handle input transcription (what was spoken)
                            if (message.serverContent?.inputTranscription?.results) {
                                currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                            } else if (message.serverContent?.inputTranscription?.text) {
                                const text = message.serverContent.inputTranscription.text;
                                if (text.trim() !== '') {
                                    currentTranscription += text;
                                }
                            }

                            if (message.serverContent?.inputTranscription && geminiTranscriptionFlushTimer) scheduleFinalTranscriptionToGroq();

                            if (!hasGroqKey() && message.serverContent?.outputTranscription?.text) {
                                const isFirstChunk = messageBuffer === '';
                                messageBuffer += message.serverContent.outputTranscription.text;
                                sendToRenderer(isFirstChunk ? 'new-response' : 'update-response', messageBuffer);
                            }

                            if (message.serverContent?.generationComplete) {
                                if (currentTranscription.trim() !== '') {
                                    if (!hasGroqKey() && messageBuffer.trim() !== '') {
                                        saveConversationTurn(currentTranscription, messageBuffer);
                                    }
                                    if (hasGroqKey()) scheduleFinalTranscriptionToGroq();
                                    else currentTranscription = '';
                                }
                                messageBuffer = '';
                            }

                            if (message.serverContent?.turnComplete) {
                                if (hasGroqKey()) scheduleFinalTranscriptionToGroq();
                                else currentTranscription = '';
                                messageBuffer = '';
                                sendToRenderer('update-status', 'Listening...');
                            }
                        },
                        onerror: function (e) {
                            const reason = safeGeminiErrorText(e, apiKey);
                            console.log('Session error:', reason);
                            if (guard.isAbandoned()) return;
                            if (isNonRetryableGeminiError(e)) geminiReconnectBlockedReason = reason;
                            logTransportEvent('gemini.live.error', {
                                status: geminiErrorStatus(e),
                                error: reason,
                            });
                            sendToRenderer('update-status', 'Gemini Live error: ' + reason);
                            if (guard.isWaiting()) {
                                const setupError = new Error(reason);
                                setupError.code = e?.code;
                                guard.fail(setupError);
                            }
                        },
                        onclose: function (e) {
                            const closeReason = safeGeminiErrorText(e, apiKey);
                            console.log('Session closed:', closeReason);
                            if (guard.isAbandoned()) return;
                            logTransportEvent('gemini.live.closed', {
                                status: geminiErrorStatus(e),
                                reason: closeReason,
                            });

                            // Don't reconnect if user intentionally closed
                            if (isUserClosing) {
                                isUserClosing = false;
                                closeTransportLog();
                                sendToRenderer('update-status', 'Session closed');
                                if (guard.isWaiting()) guard.fail(new Error('Session closed'));
                                return;
                            }

                            if (guard.isWaiting()) {
                                const setupError = new Error(closeReason);
                                setupError.code = e?.code;
                                guard.fail(setupError);
                                return;
                            }

                            if (isNonRetryableGeminiError(e) || geminiReconnectBlockedReason) {
                                const reason = geminiReconnectBlockedReason || closeReason;
                                sessionParams = null;
                                closeTransportLog();
                                sendToRenderer('update-status', `Gemini Live stopped: ${reason}`);
                                return;
                            }

                            // Attempt reconnection
                            if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                attemptReconnect();
                            } else {
                                closeTransportLog();
                                sendToRenderer('update-status', 'Session closed');
                            }
                        },
                    },
                    config: {
                        responseModalities: [Modality.AUDIO],
                        outputAudioTranscription: {},
                        tools: enabledTools,
                        inputAudioTranscription: {},
                        contextWindowCompression: { slidingWindow: {} },
                        systemInstruction: {
                            parts: [{ text: systemPrompt }],
                        },
                    },
                }),
            closeTransport,
            GEMINI_LIVE_SETUP_TIMEOUT_MS
        );

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        sendToRenderer('update-status', 'Live session connected');
        return session;
    } catch (error) {
        const reason = safeGeminiErrorText(error, apiKey);
        console.error('Failed to initialize Gemini session:', reason);
        logTransportEvent('gemini.live.connect.failed', { status: geminiErrorStatus(error), reason });
        if (isNonRetryableGeminiError(error)) geminiReconnectBlockedReason = reason;
        sendToRenderer('update-status', `Gemini Live connection failed: ${reason}`);
        isInitializingSession = false;
        if (!isReconnect) {
            sessionParams = null;
            closeTransportLog();
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    if (!sessionParams || geminiReconnectBlockedReason || isUserClosing) return false;
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers
    messageBuffer = '';
    currentTranscription = '';
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    if (!sessionParams || geminiReconnectBlockedReason || isUserClosing) return false;

    try {
        const session = await initializeGeminiSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true // isReconnect
        );

        if (geminiReconnectBlockedReason) {
            sessionParams = null;
            sendToRenderer('update-status', `Gemini Live stopped: ${geminiReconnectBlockedReason}`);
            return false;
        }

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else if (groqTranscriptionSession) {
                feedGroqAudio('system', monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: resample24kTo16k(Buffer.from(base64Data, 'base64')).toString('base64'),
                mimeType: 'audio/pcm;rate=16000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    const model = getConfig().geminiImageModel?.trim();
    if (!model) return { success: false, error: 'Choose a Gemini screenshot model in settings' };

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const language = getPreferences().selectedLanguage || 'en-US';
        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: `${prompt}\nAnswer in ${language}.` },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Stream the response
        let fullText = '';
        let isFirst = true;
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                // Send to renderer - new response for first chunk, update for subsequent
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        groqTranscriptionSession?.close();
        groqTranscriptionSession = null;
        groqTextModelOverride = null;
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-groq', async (event, profile = 'interview', customPrompt = '', language = 'en-US') => {
        sendToRenderer('session-initializing', true);
        try {
            geminiSessionRef.current = null;
            return await initializeGroqTranscriptionSession(profile, customPrompt, language);
        } catch (error) {
            console.error('Failed to initialize Groq transcription:', error);
            sendToRenderer('update-status', `Groq initialization error: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            sendToRenderer('session-initializing', false);
        }
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt, language = 'en-US') => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt, language);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled) {
            currentProviderMode = 'byok';
        }
        return cancelled;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (groqTranscriptionSession) {
            try {
                receiveGroqAudio('system', data, mimeType);
                return { success: true };
            } catch (error) {
                console.error('Error receiving Groq system audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: resample24kTo16k(Buffer.from(data, 'base64')).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (groqTranscriptionSession) {
            try {
                receiveGroqAudio('mic', data, mimeType);
                return { success: true };
            } catch (error) {
                console.error('Error receiving Groq microphone audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: resample24kTo16k(Buffer.from(data, 'base64')).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            const config = getConfig();
            const provider =
                config.screenshotProvider === 'groq' || config.screenshotProvider === 'gemini'
                    ? config.screenshotProvider
                    : config.transcriptionProvider === 'groq'
                      ? 'groq'
                      : 'gemini';
            if (provider === 'groq') {
                if (!hasGroqKey()) return { success: false, error: 'Groq API key is required for screenshots' };
                return await sendImageToGroq(data, prompt);
            }
            if (!getApiKey()?.trim()) return { success: false, error: 'Gemini API key is required for screenshots' };
            return await sendImageToGeminiHttp(data, prompt);
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Llama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (groqTranscriptionSession) {
            return await sendToGroq(text.trim());
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            if (hasGroqKey()) {
                return await sendToGroq(text.trim());
            }

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();
            cancelGroqRequests();
            geminiReconnectBlockedReason = null;

            if (groqTranscriptionSession) {
                groqTranscriptionSession.close();
                groqTranscriptionSession = null;
                groqTextModelOverride = null;
                closeTransportLog();
                return { success: true };
            }

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            } else {
                closeTransportLog();
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
