const fs = require('fs');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { getPreferences } = require('../storage');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const { createResponseStream } = require('./responseStream');
const {
    ensureNativeBinary,
    ensureLlamaModel,
    ensureWhisperModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
} = require('./native-ai-runtime');

let llamaProcess = null;
let llamaBaseUrl = null;
let llamaModel = null;
let whisperProcess = null;
let whisperBaseUrl = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let currentWhisperLanguage = 'en';
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();
let completionController = null;
let completionQueue = Promise.resolve();
let interruptLocalOnNewRequest = false;
let rememberLocalRecentAnswers = true;
const pendingCompletionControllers = new Set();
const LOCAL_HISTORY_TURNS = 3;
const LOCAL_HISTORY_QUESTION_BYTES = 240;
const LOCAL_HISTORY_ANSWER_BYTES = 360;

let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;

const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};

let vadConfig = VAD_MODES.VERY_AGGRESSIVE;
let resampleRemainder = Buffer.alloc(0);

function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function processVad(pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount += 1;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount += 1;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            console.log('[LocalAI] Speech ended, accumulated', audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing...');
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
    }
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

async function transcribeAudio(pcm16kBuffer) {
    if (!whisperBaseUrl) {
        throw new Error('Whisper server is not running');
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    formData.append('language', currentWhisperLanguage);

    const response = await fetch(`${whisperBaseUrl}/inference`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Whisper server returned HTTP ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    console.log('[LocalAI] Transcription:', text);
    return text;
}

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;
    const sessionController = completionController;

    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const transcription = await transcribeAudio(audioData);
        if (!isLocalActive || sessionController !== completionController || sessionController?.signal.aborted) return;

        if (!transcription || transcription.length < 2) {
            console.log('[LocalAI] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        sendToRenderer('update-status', 'Generating response...');
        await sendToLlama(transcription);
    } catch (error) {
        if (error.message === 'Interrupted by a new request') return;
        console.error('[LocalAI] Transcription error:', error);
        if (isLocalActive && sessionController === completionController && !sessionController?.signal.aborted) {
            sendToRenderer('update-status', 'Transcription error: ' + error.message);
        }
    }
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const event = JSON.parse(data);
            const token = event.choices?.[0]?.delta?.content || '';
            if (!token) continue;

            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

function enqueueCompletion(task) {
    const sessionController = completionController;
    if (interruptLocalOnNewRequest) {
        for (const previous of pendingCompletionControllers) previous.abort(new Error('Interrupted by a new request'));
    }
    const requestController = new AbortController();
    const onSessionClosed = () => requestController.abort(new Error('Local session closed'));
    if (sessionController?.signal.aborted) onSessionClosed();
    else sessionController?.signal.addEventListener('abort', onSessionClosed, { once: true });
    pendingCompletionControllers.add(requestController);
    const pending = completionQueue.then(async () => {
        if (!isLocalActive || sessionController !== completionController || requestController.signal.aborted) {
            throw requestController.signal.reason || new Error('Local session closed');
        }
        try {
            return await task(requestController.signal);
        } catch (error) {
            if (requestController.signal.aborted) throw requestController.signal.reason || error;
            throw error;
        }
    }).finally(() => {
        pendingCompletionControllers.delete(requestController);
        sessionController?.signal.removeEventListener('abort', onSessionClosed);
    });
    completionQueue = pending.catch(() => {});
    return pending;
}

function clipHistoryText(value, maxBytes) {
    const text = String(value || '');
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    const suffix = '…';
    const contentLimit = maxBytes - Buffer.byteLength(suffix, 'utf8');
    let clipped = '';
    let bytes = 0;
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > contentLimit) break;
        clipped += character;
        bytes += characterBytes;
    }
    return clipped.trimEnd() + suffix;
}

function recentLocalTurns() {
    if (!rememberLocalRecentAnswers) return [];
    // Only completed turns are stored. Three pairs use at most 1,800 UTF-8 bytes,
    // leaving room in llama.cpp's 8,192-token window for the current input and output.
    return localConversationHistory.slice(-LOCAL_HISTORY_TURNS * 2).map(message => ({
        role: message.role,
        content: clipHistoryText(message.content, message.role === 'assistant' ? LOCAL_HISTORY_ANSWER_BYTES : LOCAL_HISTORY_QUESTION_BYTES),
    }));
}

async function requestLlama(messages, onText, signal) {
    if (!llamaBaseUrl) {
        throw new Error('Llama server is not running');
    }

    const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
            model: 'local',
            messages,
            stream: true,
            max_tokens: 2048,
            chat_template_kwargs: {
                enable_thinking: false,
            },
        }),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`Llama server returned HTTP ${response.status}: ${errorText}`);
    }

    const text = await readStreamingResponse(response, onText);
    if (signal.aborted) throw new Error('Local session closed');
    return text;
}

async function sendToLlama(transcription) {
    const sessionController = completionController;
    try {
        return await enqueueCompletion(async signal => {
            const userMessage = { role: 'user', content: transcription.trim() };
            const recentTurns = recentLocalTurns();
            const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...recentTurns, userMessage];
            const stream = createResponseStream(sendToRenderer);
            const fullText = await requestLlama(messages, text => {
                if (!signal.aborted) stream.update(text);
            }, signal);

            if (fullText.trim()) {
                localConversationHistory.push(userMessage, { role: 'assistant', content: fullText.trim() });
                localConversationHistory = localConversationHistory.slice(-20);
                saveConversationTurn(transcription, fullText);
            }

            console.log('[LocalAI] Llama response completed');
            sendToRenderer('update-status', 'Listening...');
            return fullText;
        });
    } catch (error) {
        if (error.message === 'Interrupted by a new request') throw error;
        console.error('[LocalAI] Llama error:', error);
        if (isLocalActive && sessionController === completionController && !sessionController?.signal.aborted) {
            sendToRenderer('update-status', 'Local AI error: ' + error.message);
        }
        throw error;
    }
}

function formatDownloadStatus(label, progress) {
    if (!progress.expectedBytes) {
        return `Downloading ${label}...`;
    }

    const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
    return `Downloading ${label}... ${percentage}%`;
}

function sendDownloadProgress(label, progress = null) {
    const percentage = progress?.expectedBytes ? Math.min(100, Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100)) : null;
    sendToRenderer('local-ai-download-progress', {
        active: true,
        label,
        percentage,
    });
}

function getDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Set();
    }

    const entries = new Set();
    const visit = currentPath => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            entries.add(entryPath);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
        }
    };

    visit(directoryPath);
    return entries;
}

function removeNewLlamaCacheEntries() {
    const cacheDirectory = path.join(getModelsDirectory(), 'llama');
    const currentEntries = Array.from(getDirectoryEntries(cacheDirectory));
    currentEntries.sort((first, second) => second.length - first.length);

    for (const entryPath of currentEntries) {
        if (!llamaCacheSnapshot.has(entryPath)) {
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    }
}

async function prepareNativeFiles(llamaModelReference, whisperModel, signal) {
    const binaryProgress = label => progress => {
        sendToRenderer('update-status', formatDownloadStatus(label, progress));
        sendDownloadProgress(label, progress);
    };

    sendDownloadProgress('Checking Llama runner');
    const llamaBinaryPath = await ensureNativeBinary('llama', binaryProgress('Llama runner'), signal);

    sendDownloadProgress('Checking Whisper runner');
    const whisperBinaryPath = await ensureNativeBinary('whisper', binaryProgress('Whisper runner'), signal);

    let whisperModelPath;
    sendToRenderer('whisper-downloading', true);
    try {
        sendDownloadProgress('Checking Whisper model');
        whisperModelPath = await ensureWhisperModel(whisperModel, binaryProgress('Whisper model'), signal);
    } finally {
        sendToRenderer('whisper-downloading', false);
    }

    sendDownloadProgress('Checking language model');
    const llamaFiles = await ensureLlamaModel(llamaModelReference, binaryProgress('Language model'), binaryProgress('Vision model'), signal);
    return {
        llamaBinaryPath,
        whisperBinaryPath,
        whisperModelPath,
        llamaModelPath: llamaFiles.modelPath,
        projectorPath: llamaFiles.projectorPath,
    };
}

function validatePreparedNativeFiles(nativeFiles) {
    const requiredFiles = [
        ['Llama runner', nativeFiles.llamaBinaryPath],
        ['Whisper runner', nativeFiles.whisperBinaryPath],
        ['Whisper model', nativeFiles.whisperModelPath],
        ['Language model', nativeFiles.llamaModelPath],
        ['Vision model', nativeFiles.projectorPath],
    ];

    for (const [label, filePath] of requiredFiles) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} path is invalid: ${filePath}`);
        }
    }
}

async function startWhisperServer(executablePath, modelPath) {
    const port = await getAvailablePort();
    whisperBaseUrl = `http://127.0.0.1:${port}`;
    whisperProcess = startNativeServer({
        executablePath,
        arguments: ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port)],
        name: 'Whisper',
    });

    await waitForServer(`${whisperBaseUrl}/`, whisperProcess, 120000);
}

async function startLlamaServer(executablePath, modelPath, projectorPath) {
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error(`Language model path is invalid: ${modelPath}`);
    }
    if (!projectorPath || !fs.existsSync(projectorPath)) {
        throw new Error(`Vision model path is invalid: ${projectorPath}`);
    }

    const port = await getAvailablePort();
    const argumentsList = [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--alias',
        'local',
        '-c',
        '8192',
        '-m',
        modelPath,
        '--mmproj',
        projectorPath,
    ];

    if (process.platform === 'darwin') {
        argumentsList.push('-ngl', '99');
    }

    llamaBaseUrl = `http://127.0.0.1:${port}`;
    llamaProcess = startNativeServer({
        executablePath,
        arguments: argumentsList,
        name: 'Llama',
    });

    await waitForServer(`${llamaBaseUrl}/health`, llamaProcess, 30 * 60 * 1000);
}

async function initializeLocalSession(model, whisperModel, profile, customPrompt, language = 'en-US') {
    console.log('[LocalAI] Initializing native local session:', { model, whisperModel, profile });
    sendToRenderer('session-initializing', true);

    try {
        closeLocalSession();
        const selectedLanguage = typeof language === 'string' && /^[a-z]{2,3}-[A-Z]{2}$/.test(language) ? language : 'en-US';
        currentWhisperLanguage = selectedLanguage.startsWith('cmn-') ? 'zh' : selectedLanguage.split('-')[0];
        const effectiveWhisperModel =
            currentWhisperLanguage !== 'en' && typeof whisperModel === 'string' && whisperModel.endsWith('.en')
                ? whisperModel.slice(0, -3)
                : whisperModel;
        initializationController = new AbortController();
        llamaCacheSnapshot = getDirectoryEntries(path.join(getModelsDirectory(), 'llama'));
        const responseStyle = getPreferences().responseStyle === 'detailed' ? 'detailed' : 'concise';
        interruptLocalOnNewRequest = getPreferences().interruptOnNewRequest === true;
        rememberLocalRecentAnswers = getPreferences().rememberRecentAnswers !== false;
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false, selectedLanguage, responseStyle);
        llamaModel = model;

        const nativeFiles = await prepareNativeFiles(model, effectiveWhisperModel, initializationController.signal);
        validatePreparedNativeFiles(nativeFiles);

        sendToRenderer('update-status', 'Starting Whisper...');
        sendDownloadProgress('Starting Whisper');
        await startWhisperServer(nativeFiles.whisperBinaryPath, nativeFiles.whisperModelPath);

        sendToRenderer('update-status', 'Loading local language model...');
        sendDownloadProgress('Loading language model');
        await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, nativeFiles.projectorPath);

        isSpeaking = false;
        speechBuffers = [];
        silenceFrameCount = 0;
        speechFrameCount = 0;
        resampleRemainder = Buffer.alloc(0);
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        completionController = new AbortController();
        completionQueue = Promise.resolve();
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');
        console.log('[LocalAI] Native session initialized successfully');
        return true;
    } catch (error) {
        const wasCancelled = error.name === 'AbortError' || initializationController?.signal.aborted;
        if (wasCancelled) {
            console.log('[LocalAI] Initialization cancelled');
        } else {
            console.error('[LocalAI] Initialization error:', error);
        }
        closeLocalSession();
        if (wasCancelled) {
            removeNewLlamaCacheEntries();
        }
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', wasCancelled ? 'Local AI download cancelled' : 'Local AI error: ' + error.message);
        return false;
    }
}

function processLocalAudio(monoChunk24k) {
    if (!isLocalActive) return;

    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVad(pcm16k);
    }
}

function closeLocalSession() {
    isLocalActive = false;
    completionController?.abort();
    completionController = null;
    completionQueue = Promise.resolve();
    pendingCompletionControllers.clear();
    interruptLocalOnNewRequest = false;
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    llamaProcess = null;
    whisperProcess = null;
    llamaBaseUrl = null;
    whisperBaseUrl = null;
    llamaModel = null;
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    localConversationHistory = [];
    currentSystemPrompt = null;
    currentWhisperLanguage = 'en';
}

async function cancelLocalInitialization() {
    if (!initializationController) {
        return false;
    }

    initializationController.abort();
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    await new Promise(resolve => setTimeout(resolve, 300));
    removeNewLlamaCacheEntries();
    sendToRenderer('local-ai-download-progress', { active: false });
    sendToRenderer('session-initializing', false);
    return true;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive || !llamaProcess) {
        return { success: false, error: 'No active local session' };
    }

    try {
        await sendToLlama(text);
        return { success: true };
    } catch (error) {
        if (error.message === 'Interrupted by a new request') return { success: true, interrupted: true };
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive || !llamaProcess) {
        return { success: false, error: 'No active local session' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    const sessionController = completionController;
    try {
        return await enqueueCompletion(async signal => {
            sendToRenderer('update-status', 'Analyzing image...');
            const recentTurns = recentLocalTurns();
            const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...recentTurns, userMessage];
            const stream = createResponseStream(sendToRenderer);
            const fullText = await requestLlama(messages, text => {
                if (!signal.aborted) stream.update(text);
            }, signal);

            if (fullText.trim()) {
                localConversationHistory.push({ role: 'user', content: prompt }, { role: 'assistant', content: fullText.trim() });
                localConversationHistory = localConversationHistory.slice(-20);
                saveConversationTurn(prompt, fullText);
            }

            sendToRenderer('update-status', 'Listening...');
            return { success: true, text: fullText, model: llamaModel };
        });
    } catch (error) {
        if (error.message === 'Interrupted by a new request') return { success: true, interrupted: true, model: llamaModel };
        console.error('[LocalAI] Image error:', error);
        if (isLocalActive && sessionController === completionController && !sessionController?.signal.aborted) {
            sendToRenderer('update-status', 'Local AI image error: ' + error.message);
        }
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    cancelLocalInitialization,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
