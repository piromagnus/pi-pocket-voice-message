export const pocketApi = 1;

const MIC =
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8";
const MAX_BYTES = 700_000;
const ENGINE_KEY = "x.voice-message.engine";
const PHASE = {
    idle: "Message",
    permission: "Autorise le microphone…",
    recording: "Enregistrement en cours…",
    transcribing: "Transcription en cours…",
    ready: "Message",
    error: "Message",
};

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;
    let current = null;

    if (typeof pocket.composerButton !== "function" || typeof pocket.insertText !== "function") {
        throw new Error("La dictée nécessite Pi Pocket 0.19 ou une version plus récente.");
    }

    const snapshot = (session) => ({
        text: session.text,
        phase: session.phase,
        error: session.error,
        engine: session.engine,
        model: session.model,
    });
    const publish = (session) => session.changed?.(snapshot(session));

    function release(session) {
        clearTimeout(session.timer);
        session.stream?.getTracks().forEach((track) => track.stop());
        session.stream = null;
    }

    function cancel(session) {
        if (!session) {
            return;
        }

        session.alive = false;
        session.changed = null;
        session.request.abort();

        if (session.recorder) {
            session.recorder.onstop = null;
            session.recorder.ondataavailable = null;
            session.recorder.onerror = null;

            if (session.recorder.state !== "inactive") {
                session.recorder.stop();
            }
        }

        release(session);
        session.chunks = [];

        if (current === session) {
            current = null;
        }
    }

    function fail(session, message) {
        if (!session.alive) {
            return;
        }

        if (session.recorder) {
            session.recorder.onstop = null;

            if (session.recorder.state !== "inactive") {
                session.recorder.stop();
            }
        }

        release(session);
        session.chunks = [];
        session.phase = "error";
        session.error = message;
        publish(session);
    }

    async function transcribe(session) {
        release(session);

        if (!session.alive || session.phase === "error") {
            return;
        }

        session.phase = "transcribing";
        publish(session);

        try {
            const blob = new Blob(session.chunks, { type: session.recorder.mimeType });

            session.chunks = [];

            if (!blob.size || blob.size > MAX_BYTES) {
                throw new Error(
                    "Enregistrement vide ou trop volumineux. Dicte un message plus court.",
                );
            }

            const bytes = new Uint8Array(await blob.arrayBuffer());
            const parts = [];

            for (let offset = 0; offset < bytes.length; offset += 8192) {
                parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
            }

            if (!session.alive) {
                return;
            }

            const result = await pocket.api(
                "transcribe",
                { audio: btoa(parts.join("")), mimeType: blob.type, engine: session.engine },
                { signal: session.request.signal },
            );

            if (!session.alive) {
                return;
            }

            if (typeof result.text !== "string" || result.text.length > 100_000) {
                throw new Error("Le moteur vocal n’a pas fourni de texte valide.");
            }

            session.text = result.text.trim();
            session.model =
                typeof result.model === "string" && typeof result.device === "string"
                    ? `${result.model} · ${result.device}`
                    : typeof result.model === "string"
                      ? result.model
                      : "";
            session.phase = "ready";
            session.error = session.text
                ? ""
                : "Aucune parole reconnue. Ferme cette fenêtre et réessaie.";
            publish(session);
        } catch (error) {
            fail(session, error.message || "La transcription a échoué.");
        }
    }

    function stop(session) {
        if (session.recorder?.state === "recording") {
            session.phase = "transcribing";
            publish(session);
            session.recorder.stop();
            release(session);
        }
    }

    function begin() {
        const conversationId = pocket.conversationId();
        const person = pocket.me();

        if (conversationId === null || !person || person.role === "viewer") {
            pocket.notify("warning", "Ouvre une conversation dans laquelle tu peux écrire.");

            return;
        }

        if (
            !globalThis.isSecureContext ||
            !navigator.mediaDevices?.getUserMedia ||
            typeof MediaRecorder !== "function"
        ) {
            pocket.notify(
                "error",
                "L’enregistrement nécessite HTTPS et un navigateur avec accès au microphone.",
            );

            return;
        }

        cancel(current);
        const session = {
            conversationId,
            personId: person.id,
            alive: true,
            text: "",
            phase: "idle",
            engine: localStorage.getItem(ENGINE_KEY) === "local" ? "local" : "mistral",
            error: "",
            stream: null,
            recorder: null,
            timer: null,
            chunks: [],
            request: new AbortController(),
            changed: null,
        };

        current = session;
        pocket.openSheet("dictation", { session });
    }

    async function record(session) {
        if (!session.alive || !["idle", "error"].includes(session.phase)) {
            return;
        }

        session.phase = "permission";
        session.error = "";
        session.text = "";
        session.chunks = [];
        session.recorder = null;
        publish(session);

        try {
            // Request microphone access in the Record button's user gesture.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            if (!session.alive || document.hidden) {
                stream.getTracks().forEach((track) => track.stop());
                fail(session, "Reviens dans cet onglet avant de démarrer l’enregistrement.");

                return;
            }

            session.stream = stream;
            const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(
                (type) => MediaRecorder.isTypeSupported(type),
            );
            const recorder = new MediaRecorder(stream, {
                ...(mimeType ? { mimeType } : {}),
                audioBitsPerSecond: 32_000,
            });
            let size = 0;

            session.recorder = recorder;
            recorder.ondataavailable = (event) => {
                if (!session.alive || session.phase === "error" || session.recorder !== recorder) {
                    return;
                }

                size += event.data.size;

                if (size > MAX_BYTES) {
                    fail(
                        session,
                        "L’enregistrement est trop volumineux. Dicte un message plus court.",
                    );

                    return;
                }

                session.chunks.push(event.data);
            };
            recorder.onstop = () => {
                if (session.recorder === recorder) {
                    transcribe(session);
                }
            };
            recorder.onerror = () => fail(session, "L’enregistrement du microphone a échoué.");
            recorder.start(1000);
            session.phase = "recording";
            session.timer = setTimeout(() => stop(session), 120_000);
            publish(session);
        } catch (error) {
            const message =
                error.name === "NotAllowedError"
                    ? "Autorise le microphone dans les réglages du navigateur."
                    : error.name === "NotFoundError"
                      ? "Aucun microphone disponible."
                      : "Impossible de démarrer l’enregistrement du microphone.";

            fail(session, message);
        }
    }

    function Dictation({ session, close }) {
        const [state, setState] = useState(() => snapshot(session));

        useEffect(() => {
            session.changed = setState;
            setState(snapshot(session));

            const hidden = () => {
                if (document.hidden) {
                    stop(session);
                }
            };
            const leave = () => cancel(session);

            document.addEventListener("visibilitychange", hidden);
            window.addEventListener("pagehide", leave);

            return () => {
                document.removeEventListener("visibilitychange", hidden);
                window.removeEventListener("pagehide", leave);
                cancel(session);
            };
        }, [session]);

        const insert = () => {
            if (
                !session.alive ||
                state.phase !== "ready" ||
                pocket.conversationId() !== session.conversationId ||
                pocket.me()?.id !== session.personId ||
                pocket.me()?.role === "viewer"
            ) {
                pocket.notify("warning", "La conversation a changé. Aucun texte inséré.");

                return;
            }

            if (state.text.trim()) {
                pocket.insertText(state.text.trim(), { inline: true });
            }
        };

        return html`<div class="voice-message">
            <select
                aria-label="Moteur de transcription"
                value=${state.engine}
                disabled=${!["idle", "error"].includes(state.phase)}
                onChange=${(event) => {
                    session.engine = event.currentTarget.value;
                    localStorage.setItem(ENGINE_KEY, session.engine);
                    publish(session);
                }}
            >
                <option value="mistral">Mistral · Voxtral Mini Transcribe 3</option>
                <option value="local">Local · Whisper (adaptatif)</option>
            </select>
            ${
                state.phase === "ready" &&
                state.model &&
                html`<p class="muted small">Transcrit par ${state.model}</p>`
            }
            <p class="muted small">
                ${
                    state.engine === "local"
                        ? "Audio traité sur le serveur Pi Pocket."
                        : "Audio envoyé à Mistral · 0,0035 $/min, sur tes crédits API."
                }
            </p>
            <label for="voice-message-text" aria-live="polite">${PHASE[state.phase]}</label>
            <textarea
                id="voice-message-text"
                aria-label="Message dicté"
                rows="7"
                maxlength="100000"
                value=${state.text}
                readonly=${state.phase !== "ready"}
                onInput=${(event) => setState({ ...state, text: event.currentTarget.value })}
            ></textarea>
            ${state.error && html`<div class="error-box" role="alert">${state.error}</div>`}
            <div class="voice-message-actions">
                <button
                    class="button"
                    onClick=${() => {
                        cancel(session);
                        close();
                    }}
                >
                    Annuler
                </button>
                ${
                    ["idle", "error"].includes(state.phase)
                        ? html`<button class="button primary" onClick=${() => record(session)}>
                              Enregistrer
                          </button>`
                        : state.phase === "recording"
                          ? html`<button class="button primary" onClick=${() => stop(session)}>
                                Arrêter
                            </button>`
                          : state.phase === "ready" &&
                            html`<button
                                class="button primary"
                                disabled=${!state.text.trim() || state.text.length > 100000}
                                onClick=${insert}
                            >
                                Insérer
                            </button>`
                }
            </div>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "dictation", title: "Message vocal", component: Dictation });
    pocket.composerButton({ id: "dictate", title: "Dicter un message", iconPath: MIC, run: begin });

    return () => cancel(current);
}
