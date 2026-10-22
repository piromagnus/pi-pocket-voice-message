export const pocketApi = 1;

const MIC =
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8";
const STOP = "M7 7h10v10H7z";
const ENGINE_KEY = "x.voice-message.engine";
const MAX_BYTES = 700_000;
const MAX_MS = 300_000;
const ABOUT = {
    mistral: "Your recording goes to Mistral's official API — $0.0035/min on your API credits.",
    local: "Your recording is transcribed on this server: a GPU model when available, otherwise a small CPU model.",
};

/** The engine this browser uses, as Audio settings chose it. */
const engine = () => (localStorage.getItem(ENGINE_KEY) === "local" ? "local" : "mistral");

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;
    let session = null;
    let button = null;
    let status = null;

    if (typeof pocket.composerButton !== "function" || typeof pocket.insertText !== "function") {
        throw new Error("Voice dictation needs Pi Pocket 0.19 or newer.");
    }

    /** The mic button and the status line say what is going on. */
    const idle = () => {
        button?.update({ title: "Dictate a message", iconPath: MIC });
        status?.remove();
        status = null;
    };
    const busy = (phase, text) => {
        button?.update({
            title: phase === "recording" ? "Stop dictation" : "Transcribing…",
            iconPath: phase === "recording" ? STOP : MIC,
        });
        status?.update({ text });
        status ??= pocket.status({
            id: "dictation",
            text,
            short: "voice",
            title: "Voice dictation",
            tone: "muted",
        });
    };

    const release = (each) => {
        clearTimeout(each.timer);
        each.stream?.getTracks().forEach((track) => track.stop());
        each.stream = null;
    };

    const reset = () => {
        session = null;
        idle();
    };

    /** Drop everything without a word: closing, turning off, navigating away. */
    const cancel = () => {
        if (!session) {
            return;
        }

        const each = session;

        session = null;
        each.request.abort();

        if (each.recorder && each.recorder.state !== "inactive") {
            each.recorder.onstop = null;
            each.recorder.ondataavailable = null;
            each.recorder.stop();
        }

        release(each);
        idle();
    };

    /** The transcript lands in the message box, ready to edit and send by hand. */
    const insert = (each, text) => {
        if (pocket.conversationId() !== each.conversationId || pocket.me()?.id !== each.personId) {
            pocket.notify("warning", "The conversation changed; the dictation was not inserted.");

            return;
        }

        if (text) {
            pocket.insertText(text, { inline: true });
        } else {
            pocket.notify("warning", "No speech recognized.");
        }
    };

    async function transcribe(each) {
        release(each);
        each.phase = "transcribing";
        busy("transcribing", "Transcribing…");

        try {
            const blob = new Blob(each.chunks, { type: each.recorder.mimeType });

            each.chunks = [];

            if (!blob.size || blob.size > MAX_BYTES) {
                throw new Error("The recording is empty or too large. Try a shorter message.");
            }

            const bytes = new Uint8Array(await blob.arrayBuffer());
            const parts = [];

            for (let offset = 0; offset < bytes.length; offset += 8192) {
                parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
            }

            const result = await pocket.api(
                "transcribe",
                { audio: btoa(parts.join("")), mimeType: blob.type, engine: each.engine },
                { signal: each.request.signal },
            );

            if (session !== each) {
                return;
            }

            if (typeof result?.text !== "string" || result.text.length > 100_000) {
                throw new Error("The transcription engine returned no valid text.");
            }

            insert(each, result.text.trim());
        } catch (error) {
            if (session === each && !each.request.signal.aborted) {
                pocket.notify("error", error.message || "The transcription failed.");
            }
        } finally {
            if (session === each) {
                reset();
            }
        }
    }

    /** Stop the recording and transcribe what was heard: by hand, by the size cap, or by the time cap. */
    const stop = () => {
        const each = session;

        if (!each || each.phase !== "recording") {
            return;
        }

        each.phase = "stopping";

        if (each.recorder.state === "recording") {
            each.recorder.stop();
        }

        release(each);
    };

    async function start() {
        const conversationId = pocket.conversationId();
        const person = pocket.me();

        if (conversationId === null || !person || person.role === "viewer") {
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

        if (session) {
            return;
        }

        const each = {
            phase: "recording",
            conversationId,
            personId: person.id,
            engine: engine(),
            recorder: null,
            stream: null,
            timer: null,
            chunks: [],
            size: 0,
            request: new AbortController(),
        };

        try {
            // The microphone is asked for in the button's own user gesture.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            if (session || !stream.getTracks().some((track) => track.readyState === "live")) {
                stream.getTracks().forEach((track) => track.stop());

                return;
            }

            if (document.hidden) {
                stream.getTracks().forEach((track) => track.stop());
                pocket.notify("warning", "Come back to this tab before recording.");

                return;
            }

            const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(
                (type) => MediaRecorder.isTypeSupported(type),
            );
            const recorder = new MediaRecorder(stream, {
                ...(mimeType ? { mimeType } : {}),
                // 16 kbit/s keeps about 5 minutes within the size limit; speech stays clear.
                audioBitsPerSecond: 16_000,
            });

            session = each;
            each.stream = stream;
            each.recorder = recorder;
            recorder.ondataavailable = (event) => {
                if (session !== each || each.phase === "transcribing") {
                    return;
                }

                each.size += event.data.size;
                each.chunks.push(event.data);

                if (each.size > MAX_BYTES) {
                    stop();
                }
            };
            recorder.onstop = () => transcribe(each);
            recorder.onerror = () => {
                if (session === each) {
                    pocket.notify("error", "The microphone recording failed.");
                    cancel();
                }
            };
            recorder.start(1000);
            each.timer = setTimeout(stop, MAX_MS);
            busy("recording", "Recording…");
        } catch (error) {
            release(each);
            session = null;

            const message =
                error.name === "NotAllowedError"
                    ? "Allow the microphone in the browser's settings."
                    : error.name === "NotFoundError"
                      ? "No microphone found."
                      : "Cannot start recording.";

            pocket.notify("error", message);
        }
    }

    /** One button, three states: record, stop, or cancel the transcription in flight. */
    const tap = () => {
        if (!session) {
            start();

            return;
        }

        if (session.phase === "recording") {
            stop();

            return;
        }

        pocket.notify("info", "Dictation cancelled.");
        cancel();
    };

    // Hiding the tab stops the recording; the transcript is waiting when the person returns.
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && session?.phase === "recording") {
            stop();
        }
    });

    function AudioSettings() {
        const [value, setValue] = useState(engine);

        return html`<div class="voice-settings">
            <label for="voice-settings-engine">Transcription model</label>
            <select
                id="voice-settings-engine"
                value=${value}
                onChange=${(event) => {
                    const next = event.currentTarget.value;

                    localStorage.setItem(ENGINE_KEY, next);
                    setValue(next);
                }}
            >
                <option value="mistral">Mistral · Voxtral Mini Transcribe 3</option>
                <option value="local">Local · Whisper (adaptive)</option>
            </select>
            <p class="muted small">${ABOUT[value]}</p>
            <p class="muted small">
                Recordings are held in memory and never written to disk. Only the text you keep
                reaches the message box; nothing is sent until you send it.
            </p>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "audio-settings", title: "Audio settings", component: AudioSettings });
    pocket.menu({ id: "audio-settings", label: "Audio settings", sheet: "audio-settings" });
    button = pocket.composerButton({
        id: "dictate",
        title: "Dictate a message",
        iconPath: MIC,
        run: tap,
    });

    return () => cancel();
}
