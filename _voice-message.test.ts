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

const REFERENCE =
    "Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.";

test("voice: record straight into the message box, draft only, settings, cancellation, mobile", async () => {
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
        const has = async (selector: string) =>
            (await run(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`,
            )) === true;
        const wait = (selector: string) => until(async () => await has(selector), selector);
        const bodyHas = async (text: string) =>
            (await run(
                `return JSON.stringify(document.body.textContent.includes(${JSON.stringify(text)}));`,
            )) === true;
        const says = (text: string) => until(async () => await bodyHas(text), `page says ${text}`);
        const gone = (text: string) =>
            until(async () => !(await bodyHas(text)), `page no longer says ${text}`);
        const settle = () => new Promise((resolve) => setTimeout(resolve, 650));
        const tap = async (title: string) => {
            await wait(`[title=${JSON.stringify(title)}]`);
            await run(
                `document.querySelector('[title=${JSON.stringify(title)}]').click(); return "null";`,
            );
        };
        const notices = () =>
            run(
                'return JSON.stringify([...document.querySelectorAll(".notice")].map((n) => n.textContent.trim()));',
            );
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
        await wait('[title="Dictate a message"]');
        await run(`
            localStorage.setItem('x.voice-message.engine', 'local');
            globalThis.recorders = [];
            globalThis.tracks = [];
            globalThis.denyMicrophone = false;
            globalThis.posted = [];
            const originalFetch = fetch;
            globalThis.fetch = (url, init) => {
                if (init?.method === 'POST') posted.push(String(url));
                return originalFetch(url, init);
            };
            const sample = Uint8Array.from(atob(${JSON.stringify(wav)}), c => c.charCodeAt(0));
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
                if (denyMicrophone) return Promise.reject(new DOMException('denied', 'NotAllowedError'));
                const track = { stopped: false, readyState: 'live', stop() { this.stopped = true; this.readyState = 'ended'; } };
                tracks.push(track);
                return Promise.resolve({ getTracks: () => [track] });
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
            field.value = 'Existing draft';
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return "null";
        `);
        assert.equal(
            await run("return JSON.stringify(document.documentElement.scrollWidth <= innerWidth);"),
            true,
        );

        // One tap records, without any popup; the status line says so.
        await tap("Dictate a message");
        assert.equal(await run("return JSON.stringify(recorders.at(-1).state);"), "recording");
        await says("Recording…");
        assert.equal(await has(".voice-settings"), false);
        // A second tap stops, and the transcript lands in the message box itself, to edit and send by hand.
        await tap("Stop dictation");
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
        await says("Transcribing…");
        await until(
            async () =>
                (await run(
                    'return JSON.stringify(document.querySelector(".composer textarea").value);',
                )) === `Existing draft ${REFERENCE}`,
            "the transcript in the message box",
            30_000,
        );
        assert.equal(
            await run('return JSON.stringify(document.querySelector(".composer textarea").value);'),
            `Existing draft ${REFERENCE}`,
        );
        await gone("Transcribing…");
        await wait('[title="Dictate a message"]');
        assert.equal(await run("return JSON.stringify(testStore.state.view.live.busy);"), false);
        assert.equal(
            await run(
                'return JSON.stringify(posted.every((url) => url.endsWith("/transcribe") || url.endsWith("/typing")));',
            ),
            true,
        );

        // Recording into one conversation, then opening another: nothing is inserted anywhere.
        await settle();
        await tap("Dictate a message");
        await run(
            `const { navigate } = await import('/store.js'); navigate(${other}); return "null";`,
        );
        await tap("Stop dictation");
        await until(
            async () => (await notices()).length > 0,
            "a warning about the conversation",
            30_000,
        );
        assert.match(JSON.stringify(await notices()), /The conversation changed/);
        assert.equal(
            await run('return JSON.stringify(document.querySelector(".composer textarea").value);'),
            "",
        );

        // A blocked microphone says so, and the button comes back.
        await settle();
        await run('globalThis.denyMicrophone = true; return "null";');
        await tap("Dictate a message");
        await until(async () => (await notices()).length > 0, "a microphone warning");
        assert.match(JSON.stringify(await notices()), /Allow the microphone/);
        await run('globalThis.denyMicrophone = false; return "null";');
        await settle();

        // Audio settings, from the menu: the engine choice of this browser.
        await run(`document.querySelector('.topbar [aria-label="Menu"]').click(); return "null";`);
        await until(
            async () =>
                await run(
                    'return JSON.stringify([...document.querySelectorAll("button")].some((b) => b.textContent.includes("Audio settings")));',
                ),
            "the Audio settings row",
        );
        await run(`
            [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Audio settings")).click();
            return "null";
        `);
        await wait(".voice-settings");
        assert.equal(
            await run(
                'return JSON.stringify(document.querySelector(".voice-settings select").value);',
            ),
            "local",
        );
        await run(`
            const select = document.querySelector('.voice-settings select');
            select.value = 'mistral';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return "null";
        `);
        await until(
            async () =>
                await run('return JSON.stringify(localStorage.getItem("x.voice-message.engine"));'),
            "the engine saved",
        );
        assert.equal(
            await run('return JSON.stringify(localStorage.getItem("x.voice-message.engine"));'),
            "mistral",
        );
        await run(`localStorage.setItem('x.voice-message.engine', 'local'); return "null";`);
        await run(
            `document.querySelector('.sheet-close, [aria-label="Close"]')?.click(); return "null";`,
        );
        await settle();

        // Turning the extension off mid-recording stops the microphone.
        await tap("Dictate a message");
        assert.equal(await run("return JSON.stringify(recorders.at(-1).state);"), "recording");
        await app.setExtensionEnabled(owner(app), "voice-message.ts", false);
        await until(
            async () => !(await has('[title="Dictate a message"]')),
            "the extension removed",
        );
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        cleanUp();
    }
});
