# Voice message for Pi Pocket

Tap the microphone beside the message box and speak. A live preview appears in the box while recording continues. Tap again to stop: a full-recording transcription replaces the preview with the corrected text. Review, edit, and send the message yourself. Nothing is sent automatically.

## Audio settings

Pick an engine in **Menu → Audio settings**. The choice stays in this browser, and Mistral live is the default.

- **Mistral · Voxtral Realtime 3 (live)**: words appear while you speak, streamed by `voxtral-mini-transcribe-realtime-3`. When you stop, `voxtral-mini-transcribe-3-0` transcribes the whole recording once more and corrects the text. French is pinned. At the published rates ($0.008/min realtime plus $0.0035/min for the correction) this costs about **$0.0115 per recorded minute** (provider billing rules apply). Audio is sent to Mistral. The key stays on the server: `MISTRAL_API_KEY`, or Pi's `mistral` API-key entry in `auth.json`. Credential commands are never executed. No OpenRouter, automatic retry, or automatic provider fallback.
- **Mistral · Voxtral Mini Transcribe 3 (after you stop)**: nothing appears while you speak; the whole recording is transcribed once, at **$0.0035/min**. The cheapest cloud option, and the one that opens no live session.
- **Local · Whisper**: short chunks appear while you speak (Whisper small on CPU, with faster decoding), then the whole recording is transcribed again when you stop with **large-v3-turbo on CUDA** when installed and available, otherwise Whisper small on CPU. No cloud API call or per-minute fee. Audio stays on the Pi Pocket server; CPU/GPU and electricity are still needed.

The interface and errors are in English. Speech recognition is pinned to **French**; set `VOICE_MESSAGE_LANGUAGE` (ISO 639, such as `en` or `de`) on the server to transcribe another language. It applies to the live session, the file pass, and the local engine.

## How live preview works

**Mistral: true streaming.** The browser may only talk to its own Pi Pocket server (the app's content security policy is `connect-src 'self'`), so it cannot open Mistral's WebSocket itself. Instead, the **server** holds one WebSocket to `wss://api.mistral.ai/v1/audio/transcriptions/realtime`, configured for 16 kHz PCM, French, and a 480 ms delay. The browser captures the microphone with an `AudioWorklet`, converts it to 16 kHz mono PCM, and sends it in 400 ms requests. The server relays each piece of text back to the person's own tabs as a `live` event (`web.send`, addressed to that person only). Words arrive as Mistral writes them, with no chunk boundaries. After Stop, the server ends the session, and the whole recording is transcribed once more for the correction.

**Local: chunked near-live.** Local Whisper cannot stream, so every 3 seconds a second native `MediaRecorder` completes an independently decodable audio file. Preview requests run sequentially. The complete recording is kept in parallel and sent once for the final correction at Stop.

This deliberately reuses the existing STT engines and route. It does not upload the growing full recording repeatedly. Preview costs roughly one extra pass over the audio, rather than quadratic repeated uploads. Short chunks can split a word or lose context; the final pass transcribes the original complete audio and corrects these errors.

Measured once each, on one public French sample of 10.86 seconds, in real Chromium:

- **Mistral, real service:** first words after **3.5 s**; **21 text updates while the clip was still playing**, the last at 10.6 s; the final text was exact, including the plural agreements.
- **Local Whisper:** first text after about **5.3 s**, then updates every 3 s; the full correction finished about 4 s after Stop.

These are single measurements on one server and one network, not latency guarantees or a quality benchmark. The first words of Mistral's stream trail the speech by a few seconds: that is the service's own latency plus the time to send audio, not a delay added here.

### Protecting your draft

Only the extension-owned dictated span is replaced. Existing text, edits before or after that span, selection, and draft saving are preserved.

**If you manually edit the dictated span, automatic replacement of that span pauses for the rest of that recording**, including the final correction. Your words win; late responses cannot overwrite them. For uninterrupted preview, make corrections after Stop. Preview text is retained if transcription fails or is cancelled.

Changing conversation/account, sending the message, closing the page, losing the composer, or disabling the extension cancels dictation and stops microphone tracks. A permission response that arrives after cancellation is immediately released. Hiding the tab stops the recording and requests its final transcription. There is no dictation popup.

### Extension-only compatibility

Pi Pocket's public `insertText` API can append but cannot revise an earlier insertion. The extension therefore locates the textarea under the documented `data-part="composer"` region and sends ordinary bubbling `input` events. This uses the same draft-saving path as typing; there are **no core imports, internal store writes, prototype patches, or automatic send actions**.

The owned-range adapter is isolated in `voice-message/draft.js` and tested with both unit tests and the real Preact composer. A future public replace-range API would remove this DOM dependency. If the expected writable composer is unavailable, dictation refuses to start.

## Local installation

Install the drop-in module and its `voice-message/` folder, then enable it in Extensions. All shipped runtime code lives in those files. Machine-specific environments and weights live separately in `_voice-message/`, which is never served to browsers or included in a gallery entry.

At first local use, the extension prepares a Python virtual environment using **uv** or **python3 with venv/pip**. It installs exactly what `voice-message/requirements.lock` says: every package pinned by version **and SHA-256**, with `--require-hashes` enforced (generated with `uv pip compile --universal --generate-hashes` from `voice-message/requirements.in`). A new lock re-installs; a stale install never passes for a fresh one. The download is about **900 MB**: the Python packages (about 425 MB, from PyPI — `pypi.org` and `files.pythonhosted.org`) and the small Whisper model (about 465 MB, from `huggingface.co`).

The small model is downloaded once from `Systran/faster-whisper-small`, pinned to revision `536b0662742c02347bc0e980a01041f333bce120` (MIT). A revision cannot change, so what runs is what the reviewed commit decided. Initial setup needs network access to Python package indexes and Hugging Face; subsequent transcription with cached weights does not need network access. Failed/cancelled setup is retried on the next explicit request, without trusting a half-created interpreter.

For the optional final GPU model, put CTranslate2 `large-v3-turbo` weights in `_voice-message/model/` and configure the GPU index in `_voice-message/config.json`, for example `{"gpu": 0}`. The tested conversion is `mobiuslabsgmbh/faster-whisper-large-v3-turbo`, revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`. CUDA 12/cuDNN 9 are needed. If unavailable, the final pass uses the small CPU model. Neither Python nor CUDA is bundled; this is not universal hardware compatibility.

## Limits

- HTTPS or a secure loopback origin, microphone permission, and native `MediaRecorder` support are required.
- A recording stops after 5 minutes. Its compressed file must stay below 700 KB to fit Pi Pocket's 1 MB JSON limit after base64 encoding. Some browsers ignore the requested 16 kbit/s bitrate and can reach the size limit sooner; in that case the preview is retained and an error explains the limit.
- Requests are owner-only, one transcription at a time, with a 90-second Mistral or 290-second local timeout. A final pass waits for an in-flight preview to release the shared lock.
- Slow preview processing is bounded to 2 queued chunks. If the device/service cannot keep up, preview stops with a warning and the final pass still uses the complete recording.
- Some browsers/devices do not support two concurrent recorders; they fall back to the final-only flow with a visible warning. Chromium is tested; physical Android/iOS microphones and Safari are not yet verified.
- Audio stays in memory, never in a recording file or conversation. Only the draft text enters normal Pi Pocket storage. Mistral applies its own service terms; cancelling a submitted cloud request does not guarantee no charge.

## Tests

Node 22+ is required for direct TypeScript execution. No npm packages are needed to run the unit tests:

```sh
npm run check
npm test
```

Unit tests cover draft ownership, revisions, prefix/suffix edits, protected manual corrections, duplicate text, clearing/sending, IME composition, selection, teardown, Mistral request shape and credentials, bounded responses, cancellation, concurrency, and preview/final validation. Mistral transport is mocked; these tests do not incur API charges or read real credentials.

For real-app and offline-model tests, provide a Pi Pocket checkout and an optional prepared local runtime:

```sh
PI_POCKET_REPO=/path/to/pi-pocket \
VOICE_TEST_RUNTIME=/path/to/extensions/_voice-message \
npm run test:integration
```

The clean-install test creates its own Python environment and downloads weights if absent. The native-recording test uses a real Web Audio stream, native Chromium `MediaRecorder`, and real Whisper. It proves preview text appears before Stop and that the full final pass corrects it, without sending a message to a model. Another Chromium test mocks STT to cover slow responses, final corrections, manual edits, cancellation, sending, navigation, permissions, errors, and extension disposal. GPU-only assertions require `VOICE_TEST_GPU=1` and a prepared CUDA model; otherwise they skip.

The fixture `_voice-message/fixtures/french.wav` comes from the public `podscripter-project/test-fixtures` copy of Google FLEURS `fr_fr`, utterance `118005971910520590` (CC-BY 4.0). Reference: “Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.”

## License and sources

MIT — Copyright (c) 2026 Pierre Marrec.

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [Whisper small weights](https://huggingface.co/Systran/faster-whisper-small)
- [Mistral transcription model and pricing](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0)
- [FLEURS dataset](https://huggingface.co/datasets/google/fleurs)
- [Audio fixture](https://huggingface.co/datasets/podscripter-project/test-fixtures)
