import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureVenv } from "../voice-message.ts";

const PYTHON = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BOOTSTRAP_LOG, JSON.stringify(["python", ...args]) + "\\n");
if (args[0] === "-c" && args[1] === "import faster_whisper, av") {
    const state = process.env.BOOTSTRAP_STATE;
    const count = Number(fs.existsSync(state) ? fs.readFileSync(state, "utf8") : 0) + 1;
    fs.writeFileSync(state, String(count));
    if (process.env.BOOTSTRAP_FAIL_FIRST_IMPORT === "1" && count === 1) process.exit(1);
}
`;
const UV = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BOOTSTRAP_LOG, JSON.stringify(["uv", ...args]) + "\\n");
if (args[0] === "pip" && process.env.BOOTSTRAP_DELAY_INSTALL === "1") {
    setTimeout(() => process.exit(0), 300);
}
`;

async function setup() {
    const root = await mkdtemp(join(tmpdir(), "voice-bootstrap-"));
    const runtime = join(root, "runtime");
    const bin = join(root, "bin");
    const python = join(runtime, ".venv", "bin", "python");
    const uv = join(bin, "uv");
    const log = join(root, "calls.log");
    const state = join(root, "python-state");
    const saved = {
        PATH: process.env.PATH,
        BOOTSTRAP_LOG: process.env.BOOTSTRAP_LOG,
        BOOTSTRAP_STATE: process.env.BOOTSTRAP_STATE,
        BOOTSTRAP_FAIL_FIRST_IMPORT: process.env.BOOTSTRAP_FAIL_FIRST_IMPORT,
        BOOTSTRAP_DELAY_INSTALL: process.env.BOOTSTRAP_DELAY_INSTALL,
    };

    await mkdir(join(runtime, ".venv", "bin"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(python, PYTHON);
    await chmod(python, 0o755);
    await writeFile(uv, UV);
    await chmod(uv, 0o755);
    process.env.PATH = bin;
    process.env.BOOTSTRAP_LOG = log;
    process.env.BOOTSTRAP_STATE = state;
    delete process.env.BOOTSTRAP_FAIL_FIRST_IMPORT;
    delete process.env.BOOTSTRAP_DELAY_INSTALL;

    return {
        root,
        runtime,
        python,
        log,
        state,
        restore: async () => {
            await rm(root, { recursive: true, force: true });

            for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
                const value = saved[key];

                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        },
    };
}

async function calls(path: string): Promise<string[][]> {
    try {
        return (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[]);
    } catch {
        return [];
    }
}

test("working venv writes the marker, then skips the import subprocess", async () => {
    const testEnv = await setup();

    try {
        assert.equal(
            await ensureVenv(testEnv.runtime, new AbortController().signal),
            testEnv.python,
        );
        assert.match(
            await readFile(join(testEnv.runtime, ".venv", ".ready"), "utf8"),
            /faster-whisper==/,
        );
        assert.equal((await calls(testEnv.log)).length, 1);

        await ensureVenv(testEnv.runtime, new AbortController().signal);
        assert.equal((await calls(testEnv.log)).length, 1);
    } finally {
        await testEnv.restore();
    }
});

test("incomplete interpreter installs through uv, verifies imports, then marks ready", async () => {
    const testEnv = await setup();

    try {
        process.env.BOOTSTRAP_FAIL_FIRST_IMPORT = "1";
        await ensureVenv(testEnv.runtime, new AbortController().signal);

        const recorded = await calls(testEnv.log);
        assert.equal(recorded.filter((call) => call[0] === "uv" && call[1] === "pip").length, 1);
        assert.equal(recorded.filter((call) => call[0] === "python" && call[1] === "-c").length, 2);
        assert.match(await readFile(join(testEnv.runtime, ".venv", ".ready"), "utf8"), /av==/);
    } finally {
        await testEnv.restore();
    }
});

test("cancelled install leaves no marker and a later call recovers", async () => {
    const testEnv = await setup();

    try {
        process.env.BOOTSTRAP_FAIL_FIRST_IMPORT = "1";
        process.env.BOOTSTRAP_DELAY_INSTALL = "1";
        const controller = new AbortController();
        const pending = ensureVenv(testEnv.runtime, controller.signal);
        setTimeout(() => controller.abort(), 60);
        await assert.rejects(pending);
        await assert.rejects(readFile(join(testEnv.runtime, ".venv", ".ready")));

        delete process.env.BOOTSTRAP_DELAY_INSTALL;
        await ensureVenv(testEnv.runtime, new AbortController().signal);
        assert.match(
            await readFile(join(testEnv.runtime, ".venv", ".ready"), "utf8"),
            /faster-whisper==/,
        );
        assert.equal(
            (await calls(testEnv.log)).filter((call) => call[0] === "uv" && call[1] === "pip")
                .length,
            1,
        );
    } finally {
        await testEnv.restore();
    }
});

test("concurrent setup calls share one import and install sequence", async () => {
    const testEnv = await setup();

    try {
        process.env.BOOTSTRAP_FAIL_FIRST_IMPORT = "1";
        const [first, second] = await Promise.all([
            ensureVenv(testEnv.runtime, new AbortController().signal),
            ensureVenv(testEnv.runtime, new AbortController().signal),
        ]);
        assert.equal(first, testEnv.python);
        assert.equal(second, testEnv.python);

        const recorded = await calls(testEnv.log);
        assert.equal(recorded.filter((call) => call[0] === "uv" && call[1] === "pip").length, 1);
        assert.equal(recorded.filter((call) => call[0] === "python" && call[1] === "-c").length, 2);
    } finally {
        await testEnv.restore();
    }
});
