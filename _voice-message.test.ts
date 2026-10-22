// Run: node --test ~/.pi-pocket/extensions/_voice-message.test.ts
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL(".", import.meta.url));
const PI_POCKET = process.env.PI_POCKET_REPO ?? "/home/pmarrec/pi-pocket";
const { cleanUp, newSession, openApp, owner, root, scriptedModel, until } = await import(
    pathToFileURL(join(PI_POCKET, "test/helpers.ts")).href
);
const { Browsers } = await import(pathToFileURL(join(PI_POCKET, "src/server/browser.ts")).href);
const { createHandler } = await import(pathToFileURL(join(PI_POCKET, "src/server/http.ts")).href);

test("local voice: real French audio, draft only, cancellation, access, errors and mobile", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(source, "voice-message.ts"), join(dropIns, "voice-message.ts"));
    cpSync(join(source, "voice-message"), join(dropIns, "voice-message"), { recursive: true });
    // Reuse the offline engine read-only; no copies of model weights or real application data.
    symlinkSync(join(source, "_voice-message"), join(dropIns, "_voice-message"));
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "voice-browser-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        await app.setExtensionEnabled(owner(app), "voice-message.ts", true);
        const session = await newSession(app);
        const other = await newSession(app);
        const guest = app.config.addUser("Guest", "guest");

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
        const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const run = async (script: string) => JSON.parse(await page.evaluate(script));
        const has = (selector: string) =>
            run(`return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`);
        const wait = (selector: string) => until(() => has(selector), selector);
        const settle = () => new Promise((resolve) => setTimeout(resolve, 650));
        const begin = async () => {
            await run(
                `document.querySelector('[title="Dicter un message"]').click(); return "null";`,
            );
            await wait("#voice-message-text");
            await settle();
            await button("Enregistrer");
            await settle();
        };
        const button = (text: string) =>
            run(`
            [...document.querySelectorAll('.voice-message button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click();
            return "null";
        `);
        const wav = readFileSync(join(source, "_voice-message", "fixtures", "french.wav")).toString(
            "base64",
        );
        const request = (body: unknown, token = app.config.ownerToken, withHeader = true) =>
            fetch(`${base}/api/x/voice-message/transcribe`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    ...(withHeader ? { "X-Pocket": "1" } : {}),
                },
                body: JSON.stringify(body),
            });

        assert.equal(
            (await request({ audio: wav, mimeType: "audio/wav" }, guest.token)).status,
            404,
        );
        assert.equal((await request({}, app.config.ownerToken, false)).status, 403);
        assert.equal((await request({ audio: "bogus", mimeType: "audio/wav" })).status, 400);
        assert.equal((await request({ audio: wav, mimeType: "text/html" })).status, 400);
        assert.equal(
            (await request({ audio: "A".repeat(1_000_001), mimeType: "audio/wav" })).status,
            413,
        );
        assert.equal(
            (
                await request({
                    audio: Buffer.alloc(32, 65).toString("base64"),
                    mimeType: "audio/wav",
                })
            ).status,
            400,
        );

        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
        );
        await wait('[title="Dicter un message"]');
        await run(`
            localStorage.setItem('x.voice-message.engine', 'local');
            globalThis.recorders = [];
            globalThis.tracks = [];
            globalThis.pendingPermission = null;
            globalThis.denyMicrophone = false;
            globalThis.delayPermission = false;
            globalThis.posted = [];
            const originalFetch = fetch;
            globalThis.fetch = (url, init) => {
                if (init?.method === 'POST') posted.push(String(url));
                return originalFetch(url, init);
            };
            const sample = Uint8Array.from(atob(${JSON.stringify(wav)}), c => c.charCodeAt(0));
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
                if (denyMicrophone) return Promise.reject(new DOMException('denied', 'NotAllowedError'));
                const track = { stopped: false, stop() { this.stopped = true; } };
                tracks.push(track);
                const stream = { getTracks: () => [track] };
                return delayPermission ? new Promise(resolve => { pendingPermission = () => resolve(stream); }) : Promise.resolve(stream);
            }});
            globalThis.MediaRecorder = class {
                static isTypeSupported() { return true; }
                constructor() { this.state = 'inactive'; this.mimeType = 'audio/wav'; recorders.push(this); }
                start() { this.state = 'recording'; }
                stop() {
                    this.state = 'inactive';
                    setTimeout(() => { this.ondataavailable?.({data: new Blob([sample], {type: 'audio/wav'})}); this.onstop?.(); }, 0);
                }
            };
            const { store } = await import('/store.js');
            globalThis.testStore = store;
            const field = document.querySelector('.composer textarea');
            field.value = 'Brouillon existant';
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return "null";
        `);
        await begin();
        assert.equal(await run("return JSON.stringify(recorders.at(-1).state);"), "recording");
        assert.equal(
            await run("return JSON.stringify(document.documentElement.scrollWidth <= innerWidth);"),
            true,
        );
        await button("Arrêter");
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
        await until(
            async () =>
                await run(
                    'return JSON.stringify(posted.some(url => url.endsWith("/transcribe")));',
                ),
            "transcription requested",
        );
        await settle();
        assert.equal((await request({ audio: wav, mimeType: "audio/wav" })).status, 429);
        await until(
            async () =>
                await run(
                    'return JSON.stringify([...document.querySelectorAll(".voice-message button")].some(b => b.textContent.trim() === "Insérer"));',
                ),
            "real local transcription",
            30_000,
        );
        assert.equal(
            await run(
                'return JSON.stringify(document.querySelector("#voice-message-text").value);',
            ),
            "Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.",
        );
        await until(
            async () =>
                await run(
                    'return JSON.stringify([...document.querySelectorAll(".voice-message p")].some((p) => /whisper-(large-v3-turbo|small)/.test(p.textContent)));',
                ),
            "model footer",
        );
        await run(
            'const field = document.querySelector("#voice-message-text"); field.value = "Message corrigé"; field.dispatchEvent(new Event("input", { bubbles: true })); return "null";',
        );
        await settle();
        await button("Insérer");
        await until(async () => !(await has("#voice-message-text")), "sheet closed");
        assert.equal(
            await run('return JSON.stringify(document.querySelector(".composer textarea").value);'),
            "Brouillon existant Message corrigé",
        );
        assert.equal(
            await run(
                'return JSON.stringify(posted.every(url => url.endsWith("/transcribe") || url.endsWith("/typing")));',
            ),
            true,
            await run("return JSON.stringify(posted);"),
        );
        assert.equal(await run("return JSON.stringify(testStore.state.view.live.busy);"), false);

        await settle();
        await begin();
        await button("Annuler");
        await until(async () => !(await has("#voice-message-text")), "cancel closed");
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
        assert.equal(
            await run('return JSON.stringify(document.querySelector(".composer textarea").value);'),
            "Brouillon existant Message corrigé",
        );
        await settle();
        await begin();
        await run(
            `const { navigate } = await import('/store.js'); navigate(${other}); return "null";`,
        );
        await until(async () => !(await has("#voice-message-text")), "navigation closes recording");
        await settle();
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);

        await run('globalThis.delayPermission = true; return "null";');
        await begin();
        await button("Annuler");
        await settle();
        await run('pendingPermission(); globalThis.delayPermission = false; return "null";');
        await until(
            async () => await run("return JSON.stringify(tracks.at(-1).stopped);"),
            "late permission releases mic",
        );
        await run('globalThis.denyMicrophone = true; return "null";');
        await begin();
        await wait('.voice-message [role="alert"]');
        assert.match(
            await run(
                'return JSON.stringify(document.querySelector(".voice-message [role=alert]").textContent);',
            ),
            /Autorise le microphone/,
        );
        await button("Annuler");
        await settle();
        await run('globalThis.denyMicrophone = false; return "null";');

        await begin();
        await button("Arrêter");
        await button("Annuler");
        await settle();
        // A cancelled worker must release the single-request lock.
        await until(
            async () =>
                (
                    await request({
                        audio: Buffer.alloc(32, 65).toString("base64"),
                        mimeType: "audio/wav",
                    })
                ).status === 400,
            "cancel releases worker",
        );
        await begin();
        await app.setExtensionEnabled(owner(app), "voice-message.ts", false);
        await until(async () => !(await has('[title="Dicter un message"]')), "extension removed");
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        cleanUp();
    }
});
