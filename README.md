<img width="1299" height="424" alt="cd (1)" src="https://github.com/user-attachments/assets/b25fff4d-043d-4f38-9985-f832ae0d0f6e" />

## Recall.ai - API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/product/desktop-recording-sdk/?utm_source=github&utm_medium=sponsorship&utm_campaign=sohzm-cheating-daddy), an API that records Zoom, Google Meet, Microsoft Teams, in-person meetings, and more.

This project is sponsored by Recall.ai.

---

> [!NOTE]  
> Use latest MacOS and Windows version, older versions have limited support

> [!NOTE]  
> During testing it wont answer if you ask something, you need to simulate interviewer asking question, which it will answer

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and audio analysis.

## Features

- **Live AI Assistance**: Choose Gemini Live or Groq speech transcription with Groq answers
- **Current models**: Refresh the model lists from your provider, or enter a model ID manually
- **Free-tier controls**: Groq skips silence, batches speech, spaces out requests, limits answer size, and can switch to a configured fallback model
- **Screen & Audio Capture**: Analyzes what you see and hear for contextual responses
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere
- **Click-through Mode**: Make window transparent to clicks when needed
- **Cross-platform**: Works on macOS, Windows, and Linux (kinda, dont use, just for testing rn)

## Setup

1. **Get a provider key**: Use [Groq Console](https://console.groq.com/keys) for Groq-only sessions, or [Google AI Studio](https://aistudio.google.com/apikey) for Gemini Live. A Google key is optional when Groq is selected for transcription.
2. **Install Dependencies**: `npm ci`
3. **Run the App**: `npm start`

## Usage

1. Select **Groq** or **Gemini Live** for transcription, then enter the corresponding API key. A Groq key can also provide answers while Gemini Live handles transcription.
2. Refresh the model lists and select the speech, answer, fallback, and screenshot models. You can type an ID that is not listed; the provider validates it when used. Screenshots follow the speech provider by default, and you can choose the other provider explicitly. Model access and free-tier eligibility depend on your account.
3. Choose your profile and response language in settings. The language selection is saved and applied to text and screenshot answers. Local Whisper uses a multilingual model for non-English languages. Gemini Live detects input language automatically; its speech output language is not forced by this setting.
4. Click "Start Session" to begin
5. Position the window using keyboard shortcuts
6. The AI will provide real-time assistance based on your screen and what the interviewer asks

### Groq free-tier behavior

Groq-only mode sends speech to Whisper and the resulting transcript to a Groq chat model. Silence and very short speech are skipped; speech is batched into segments of up to 20 seconds. Transcription requests are spaced by at least 10 seconds, text requests by at least 8 seconds, and screenshot requests by at least 30 seconds. Chat answers are capped at 512 completion tokens, screenshot answers at 1024, and context is kept short. The app marks answers cut off by these limits. A configured fallback speech or chat model is tried when the primary model is unavailable or rate limited. A rate limit shared across models can still stop both attempts; the app shows the error instead of retrying indefinitely. Check your current [Groq rate limits](https://console.groq.com/docs/rate-limits) and [model availability](https://console.groq.com/docs/models) because they vary by account and may change.

Gemini Live models and their free-tier support also change. Use the model list and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) before starting a long session. Google Search is off by default to avoid extra requests. The current Gemini 3.8 Live model keeps proactive audio enabled on the server; the API rejects an explicit `proactiveAudio: false` setting.

## Keyboard Shortcuts

- **Window Movement**: `Ctrl/Cmd + Arrow Keys` - Move window
- **Click-through**: `Ctrl/Cmd + M` - Toggle mouse events
- **Close/Back**: `Ctrl/Cmd + \` - Close window or go back
- **Send Message**: `Enter` - Send text to AI

## Audio Capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: Loopback audio capture
- **Linux**: Microphone input

## Requirements

- Electron-compatible OS (macOS, Windows, Linux)
- Gemini or Groq API key for cloud sessions
- Screen recording permissions
- Microphone/audio permissions
