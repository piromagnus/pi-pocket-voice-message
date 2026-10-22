# voice-message

Dictate a message in [Pi Pocket](https://github.com/TannerMidd/pi-pocket): press the mic button, record, stop, review the transcript, and insert it as a draft. Nothing is ever sent automatically.

Two transcription engines, picked in the sheet:

- **Mistral — Voxtral Mini Transcribe 3** (`voxtral-mini-transcribe-3-0`, `language=fr`): the official [Mistral transcription API](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0), $0.0035/min. The key is read only on the server: `MISTRAL_API_KEY`, or the `mistral` entry of Pi's `auth.json`. No other endpoint is used, and there is no retry or silent fallback to another provider.
- **Local — Whisper, adaptive**: the large `large-v3-turbo` model on the server's GPU when one is available, otherwise the small model on the CPU — so it works on any machine. Audio never leaves the server.

## Self-contained runtime

The local engine needs nothing prepared. At its first use, the extension builds a Python environment beside the module, in `_voice-message/`:

- a virtual environment created with `uv` (or `python3 -m venv`), with the pinned packages `faster-whisper==1.2.1` and `av==19.0.2`;
- the small Whisper model (MIT, [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small), pinned revision), downloaded once, about 465 MB.

Everything the extension ships is in this repository; the runtime folder is machine-local and never listed in the gallery entry. A machine with an NVIDIA GPU and CUDA can drop a faster-whisper `large-v3-turbo` model into `_voice-message/model/` and set `"gpu"` in `_voice-message/config.json` to use it; nothing changes for anyone else.

## Limits and privacy

- The route is owner-only (`access: "owner"`), one transcription at a time, 90 s (Mistral) or 240 s (local) budget.
- Recordings are capped at 2 minutes / 700 KB, held in memory, and never written to disk or added to a conversation. Only the text you insert joins the normal message draft.
- With Mistral, the audio goes to Mistral's API, as the sheet says before you record. Local audio stays on the server.
- The browser needs HTTPS (or a secure localhost) and microphone permission; the local engine needs `uv` or `python3-venv` on the server (Linux/macOS paths).

## Measured once, not a ranking

On one public French clip (FLEURS, 10.86 s): Mistral answered in 1.38 s; local GPU transcribed in 2.33 s (plus a 3.6 s model load); the small model on CPU took 1.58 s. These are single samples on one machine and network — not a general quality ranking.

## Files

- `voice-message.ts` — the server module: the transcription route, engine dispatch, key resolution, runtime bootstrap.
- `voice-message/index.js` — the browser module: mic button, recording sheet, review, insert.
- `voice-message/style.css` — mobile-first styles using the app's theme tokens.
- `voice-message/transcribe.py` — the offline worker: audio from stdin, adaptive model pick, text to stdout.
- `voice-message/requirements.lock` — the full freeze of the tested Python environment.

## Tests

Run against a Pi Pocket checkout (`PI_POCKET_REPO`, default `/home/pmarrec/pi-pocket`):

```sh
node --test _voice-message*.test.ts
```

- `_voice-message.test.ts` — the whole app in Chromium at phone size: real local transcription of the sample clip, draft-only insert, cancellation on close/navigation/permission-delay, busy lock, route access (guest 404, missing header 403, bad audio 400, oversized 413), and the extension turning off. The microphone is simulated; the model is real.
- `_voice-message-api.test.ts` — the Mistral transport with a local fake: exact endpoint and model, key resolution (including a command-style key that must never run), no retries, secrets never surfaced in errors, cancellation, and the shared busy lock. No billable calls.
- `_voice-message-light.test.ts` — the Python engines directly: the adaptive GPU pick, the small CPU model, and the audio limits. Skips until a local runtime exists.
- `_voice-message-bootstrap.test.ts` — a clean install with only the gallery's files: the extension builds its Python runtime, downloads the small model, and transcribes.

The test clip `_voice-message/fixtures/french.wav` is utterance 118005971910520590 of Google FLEURS `fr_fr` ([CC-BY 4.0](https://huggingface.co/datasets/google/fleurs)); reference: « Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite. »

## License

MIT. The Whisper models are MIT-licensed ([faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)); Mistral's service is governed by [Mistral's terms](https://docs.mistral.ai/).
