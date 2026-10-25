/** Dictate a message: words appear in the message box while you speak and a full pass corrects them when you stop; nothing is sent automatically and your edits are never overwritten. Mistral engines send audio to api.mistral.ai (Voxtral Realtime 3, then Mini Transcribe 3; key read only on the server from MISTRAL_API_KEY or Pi's mistral auth.json entry). Local Whisper keeps audio on the server; its first use installs pinned packages from PyPI with enforced hashes and the revision-pinned Whisper small model from huggingface.co, about 900 MB. French is pinned; VOICE_MESSAGE_LANGUAGE overrides. */ import {
    spawn,
    type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 1;
const MAX_BYTES = 700_000;
const TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]);
const MAX_TEXT = 100_000;
const MISTRAL_MODEL = "voxtral-mini-transcribe-3-0";
const MISTRAL_REALTIME_MODEL = "voxtral-mini-transcribe-realtime-3";
const DEFAULT_REALTIME_URL = `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${MISTRAL_REALTIME_MODEL}`;
const MAX_REALTIME_CHUNK_BYTES = 64 * 1024;
const MAX_REALTIME_TOTAL_BYTES = 5 * 60 * 16_000 * 2; // 5 minutes of 16kHz 16-bit mono PCM (9,600,000 bytes)
const START_TIMEOUT_MS = 10_000;
const END_TIMEOUT_MS = 20_000;
/** The Python engine and its one audio dependency, pinned. Keep `voice-message/requirements.lock` in step. */
const venvs = new Map<string, Promise<string>>();

/**
 * Test seam: allows routing realtime WebSocket connections to a local test server.
 * Strictly restricted to ws://127.0.0.1 or wss://127.0.0.1 to prevent any external host override.
 */
function realtimeUrl(): string {
    const override = process.env.VOICE_MESSAGE_REALTIME_URL?.trim();

    if (override) {
        try {
            const url = new URL(override);

            if (
                (url.protocol === "ws:" || url.protocol === "wss:") &&
                url.hostname === "127.0.0.1"
            ) {
                return override;
            }
        } catch {
            // Invalid URL: fallback to default.
        }
    }

    return DEFAULT_REALTIME_URL;
}

/** How long a live session may stay silent: 30 s, or a test's shorter value. A bad value never means "at once". */
function idleTimeout(): number {
    const value = Number(process.env.VOICE_MESSAGE_IDLE_TIMEOUT_MS);

    return Number.isFinite(value) && value >= 50 ? value : 30_000;
}

/**
 * Node's own WebSocket (undici) takes request headers in its second argument, which the DOM typings do not know.
 * Checked against the real service: with the header the session opens, without it the connection is refused.
 */
const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
) => WebSocket;

interface LiveSession {
    readonly sessionId: string;
    readonly userId: string;
    readonly ws: WebSocket;
    nextSeq: number;
    totalBytes: number;
    idleTimer: NodeJS.Timeout | null;
    deltaSeq: number;
    cleanup: () => void;
    finishPromise?: {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
    };
    cleanedUp: boolean;
    /** Whether this session holds the one-at-a-time lock: taken before the handshake, so a failed start must free it. */
    holdsLock: boolean;
}

/** The first file found on PATH named `name`, or undefined. */
function onPath(name: string): string | undefined {
    for (const folder of (process.env.PATH ?? "").split(":")) {
        if (!folder) {
            continue;
        }

        const file = join(folder, name);

        try {
            accessSync(file, constants.X_OK);

            return file;
        } catch {
            // Not there: keep looking.
        }
    }

    return undefined;
}

/** Run a setup command, printing nothing from it: its words can quote the machine's folders. */
function run(command: string, args: string[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "ignore", "ignore"],
            signal,
        });

        child.once("error", () => reject(new Error("missing")));
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("failed"))));
    });
}

/**
 * A Python environment with the local engine, beside the module in `_voice-message/`. Created at the first local
 * use with `uv`, or a plain `python3 -m venv`: the transcription works for anyone, not only this machine.
 */
export async function ensureVenv(
    runtime: string,
    lock: string,
    signal: AbortSignal,
): Promise<string> {
    const pending = venvs.get(runtime);

    if (pending !== undefined) {
        return pending;
    }

    const setup = setupVenv(runtime, lock, signal).finally(() => venvs.delete(runtime));

    venvs.set(runtime, setup);

    return setup;
}

async function setupVenv(runtime: string, lock: string, signal: AbortSignal): Promise<string> {
    const venv = join(runtime, ".venv");
    const python = join(venv, "bin", "python");
    const marker = join(venv, ".ready");
    // The marker is the lock's own SHA-256: a new lock re-installs, and a stale install never passes for a fresh one.
    const stamp = createHash("sha256").update(readFileSync(lock)).digest("hex");

    if (existsSync(python) && existsSync(marker) && readFileSync(marker, "utf8") === stamp) {
        return python;
    }

    if (existsSync(python)) {
        try {
            await run(python, ["-c", "import faster_whisper, av"], signal);
            writeFileSync(marker, stamp);

            return python;
        } catch {
            // A cancelled or incomplete installation can leave the interpreter behind.
        }
    }

    mkdirSync(venv, { recursive: true });
    const uv = onPath("uv");

    if (uv !== undefined) {
        if (!existsSync(python)) {
            await run(uv, ["venv", "--python", "python3", venv], signal);
        }

        await run(
            uv,
            ["pip", "install", "--python", python, "--require-hashes", "-r", lock],
            signal,
        );
    } else if (existsSync(python)) {
        await run(python, ["-m", "pip", "install", "--require-hashes", "-r", lock], signal);
    } else {
        const python3 = onPath("python3");

        if (python3 === undefined) {
            throw new Error("no python tool");
        }

        await run(python3, ["-m", "venv", venv], signal);
        await run(join(venv, "bin", "pip"), ["install", "--require-hashes", "-r", lock], signal);
    }

    await run(python, ["-c", "import faster_whisper, av"], signal);
    writeFileSync(marker, stamp);

    return python;
}

async function mistralKey(agentDir: string): Promise<string> {
    const environmentKey = process.env.MISTRAL_API_KEY?.trim();

    if (environmentKey) {
        if (environmentKey.startsWith("!") || /[\r\n]/.test(environmentKey)) {
            throw new Error("Mistral credentials are unavailable.");
        }

        return environmentKey;
    }

    let credential: unknown;

    try {
        const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as {
            mistral?: unknown;
        };
        credential = auth.mistral;
    } catch {
        throw new Error("Mistral credentials are unavailable.");
    }

    if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
        throw new Error("Mistral credentials are unavailable.");
    }

    const entry = credential as { type?: unknown; key?: unknown };

    if (entry.type !== "api_key" || typeof entry.key !== "string") {
        throw new Error("Mistral credentials are unavailable.");
    }

    const configured = entry.key.trim();

    if (!configured || configured.startsWith("!") || /[\r\n]/.test(configured)) {
        throw new Error("Mistral credentials are unavailable.");
    }

    const reference =
        configured.match(/^\$(?:([A-Z_][A-Z0-9_]*)|\{([A-Z_][A-Z0-9_]*)\})$/)?.[0] ??
        (/^[A-Z_][A-Z0-9_]*$/.test(configured) ? configured : undefined);

    if (reference !== undefined) {
        const name = reference.replace(/^\$|\{|\}/g, "");
        const key = process.env[name]?.trim();

        if (key && !key.startsWith("!") && !/[\r\n]/.test(key)) {
            return key;
        }

        throw new Error("Mistral credentials are unavailable.");
    }

    if (configured.startsWith("$")) {
        throw new Error("Mistral credentials are unavailable.");
    }

    return configured;
}

/** The transcription language: ISO 639 (2 or 3 lowercase letters), French by default. */
function language(): string {
    const value = process.env.VOICE_MESSAGE_LANGUAGE?.trim().toLowerCase();

    return /^[a-z]{2,3}$/.test(value ?? "") ? value! : "fr";
}

export default function voiceMessage(host: Host, web: Web) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const runtime = join(moduleDir, "_voice-message");
    const script = join(moduleDir, "voice-message", "transcribe.py");
    const lock = join(moduleDir, "voice-message", "requirements.lock");
    const lang = language();
    const disposed = new AbortController();
    let running: ChildProcess | null = null;
    let busy = false;
    let currentLiveSession: LiveSession | null = null;

    web.onDispose(() => {
        disposed.abort();
        running?.kill("SIGKILL");
        currentLiveSession?.cleanup();
    });
    web.client("voice-message");
    web.route(
        "POST",
        "transcribe",
        async ({ body, signal }) => {
            const engine = body.engine === undefined ? "local" : body.engine;
            const phase = body.phase === undefined ? "final" : body.phase;

            if (phase !== "preview" && phase !== "final") {
                throw web.error(400, "Invalid transcription phase.");
            }

            if (engine !== "local" && engine !== "mistral") {
                throw web.error(400, "Invalid transcription engine.");
            }

            if (
                typeof body.audio !== "string" ||
                body.audio.length > Math.ceil(MAX_BYTES / 3) * 4 ||
                !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio) ||
                typeof body.mimeType !== "string" ||
                !TYPES.has(body.mimeType.split(";", 1)[0].trim())
            ) {
                throw web.error(400, "Invalid audio format, or a recording that is too large.");
            }

            const audio = Buffer.from(body.audio, "base64");

            if (
                audio.length < 16 ||
                audio.length > MAX_BYTES ||
                audio.toString("base64") !== body.audio
            ) {
                throw web.error(400, "Invalid audio format, or a recording that is too large.");
            }

            if (busy || currentLiveSession !== null) {
                throw web.error(429, "A transcription is already running. Try again in a moment.");
            }

            busy = true;

            try {
                // The local engine may build its Python environment and fetch its small model at first use.
                const stop = AbortSignal.any([
                    signal,
                    disposed.signal,
                    AbortSignal.timeout(engine === "local" ? 290_000 : 90_000),
                ]);

                if (stop.aborted) {
                    throw web.error(408, "The transcription was cancelled.");
                }

                if (engine === "mistral") {
                    let key: string;

                    try {
                        key = await mistralKey(host.agentDir);
                    } catch {
                        throw web.error(
                            503,
                            "No Mistral API key is configured. Set MISTRAL_API_KEY, or pick the local engine in Audio settings.",
                        );
                    }

                    if (stop.aborted) {
                        throw web.error(408, "The transcription was cancelled.");
                    }

                    const form = new FormData();
                    const mimeType = body.mimeType.split(";", 1)[0].trim();
                    const extension = mimeType.split("/", 2)[1];
                    form.set(
                        "file",
                        new File([new Uint8Array(audio)], `recording.${extension}`, {
                            type: mimeType,
                        }),
                    );
                    form.set("model", MISTRAL_MODEL);
                    form.set("language", lang);

                    let response: Response;

                    try {
                        response = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
                            method: "POST",
                            headers: { Authorization: `Bearer ${key}` },
                            body: form,
                            signal: stop,
                            redirect: "error",
                        });
                    } catch {
                        throw web.error(
                            stop.aborted ? 408 : 502,
                            stop.aborted
                                ? "The transcription was cancelled or timed out."
                                : "The request to the Mistral transcription API failed.",
                        );
                    }

                    if (!response.ok) {
                        throw web.error(
                            502,
                            `Mistral transcription failed (HTTP ${response.status}).`,
                        );
                    }

                    let responseText: string;
                    const reader = response.body?.getReader();

                    if (reader === undefined) {
                        throw web.error(502, "Mistral returned an invalid transcription response.");
                    }

                    const chunks: Uint8Array[] = [];
                    let size = 0;

                    try {
                        while (true) {
                            const chunk = await reader.read();

                            if (chunk.done) {
                                break;
                            }

                            size += chunk.value.byteLength;

                            if (size > MAX_TEXT + 10_000) {
                                throw web.error(
                                    502,
                                    "The Mistral transcription response is too long.",
                                );
                            }

                            chunks.push(chunk.value);
                        }

                        if (stop.aborted) {
                            throw web.error(408, "The transcription was cancelled or timed out.");
                        }

                        responseText = new TextDecoder().decode(
                            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
                        );
                    } catch (error) {
                        if (error && typeof error === "object" && "status" in error) {
                            throw error;
                        }

                        throw web.error(
                            stop.aborted ? 408 : 502,
                            stop.aborted
                                ? "The transcription was cancelled or timed out."
                                : "Mistral returned an invalid transcription response.",
                        );
                    } finally {
                        await reader.cancel().catch(() => {});
                    }

                    let result: unknown;

                    try {
                        result = JSON.parse(responseText);
                    } catch {
                        throw web.error(502, "Mistral returned an invalid transcription response.");
                    }

                    const text =
                        result && typeof result === "object" && "text" in result
                            ? result.text
                            : undefined;

                    if (typeof text !== "string" || text.length > MAX_TEXT) {
                        throw web.error(502, "Mistral returned an invalid transcription response.");
                    }

                    if (stop.aborted) {
                        throw web.error(408, "The transcription was cancelled or timed out.");
                    }

                    return { text, model: MISTRAL_MODEL, local: false };
                }

                let python: string;

                try {
                    python = await ensureVenv(runtime, lock, stop);
                } catch (error) {
                    if (stop.aborted) {
                        throw web.error(408, "The transcription was cancelled.");
                    }

                    throw web.error(
                        503,
                        `The local engine could not prepare Python (${
                            error instanceof Error ? error.message : "error"
                        }). Install uv or python3-venv, then try again.`,
                    );
                }

                if (stop.aborted) {
                    throw web.error(408, "The transcription was cancelled.");
                }

                return await new Promise((resolve, reject) => {
                    const child = spawn(python, [script], {
                        stdio: ["pipe", "pipe", "pipe"],
                        env: {
                            ...process.env,
                            VOICE_RUNTIME: runtime,
                            VOICE_LANGUAGE: lang,
                            ...(phase === "preview"
                                ? { VOICE_FORCE_LIGHT: "1", VOICE_PREVIEW: "1" }
                                : {}),
                            HF_HUB_DISABLE_TELEMETRY: "1",
                        },
                    });
                    let output = "";
                    const abort = () => child.kill("SIGKILL");

                    running = child;
                    stop.addEventListener("abort", abort, { once: true });

                    if (stop.aborted) {
                        abort();
                    }

                    child.stdin.on("error", () => {});
                    child.stderr.resume();
                    child.stdout.on("data", (chunk: Buffer) => {
                        output += chunk.toString();

                        if (output.length > MAX_TEXT) {
                            child.kill("SIGKILL");
                        }
                    });
                    child.once("error", () => {
                        reject(web.error(503, "The Whisper engine is unavailable."));
                    });
                    child.once("close", (code) => {
                        stop.removeEventListener("abort", abort);

                        if (running === child) {
                            running = null;
                        }

                        if (stop.aborted) {
                            reject(web.error(408, "The transcription was cancelled or timed out."));

                            return;
                        }

                        try {
                            const result = JSON.parse(output) as {
                                text?: unknown;
                                model?: unknown;
                                device?: unknown;
                                error?: string;
                            };

                            if (code === 2) {
                                reject(
                                    web.error(
                                        400,
                                        result.error === "too_long"
                                            ? "The voice message exceeds the 5-minute limit."
                                            : "The audio recording is unreadable.",
                                    ),
                                );
                            } else if (
                                code !== 0 ||
                                typeof result.text !== "string" ||
                                result.text.length > MAX_TEXT ||
                                (result.model !== undefined && typeof result.model !== "string") ||
                                (result.device !== undefined && typeof result.device !== "string")
                            ) {
                                reject(
                                    web.error(
                                        503,
                                        "Whisper local is unavailable. Check the GPU, the model, or the Python installation.",
                                    ),
                                );
                            } else {
                                resolve({
                                    text: result.text,
                                    model: typeof result.model === "string" ? result.model : "",
                                    device: typeof result.device === "string" ? result.device : "",
                                    local: true,
                                });
                            }
                        } catch {
                            reject(
                                web.error(503, "The local engine returned no valid transcription."),
                            );
                        }
                    });
                    child.stdin.end(audio);
                });
            } finally {
                busy = false;
            }
        },
        { access: "owner" },
    );

    web.route(
        "POST",
        "live/start",
        async ({ body, signal, user }) => {
            const userId = user?.id ?? "owner";

            if (
                typeof body.sessionId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    body.sessionId,
                )
            ) {
                throw web.error(400, "Invalid session ID.");
            }

            if (busy || currentLiveSession !== null) {
                throw web.error(429, "A transcription is already running. Try again in a moment.");
            }

            let key: string;

            try {
                key = await mistralKey(host.agentDir);
            } catch {
                throw web.error(
                    503,
                    "No Mistral API key is configured. Set MISTRAL_API_KEY, or pick the local engine in Audio settings.",
                );
            }

            // The key was read asynchronously: another start may have taken the lock meanwhile.
            if (busy || currentLiveSession !== null) {
                throw web.error(429, "A transcription is already running. Try again in a moment.");
            }

            busy = true;
            const targetUrl = realtimeUrl();

            let ws: WebSocket;

            try {
                ws = new NodeWebSocket(targetUrl, {
                    headers: { Authorization: `Bearer ${key}` },
                });
            } catch {
                busy = false;

                throw web.error(502, "The Mistral realtime connection failed.");
            }

            const idleTimeoutMs = idleTimeout();

            const session: LiveSession = {
                sessionId: body.sessionId,
                userId,
                ws,
                nextSeq: 0,
                totalBytes: 0,
                idleTimer: null,
                deltaSeq: 0,
                cleanup: () => {
                    if (session.cleanedUp) {
                        return;
                    }

                    session.cleanedUp = true;

                    if (session.idleTimer !== null) {
                        clearTimeout(session.idleTimer);
                        session.idleTimer = null;
                    }

                    try {
                        if (
                            ws.readyState === WebSocket.OPEN ||
                            ws.readyState === WebSocket.CONNECTING
                        ) {
                            ws.close();
                        }
                    } catch {
                        // Ignore close error.
                    }

                    if (currentLiveSession === session) {
                        currentLiveSession = null;
                    }

                    if (session.holdsLock) {
                        session.holdsLock = false;
                        busy = false;
                    }
                },
                cleanedUp: false,
                holdsLock: true,
            };

            const resetIdleTimer = () => {
                if (session.idleTimer !== null) {
                    clearTimeout(session.idleTimer);
                }

                session.idleTimer = setTimeout(() => {
                    if (!session.cleanedUp) {
                        web.send(
                            "live",
                            { sessionId: session.sessionId, kind: "closed" },
                            { to: session.userId },
                        );
                        session.cleanup();
                    }
                }, idleTimeoutMs);
            };

            const signals = [disposed.signal, AbortSignal.timeout(START_TIMEOUT_MS)];

            if (signal) {
                signals.push(signal);
            }

            const stop = AbortSignal.any(signals);

            try {
                await new Promise<void>((resolve, reject) => {
                    let settled = false;

                    const onAbort = () => {
                        if (!settled) {
                            settled = true;
                            reject(
                                web.error(
                                    stop.aborted ? 408 : 502,
                                    "The realtime session timed out or was cancelled.",
                                ),
                            );
                        }
                    };

                    stop.addEventListener("abort", onAbort, { once: true });

                    const onOpen = () => {
                        try {
                            ws.send(
                                JSON.stringify({
                                    type: "session.update",
                                    session: {
                                        audio_format: {
                                            encoding: "pcm_s16le",
                                            sample_rate: 16000,
                                        },
                                        target_streaming_delay_ms: 480,
                                        language: lang,
                                    },
                                }),
                            );
                        } catch {
                            if (!settled) {
                                settled = true;
                                stop.removeEventListener("abort", onAbort);
                                reject(web.error(502, "The Mistral realtime connection failed."));
                            }
                        }
                    };

                    if (ws.readyState === WebSocket.OPEN) {
                        onOpen();
                    } else {
                        ws.addEventListener("open", onOpen, { once: true });
                    }

                    const onMessage = (event: MessageEvent) => {
                        let data: unknown;

                        try {
                            data = JSON.parse(
                                typeof event.data === "string" ? event.data : event.data.toString(),
                            );
                        } catch {
                            return;
                        }

                        if (!data || typeof data !== "object") {
                            return;
                        }

                        const msg = data as { type?: unknown; text?: unknown };

                        if (msg.type === "session.updated") {
                            if (!settled) {
                                settled = true;
                                stop.removeEventListener("abort", onAbort);
                                resolve();
                            }
                        } else if (msg.type === "transcription.text.delta") {
                            if (typeof msg.text === "string" && !session.cleanedUp) {
                                const seq = session.deltaSeq++;
                                web.send(
                                    "live",
                                    {
                                        sessionId: session.sessionId,
                                        kind: "delta",
                                        text: msg.text,
                                        seq,
                                    },
                                    { to: session.userId },
                                );
                            }
                        } else if (msg.type === "transcription.done") {
                            if (session.finishPromise) {
                                const text = typeof msg.text === "string" ? msg.text : "";
                                session.finishPromise.resolve(text);
                            }
                        } else if (msg.type === "error") {
                            if (!settled) {
                                settled = true;
                                stop.removeEventListener("abort", onAbort);
                                reject(web.error(502, "Mistral realtime transcription failed."));
                            } else if (!session.cleanedUp) {
                                web.send(
                                    "live",
                                    { sessionId: session.sessionId, kind: "error" },
                                    { to: session.userId },
                                );

                                if (session.finishPromise) {
                                    session.finishPromise.reject(
                                        web.error(502, "Mistral realtime transcription failed."),
                                    );
                                }

                                session.cleanup();
                            }
                        }
                    };

                    const onError = () => {
                        if (!settled) {
                            settled = true;
                            stop.removeEventListener("abort", onAbort);
                            reject(web.error(502, "The Mistral realtime connection failed."));
                        } else if (!session.cleanedUp) {
                            web.send(
                                "live",
                                { sessionId: session.sessionId, kind: "error" },
                                { to: session.userId },
                            );

                            if (session.finishPromise) {
                                session.finishPromise.reject(
                                    web.error(502, "The Mistral realtime connection failed."),
                                );
                            }

                            session.cleanup();
                        }
                    };

                    const onClose = () => {
                        if (!settled) {
                            settled = true;
                            stop.removeEventListener("abort", onAbort);
                            reject(web.error(502, "The Mistral realtime connection was closed."));
                        } else if (!session.cleanedUp) {
                            web.send(
                                "live",
                                { sessionId: session.sessionId, kind: "closed" },
                                { to: session.userId },
                            );

                            if (session.finishPromise) {
                                session.finishPromise.reject(
                                    web.error(502, "The Mistral realtime connection was closed."),
                                );
                            }

                            session.cleanup();
                        }
                    };

                    ws.addEventListener("message", onMessage);
                    ws.addEventListener("error", onError);
                    ws.addEventListener("close", onClose);
                });

                currentLiveSession = session;
                resetIdleTimer();

                return { ok: true };
            } catch (error) {
                session.cleanup();
                throw error;
            }
        },
        { access: "owner" },
    );

    web.route(
        "POST",
        "live/audio",
        async ({ body, user }) => {
            const userId = user?.id ?? "owner";

            if (
                !currentLiveSession ||
                typeof body.sessionId !== "string" ||
                currentLiveSession.sessionId !== body.sessionId ||
                currentLiveSession.userId !== userId
            ) {
                throw web.error(404, "Session not found.");
            }

            const session = currentLiveSession;

            if (typeof body.seq !== "number" || !Number.isInteger(body.seq)) {
                throw web.error(400, "Invalid sequence number.");
            }

            if (body.seq !== session.nextSeq) {
                throw web.error(409, "Out of order sequence number.");
            }

            if (typeof body.audio !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) {
                throw web.error(400, "Invalid audio chunk.");
            }

            const buffer = Buffer.from(body.audio, "base64");

            if (
                buffer.length === 0 ||
                buffer.length > MAX_REALTIME_CHUNK_BYTES ||
                buffer.toString("base64") !== body.audio
            ) {
                throw web.error(400, "Audio chunk exceeds limit or is malformed.");
            }

            if (session.totalBytes + buffer.length > MAX_REALTIME_TOTAL_BYTES) {
                throw web.error(400, "The voice message exceeds the 5-minute limit.");
            }

            session.nextSeq++;
            session.totalBytes += buffer.length;

            try {
                session.ws.send(JSON.stringify({ type: "input_audio.append", audio: body.audio }));
            } catch {
                session.cleanup();

                throw web.error(502, "Failed to send audio to Mistral realtime.");
            }

            if (session.idleTimer !== null) {
                clearTimeout(session.idleTimer);
            }

            const idleTimeoutMs = idleTimeout();

            session.idleTimer = setTimeout(() => {
                if (!session.cleanedUp) {
                    web.send(
                        "live",
                        { sessionId: session.sessionId, kind: "closed" },
                        { to: session.userId },
                    );
                    session.cleanup();
                }
            }, idleTimeoutMs);

            return { ok: true };
        },
        { access: "owner" },
    );

    web.route(
        "POST",
        "live/end",
        async ({ body, signal, user }) => {
            const userId = user?.id ?? "owner";

            if (
                !currentLiveSession ||
                typeof body.sessionId !== "string" ||
                currentLiveSession.sessionId !== body.sessionId ||
                currentLiveSession.userId !== userId
            ) {
                throw web.error(404, "Session not found.");
            }

            const session = currentLiveSession;

            if (session.idleTimer !== null) {
                clearTimeout(session.idleTimer);
                session.idleTimer = null;
            }

            const signals = [disposed.signal, AbortSignal.timeout(END_TIMEOUT_MS)];

            if (signal) {
                signals.push(signal);
            }

            const stop = AbortSignal.any(signals);

            if (stop.aborted) {
                session.cleanup();

                throw web.error(408, "The transcription was cancelled or timed out.");
            }

            try {
                session.ws.send(JSON.stringify({ type: "input_audio.end" }));
            } catch {
                session.cleanup();

                throw web.error(502, "Failed to end realtime audio stream.");
            }

            const text = await new Promise<string>((resolve, reject) => {
                const onAbort = () => {
                    session.cleanup();
                    reject(
                        web.error(
                            stop.aborted ? 408 : 502,
                            "The transcription was cancelled or timed out.",
                        ),
                    );
                };

                stop.addEventListener("abort", onAbort, { once: true });

                session.finishPromise = {
                    resolve: (transcript) => {
                        stop.removeEventListener("abort", onAbort);
                        resolve(transcript);
                    },
                    reject: (err) => {
                        stop.removeEventListener("abort", onAbort);
                        reject(err);
                    },
                };
            });

            session.cleanup();

            return { text };
        },
        { access: "owner" },
    );

    web.route(
        "POST",
        "live/cancel",
        async ({ body, user }) => {
            const userId = user?.id ?? "owner";

            if (
                currentLiveSession &&
                typeof body.sessionId === "string" &&
                currentLiveSession.sessionId === body.sessionId
            ) {
                if (currentLiveSession.userId !== userId) {
                    throw web.error(404, "Session not found.");
                }

                currentLiveSession.cleanup();
            }

            return { ok: true };
        },
        { access: "owner" },
    );
}
