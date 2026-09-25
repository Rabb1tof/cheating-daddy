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

- **Live AI Assistance**: Choose Gemini Live or Groq speech transcription, then choose Gemini Live or Groq answers for Gemini speech
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

## Installing packaged builds

- **Windows**: Run the `.exe` installer. It installs for the current Windows account and appears as **Cheating Daddy** in **Settings → Apps → Installed apps**. If it is missing, check that you are viewing the same Windows account that ran the installer and that `%LOCALAPPDATA%\cheating-daddy` exists. The per-user uninstall entry is under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\cheating-daddy`.
- **macOS**: Open the `.dmg` and drag **Cheating Daddy.app** into **Applications**. Opening the disk image alone does not install the app; after copying, launch it from **Applications**.

## Usage

1. Select **Groq** or **Gemini Live** for transcription, then enter the corresponding API key. With Gemini Live speech, choose **Answer provider**: **Same as speech provider** (Gemini Live), **Gemini Live**, or **Groq**. The Groq option keeps the Gemini transcription plus Groq answers combination and requires a Groq key. Groq speech always uses Groq answers.
2. Refresh the model lists and select the speech, answer, fallback, and screenshot models. You can type an ID that is not listed; the provider validates it when used. Screenshots follow the speech provider by default, and you can choose the other provider explicitly. Model access and free-tier eligibility depend on your account.
3. Choose your profile and response language in settings. The language selection is saved and applied to text and screenshot answers. Local Whisper uses a multilingual model for non-English languages. Gemini Live detects input language automatically; its speech output language is not forced by this setting.
4. Click "Start Session" to begin
5. Position the window using keyboard shortcuts
6. The AI will provide real-time assistance based on your screen and what the interviewer asks

To get fuller answers, paste your resume and the job description in **AI Context**, then turn on **Settings → Responses → Detailed answers** and start a new session. This affects Gemini Live, Groq, screenshots, and local answers. Text appears as it is generated; each answer keeps its own entry, even when another request starts. Groq screenshot context may be shortened further to fit the request token budget.

**Settings → Responses** also has two independent checkboxes. **Interrupt current answer on a new request** is off by default, so supported providers let the current answer finish before a new one starts; turning it on lets a new text or screenshot request cancel an active local or HTTP answer and enables Gemini Live's voice interruption behavior. Recognized Gemini Live speech also cancels a separate HTTP answer; recognition may arrive after the speech begins. Cancelling an HTTP request may still consume provider quota. The cloud WebSocket service does not provide a cancellation command. **Remember recent answers** is on by default. It supplies a small, bounded set of completed answers from the current session to follow-up text and screenshot requests. This uses extra input tokens and resets when a session ends or a new one starts. Saved entries in **History** remain separate from what the model receives. Gemini Live keeps its own conversation context while its connection is open, even if the checkbox is off; this setting controls the context the app explicitly sends, including after a reconnect. Changes to these checkboxes take effect with a new session.

### Groq free-tier behavior

Groq-only mode sends speech to Whisper and the resulting transcript to a Groq chat model. Silence and very short speech are skipped; speech is batched into segments of up to 20 seconds. Transcription requests are spaced by at least 10 seconds, text requests by at least 8 seconds, and screenshot requests by at least 30 seconds. Chat answers are capped at 512 completion tokens in concise mode or 1024 in detailed mode; screenshot answers are capped at 1024, and context is kept short. The app marks answers cut off by these limits. A configured fallback speech or chat model is tried when the primary model is unavailable or rate limited. A rate limit shared across models can still stop both attempts; the app shows the error instead of retrying indefinitely. Check your current [Groq rate limits](https://console.groq.com/docs/rate-limits) and [model availability](https://console.groq.com/docs/models) because they vary by account and may change.

On upgrade, a saved Gemini Live setup with a Groq key keeps Groq answers as an explicit setting. For new setups, saving a Groq key for screenshots does not change Gemini Live answers while **Same as speech provider** is selected. The Gemini speech plus Groq answers hybrid consumes both providers' quotas: Gemini Live still processes and generates audio even when only the Groq answer is displayed.

Gemini Live models and their free-tier support also change. Use the model list and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) before starting a long session. Google Search is off by default to avoid extra requests. The current Gemini 3.8 Live model keeps proactive audio enabled on the server; the API rejects an explicit `proactiveAudio: false` setting.

### Provider usage and limits

The Home screen shows Groq limits from the last response headers and Gemini token usage reported for requests made by this app. Gemini Live shows its latest usage report; screenshot and text totals count completed requests in the current app session. These figures are not a project-wide remaining balance.

Reading Gemini **project** quotas is optional. Find your project ID in [AI Studio Projects](https://aistudio.google.com/projects), then use `gcloud auth application-default login` to authorize Google Cloud Application Default Credentials. Your Google account needs `cloudquotas.quotas.get` and `monitoring.timeSeries.list` on the project, and the [Cloud Quotas](https://cloud.google.com/docs/quotas/development-environment) and [Cloud Monitoring](https://cloud.google.com/monitoring/docs/monitoring-overview) APIs must be enabled. Enter the project ID under **Provider usage and limits** and click **Refresh**. This makes a fresh read only when clicked, without an inference request. The panel shows published **free-tier limits for the selected Gemini models**; check AI Studio for the project's actual tier. [Cloud Quotas API calls are free](https://cloud.google.com/quotas/pricing). Cloud Monitoring may require a billing-enabled project even when API calls would fall within its [monthly free allotment](https://cloud.google.com/products/observability/pricing); without billing, free-tier quota limits and this app's token counts still work. When available, Monitoring usage is displayed by sample interval because it can lag and is not an instant remaining balance.

The Gemini and Groq providers work with their own API keys even if you do not set up Google Cloud sign-in.

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
