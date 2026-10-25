import { createDraft } from "./draft.js";
import { createLive } from "./live.js";

export const pocketApi = 1;

const MIC =
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8";
const STOP = "M7 7h10v10H7z";
const ENGINE_KEY = "x.voice-message.engine";
const LANGUAGE_KEY = "x.voice-message.language";
/** The languages a recording can be pinned to, as Audio settings offers them. */
const LANGUAGES = [
    ["auto", "Auto (detect)"],
    ["fr", "French"],
    ["en", "English"],
    ["de", "German"],
    ["es", "Spanish"],
    ["it", "Italian"],
    ["pt", "Portuguese"],
    ["nl", "Dutch"],
    ["ar", "Arabic"],
    ["ru", "Russian"],
    ["zh", "Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["hi", "Hindi"],
];
const MAX_BYTES = 700_000;
const MAX_MS = 300_000;
const PREVIEW_MS = 3_000;
const ENGINES = {
    mistral: {
        label: "Mistral · Voxtral Realtime 3 (live)",
        about: "Words appear while you speak, then the whole recording is transcribed again when you stop. Audio goes to Mistral: $0.008/min live plus $0.0035/min for the correction, about $0.0115 per recorded minute on your API credits.",
    },
    "mistral-file": {
        label: "Mistral · Voxtral Mini Transcribe 3 (after you stop)",
        about: "Nothing appears until you stop, then the whole recording is transcribed once. Audio goes to Mistral: $0.0035/min on your API credits.",
    },
    local: {
        label: "Local · Whisper",
        about: "Short chunks appear while you speak, then the whole recording is transcribed again when you stop. Audio stays on this server: a GPU model when available, otherwise a small CPU model.",
    },
};

/** The engine this browser uses. An unknown or missing choice means Mistral live, as the first choice always did. */
const engine = () => {
    const saved = localStorage.getItem(ENGINE_KEY);

    return Object.hasOwn(ENGINES, saved) ? saved : "mistral";
};

/** The language this browser dictates in. Auto lets each engine detect it from the speech. */
const language = () => {
    const saved = localStorage.getItem(LANGUAGE_KEY);

    return saved !== null && /^(auto|[a-z]{2,3})$/.test(saved) ? saved : "auto";
};

export default function setup(pocket) {
    const { html, useState } = pocket;
    let session = null;
    let disposed = false;
    let button;
    let status = null;

    function show(phase) {
        if (disposed) {
            return;
        }

        const title =
            phase === "recording"
                ? "Stop dictation"
                : phase === "permission"
                  ? "Cancel microphone request"
                  : phase === "final"
                    ? "Cancel final transcription"
                    : "Dictate a message";

        button?.update({ title, iconPath: phase === "recording" ? STOP : MIC });

        if (!phase) {
            status?.remove();
            status = null;

            return;
        }

        const text =
            phase === "recording"
                ? "Recording · live preview"
                : phase === "permission"
                  ? "Waiting for microphone…"
                  : "Finalizing transcript…";

        if (status) {
            status.update({ text });
        } else {
            status = pocket.status({ id: "dictation", text, short: "voice", title, tone: "muted" });
        }
    }

    const valid = (each) =>
        !disposed &&
        session === each &&
        pocket.conversationId() === each.conversationId &&
        pocket.me()?.id === each.personId &&
        pocket.me()?.role !== "viewer" &&
        each.box.isConnected &&
        !each.box.disabled &&
        !each.box.readOnly;

    function release(each) {
        clearTimeout(each.timer);
        clearTimeout(each.previewTimer);
        clearInterval(each.scopeTimer);
        each.stream?.getTracks().forEach((track) => track.stop());
        each.stream = null;
    }

    function finish(each) {
        release(each);
        each.live?.cancel();
        each.request.abort();
        each.draft.close();
        each.chunks = [];
        each.queue = [];

        if (session === each) {
            session = null;
            show(null);
        }
    }

    function cancel() {
        const each = session;

        if (!each) {
            return;
        }

        // Clear handlers before stopping: a late stop must never start a transcription.
        for (const recorder of [each.recorder, each.previewRecorder]) {
            if (recorder) {
                recorder.onstop = null;
                recorder.ondataavailable = null;
                recorder.onerror = null;

                if (recorder.state !== "inactive") {
                    recorder.stop();
                }
            }
        }

        finish(each);
    }

    async function request(each, blob, phase) {
        if (!valid(each) || each.request.signal.aborted) {
            throw new Error("Dictation cancelled.");
        }

        if (!blob.size) {
            throw new Error("Nothing was recorded. Speak for a moment before you stop.");
        }

        if (blob.size > MAX_BYTES) {
            throw new Error("The recording is too large. Try a shorter message.");
        }

        const bytes = new Uint8Array(await blob.arrayBuffer());
        const parts = [];

        for (let at = 0; at < bytes.length; at += 8192) {
            parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
        }

        if (!valid(each)) {
            throw new Error("Dictation cancelled.");
        }

        const result = await pocket.api(
            "transcribe",
            {
                audio: btoa(parts.join("")),
                mimeType: blob.type,
                engine: each.engine === "local" ? "local" : "mistral",
                language: each.language,
                phase,
            },
            { signal: each.request.signal },
        );

        if (typeof result?.text !== "string" || result.text.length > 100_000) {
            throw new Error("The transcription engine returned no valid text.");
        }

        return result.text.trim();
    }

    function previewFailure(each) {
        if (!each.previewFailed && valid(each)) {
            each.previewFailed = true;
            pocket.notify(
                "warning",
                "Live preview is unavailable. The full recording will be transcribed when you stop.",
            );
        }
    }

    function drain(each) {
        if (each.pending || !each.queue.length || !valid(each) || each.phase !== "recording") {
            return;
        }

        const blob = each.queue.shift();

        each.pending = (async () => {
            try {
                const text = await request(each, blob, "preview");

                if (valid(each) && text) {
                    each.previewText = [each.previewText, text].filter(Boolean).join(" ");
                    each.draft.update(each.previewText);
                }
            } catch {
                previewFailure(each);
            } finally {
                each.pending = null;
                drain(each);
            }
        })();
    }

    /** Mistral's live transcription: words arrive while the person speaks, with no chunk boundaries. */
    function startLive(each) {
        each.live = createLive(pocket, {
            language: each.language,
            onText: (text) => {
                if (valid(each) && text) {
                    each.previewText = text;
                    each.draft.update(text);
                }
            },
            onFail: () => previewFailure(each),
        });
        each.live.start(each.stream);
    }

    function makeRecorder(each) {
        const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(
            (type) => MediaRecorder.isTypeSupported(type),
        );

        return new MediaRecorder(each.stream, {
            ...(mimeType ? { mimeType } : {}),
            audioBitsPerSecond: 16_000,
        });
    }

    function preview(each) {
        if (!valid(each) || each.phase !== "recording" || each.previewFailed) {
            return;
        }

        try {
            // Each preview has its own container header; arbitrary MediaRecorder timeslice blobs cannot be decoded alone.
            const recorder = makeRecorder(each);
            const chunks = [];
            let bytes = 0;

            each.previewRecorder = recorder;
            recorder.ondataavailable = ({ data }) => {
                bytes += data.size;

                if (bytes <= MAX_BYTES) {
                    chunks.push(data);
                }
            };
            recorder.onstop = () => {
                if (valid(each) && each.phase === "recording") {
                    if (each.queue.length < 2 && bytes <= MAX_BYTES && bytes > 0) {
                        each.queue.push(new Blob(chunks, { type: recorder.mimeType }));
                        drain(each);
                    } else {
                        previewFailure(each);
                    }

                    preview(each);
                }
            };
            recorder.onerror = () => previewFailure(each);
            recorder.start();
            each.previewTimer = setTimeout(() => {
                if (recorder.state === "recording") {
                    recorder.stop();
                }
            }, PREVIEW_MS);
        } catch {
            // Some devices allow only one recorder. Keep the complete recording and explain the fallback.
            previewFailure(each);
        }
    }

    async function finalize(each) {
        each.phase = "final";
        release(each);
        each.queue = [];
        show("final");

        try {
            // Wait for the only in-flight preview so it releases the server's single-request lock. A live session
            // is closed first, for the same reason, and for the last words Mistral had not yet sent.
            await each.pending;
            await each.live?.end();

            if (!valid(each)) {
                return;
            }

            const blob = new Blob(each.chunks, { type: each.recorder.mimeType });
            const text = await request(each, blob, "final");

            if (!valid(each)) {
                return;
            }

            if (!each.draft.update(text) && each.draft.edited) {
                pocket.notify(
                    "info",
                    "Your edits were kept; the final transcript did not replace them.",
                );
            } else if (!text) {
                pocket.notify("warning", "No speech recognized. Any preview text was kept.");
            }
        } catch (error) {
            if (valid(each) && !each.request.signal.aborted) {
                pocket.notify(
                    "error",
                    `${error.message || "Transcription failed."} Any preview text was kept.`,
                );
            }
        } finally {
            finish(each);
        }
    }

    function stop() {
        const each = session;

        if (!each || each.phase !== "recording") {
            return;
        }

        each.phase = "stopping";
        clearTimeout(each.previewTimer);

        if (each.previewRecorder?.state === "recording") {
            each.previewRecorder.stop();
        }

        each.recorder.stop();
        each.stream?.getTracks().forEach((track) => track.stop());
    }

    async function start() {
        const person = pocket.me();
        const conversationId = pocket.conversationId();
        // Pi Pocket has no public replace-range API. Use its documented composer part and the ordinary input event.
        // No core imports, internal store writes, prototype patches, or send actions are used.
        const box = document.querySelector('[data-part~="composer"] textarea');

        if (
            !person ||
            person.role === "viewer" ||
            conversationId === null ||
            !box ||
            box.disabled ||
            box.readOnly
        ) {
            pocket.notify("warning", "Open a conversation you can write in.");

            return;
        }

        if (
            !globalThis.isSecureContext ||
            !navigator.mediaDevices?.getUserMedia ||
            typeof MediaRecorder !== "function"
        ) {
            pocket.notify("error", "Recording needs HTTPS and a browser with microphone access.");

            return;
        }

        const each = {
            phase: "permission",
            personId: person.id,
            conversationId,
            box,
            engine: engine(),
            language: language(),
            request: new AbortController(),
            stream: null,
            recorder: null,
            previewRecorder: null,
            chunks: [],
            queue: [],
            pending: null,
            live: null,
            previewText: "",
            previewFailed: false,
            timer: null,
            previewTimer: null,
            scopeTimer: null,
            size: 0,
            draft: null,
        };

        session = each;
        each.draft = createDraft(box, () => valid(each));
        show("permission");
        each.scopeTimer = setInterval(() => {
            if (!valid(each)) {
                cancel();
            }
        }, 150);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            if (!valid(each) || document.hidden) {
                stream.getTracks().forEach((track) => track.stop());

                if (session === each) {
                    finish(each);
                }

                return;
            }

            each.stream = stream;
            each.recorder = makeRecorder(each);
            each.recorder.ondataavailable = ({ data }) => {
                if (session !== each) {
                    return;
                }

                each.size += data.size;

                if (each.size > MAX_BYTES) {
                    pocket.notify(
                        "error",
                        "The recording exceeded the upload limit. Any preview text was kept.",
                    );
                    cancel();

                    return;
                }

                each.chunks.push(data);
            };
            each.recorder.onstop = () => finalize(each);
            each.recorder.onerror = () => {
                pocket.notify(
                    "error",
                    "The microphone recording failed. Any preview text was kept.",
                );
                cancel();
            };
            each.phase = "recording";
            each.recorder.start(1000);
            each.timer = setTimeout(stop, MAX_MS);
            show("recording");

            if (each.engine === "mistral") {
                startLive(each);
            } else if (each.engine === "local") {
                preview(each);
            }
        } catch (error) {
            if (session === each) {
                pocket.notify(
                    "error",
                    error.name === "NotAllowedError"
                        ? "Allow the microphone in the browser's settings."
                        : error.name === "NotFoundError"
                          ? "No microphone found."
                          : "Cannot start recording.",
                );
                cancel();
            }
        }
    }

    function tap() {
        if (!session) {
            start();
        } else if (session.phase === "recording") {
            stop();
        } else {
            cancel();
        }
    }

    const hidden = () => {
        if (document.hidden) {
            if (session?.phase === "permission") {
                cancel();
            } else {
                stop();
            }
        }
    };
    const leave = () => cancel();
    const submitted = (event) => {
        if (session && event.target.contains?.(session.box)) {
            cancel();
        }
    };
    const sendClick = (event) => {
        if (session && event.target.closest?.('[data-part~="send-button"]')) {
            cancel();
        }
    };
    const sendKey = (event) => {
        if (
            session &&
            event.target === session.box &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing
        ) {
            cancel();
        }
    };

    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    document.addEventListener("submit", submitted, true);
    document.addEventListener("click", sendClick, true);
    document.addEventListener("keydown", sendKey, true);

    function AudioSettings() {
        const [engineValue, setEngine] = useState(engine);
        const [languageValue, setLanguage] = useState(language);

        return html`<div class="voice-settings">
            <label for="voice-settings-engine">Transcription model</label>
            <select
                id="voice-settings-engine"
                value=${engineValue}
                onChange=${(event) => {
                    localStorage.setItem(ENGINE_KEY, event.currentTarget.value);
                    setEngine(event.currentTarget.value);
                }}
            >
                ${Object.entries(ENGINES).map(
                    ([id, { label }]) => html`<option value=${id}>${label}</option>`,
                )}
            </select>
            <p class="muted small">${ENGINES[engineValue].about}</p>
            <label for="voice-settings-language">Transcription language</label>
            <select
                id="voice-settings-language"
                value=${languageValue}
                onChange=${(event) => {
                    localStorage.setItem(LANGUAGE_KEY, event.currentTarget.value);
                    setLanguage(event.currentTarget.value);
                }}
            >
                ${LANGUAGES.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
            </select>
            <p class="muted small">
                Auto lets each engine detect it from the speech. Short local preview chunks can
                rarely misjudge a language; the full pass, on the whole recording, corrects it.
            </p>
            <p class="muted small">
                Nothing is sent as a message, and your manual edits are never replaced.
            </p>
        </div>`;
    }

    pocket.style("style.css");
    pocket.page({ id: "audio-settings", title: "Audio settings", component: AudioSettings });
    pocket.rail({
        id: "audio-settings",
        title: "Audio settings",
        iconPath: MIC,
        page: "audio-settings",
    });
    button = pocket.composerButton({
        id: "dictate",
        title: "Dictate a message",
        iconPath: MIC,
        run: tap,
    });

    return () => {
        cancel();
        disposed = true;
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("pagehide", leave);
        document.removeEventListener("submit", submitted, true);
        document.removeEventListener("click", sendClick, true);
        document.removeEventListener("keydown", sendKey, true);
    };
}
