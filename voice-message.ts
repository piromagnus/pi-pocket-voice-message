/** Dictate a message: adaptive local Whisper (GPU, or a small CPU model for any machine) or Mistral Voxtral, inserted as a draft, never sent automatically. */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 1;
const MAX_BYTES = 700_000;
const TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]);
const MAX_TEXT = 100_000;
const MISTRAL_MODEL = "voxtral-mini-transcribe-3-0";
/** The Python engine and its one audio dependency, pinned. Keep `voice-message/requirements.lock` in step. */
const PINS = ["faster-whisper==1.2.1", "av==19.0.2"];

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
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"], signal });

        child.once("error", () => reject(new Error("missing")));
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("failed"))));
    });
}

/**
 * A Python environment with the local engine, beside the module in `_voice-message/`. Created at the first local
 * use with `uv`, or a plain `python3 -m venv`: the transcription works for anyone, not only this machine.
 */
export async function ensureVenv(runtime: string, signal: AbortSignal): Promise<string> {
    const venv = join(runtime, ".venv");
    const python = join(venv, "bin", "python");

    if (existsSync(python)) {
        return python;
    }

    mkdirSync(venv, { recursive: true });
    const uv = onPath("uv");

    if (uv !== undefined) {
        await run(uv, ["venv", "--python", "python3", venv], signal);
        await run(uv, ["pip", "install", "--python", python, ...PINS], signal);

        return python;
    }

    const python3 = onPath("python3");

    if (python3 !== undefined) {
        await run(python3, ["-m", "venv", venv], signal);
        await run(join(venv, "bin", "pip"), ["install", ...PINS], signal);

        return python;
    }

    throw new Error("no python tool");
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

export default function voiceMessage(host: Host, web: Web) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const runtime = join(moduleDir, "_voice-message");
    const script = join(moduleDir, "voice-message", "transcribe.py");
    const disposed = new AbortController();
    let running: ChildProcess | null = null;
    let busy = false;

    web.onDispose(() => {
        disposed.abort();
        running?.kill("SIGKILL");
    });
    web.client("voice-message");
    web.route(
        "POST",
        "transcribe",
        async ({ body, signal }) => {
            const engine = body.engine === undefined ? "local" : body.engine;

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

            if (busy) {
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
                    form.set("language", "fr");

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

                    try {
                        responseText = await response.text();
                    } catch {
                        throw web.error(502, "Mistral returned an invalid transcription response.");
                    }

                    if (responseText.length > MAX_TEXT + 10_000) {
                        throw web.error(502, "The Mistral transcription response is too long.");
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

                    return { text, model: MISTRAL_MODEL, local: false };
                }

                let python: string;

                try {
                    python = await ensureVenv(runtime, stop);
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

                return await new Promise((resolve, reject) => {
                    const child = spawn(python, [script], {
                        stdio: ["pipe", "pipe", "pipe"],
                        env: {
                            ...process.env,
                            VOICE_RUNTIME: runtime,
                            HF_HUB_DISABLE_TELEMETRY: "1",
                        },
                    });
                    let output = "";
                    const abort = () => child.kill("SIGKILL");

                    running = child;
                    stop.addEventListener("abort", abort, { once: true });
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
}
