// The Python engines, directly: the adaptive GPU pick, the light CPU pick, and the audio limits.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const source = fileURLToPath(new URL(".", import.meta.url));
const runtime = process.env.VOICE_TEST_RUNTIME ?? join(source, "_voice-message");
const python = join(runtime, ".venv", "bin", "python");
// The Python engines need this machine's prepared runtime; other machines get it at their first transcription.
const skip = existsSync(python)
    ? false
    : "no local Python runtime yet: run one local transcription first";
const script = join(source, "voice-message", "transcribe.py");
const french = readFileSync(join(source, "_voice-message", "fixtures", "french.wav"));
const REFERENCE =
    "Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.";

function transcribe(
    env: Record<string, string>,
    audio: Buffer,
): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(python, [script], {
            env: { ...process.env, VOICE_RUNTIME: runtime, ...env },
            stdio: ["pipe", "pipe", "ignore"],
        });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code: code ?? -1, output }));
        child.stdin.end(audio);
    });
}

test(
    "adaptive engine picks the GPU model when present",
    {
        skip:
            skip ||
            (process.env.VOICE_TEST_GPU !== "1" &&
                "Set VOICE_TEST_GPU=1 to test installed CUDA weights."),
    },
    async () => {
        const result = await transcribe({}, french);
        const parsed = JSON.parse(result.output);

        assert.equal(result.code, 0);
        assert.equal(parsed.model, "whisper-large-v3-turbo");
        assert.equal(parsed.device, "cuda");
        assert.equal(parsed.text, REFERENCE);
    },
);

test("light engine: the small model transcribes French on CPU", { skip }, async () => {
    const result = await transcribe({ VOICE_FORCE_LIGHT: "1" }, french);
    const parsed = JSON.parse(result.output);

    assert.equal(result.code, 0);
    assert.equal(parsed.model, "whisper-small");
    assert.equal(parsed.device, "cpu");
    assert.equal(parsed.text, REFERENCE);
});

test("the light engine still enforces the audio limits", { skip }, async () => {
    assert.equal((await transcribe({ VOICE_FORCE_LIGHT: "1" }, Buffer.alloc(8, 65))).code, 2);
});
