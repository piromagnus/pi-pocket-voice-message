// A clean machine: only the gallery's files, no Python environment and no model prepared. The extension builds
// its runtime with uv, downloads the small model, and transcribes. Slow: it installs and fetches once.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_POCKET = process.env.PI_POCKET_REPO ?? "/home/pmarrec/pi-pocket";
const { cleanUp, newSession, openApp, owner, root, scriptedModel } = await import(
    pathToFileURL(join(PI_POCKET, "test/helpers.ts")).href
);
const { createHandler } = await import(pathToFileURL(join(PI_POCKET, "src/server/http.ts")).href);

const source = fileURLToPath(new URL(".", import.meta.url));

test("clean install: the extension builds its Python runtime and transcribes with the small model", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    // Exactly what a gallery install copies: the module and its folder, nothing beside them.
    cpSync(join(source, "voice-message.ts"), join(dropIns, "voice-message.ts"));
    cpSync(join(source, "voice-message"), join(dropIns, "voice-message"), { recursive: true });
    assert.equal(existsSync(join(dropIns, "_voice-message")), false);
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );

    try {
        await app.setExtensionEnabled(owner(app), "voice-message.ts", true);
        await newSession(app);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
        const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
        const wav = readFileSync(join(source, "_voice-message", "fixtures", "french.wav")).toString(
            "base64",
        );
        const answer = await fetch(`${base}/api/x/voice-message/transcribe`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "Content-Type": "application/json",
                "X-Pocket": "1",
            },
            body: JSON.stringify({ audio: wav, mimeType: "audio/wav", engine: "local" }),
        });

        assert.equal(answer.status, 200);
        assert.deepEqual(await answer.json(), {
            text: "Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.",
            model: "whisper-small",
            device: "cpu",
            local: true,
        });
        assert.equal(existsSync(join(dropIns, "_voice-message", ".venv", "bin", "python")), true);
        assert.equal(
            existsSync(join(dropIns, "_voice-message", "models", "small", "model.bin")),
            true,
        );
        // A second call reuses the runtime: no new busy window, and the same answer.
        const again = await fetch(`${base}/api/x/voice-message/transcribe`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "Content-Type": "application/json",
                "X-Pocket": "1",
            },
            body: JSON.stringify({ audio: wav, mimeType: "audio/wav", engine: "local" }),
        });

        assert.equal(again.status, 200);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        cleanUp();
    }
});
