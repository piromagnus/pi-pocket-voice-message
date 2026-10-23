// Native Chromium MediaRecorder + real offline Whisper. Feed a public sample into a Web Audio microphone stream.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo =
    process.env.PI_POCKET_REPO ?? fileURLToPath(new URL("../../pi-pocket", import.meta.url));
const source = fileURLToPath(new URL("../", import.meta.url));
const runtime = process.env.VOICE_TEST_RUNTIME ?? join(source, "_voice-message");
const { cleanUp, newSession, openApp, owner, root, scriptedModel, until } = await import(
    pathToFileURL(join(repo, "test/helpers.ts")).href
);
const { Browsers } = await import(pathToFileURL(join(repo, "src/server/browser.ts")).href);
const { createHandler } = await import(pathToFileURL(join(repo, "src/server/http.ts")).href);

test(
    "real local live dictation: independently decodable preview, full corrected draft, no message sent",
    {
        skip:
            !existsSync(join(runtime, ".venv/bin/python")) &&
            "Set VOICE_TEST_RUNTIME to a prepared offline runtime.",
    },
    async () => {
        const dropIns = join(root, "data", "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(source, "voice-message.ts"), join(dropIns, "voice-message.ts"));
        cpSync(join(source, "voice-message"), join(dropIns, "voice-message"), { recursive: true });
        symlinkSync(runtime, join(dropIns, "_voice-message"));
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "real-live-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            await app.setExtensionEnabled(owner(app), "voice-message.ts", true);
            const conversation = await newSession(app);

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
            const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const run = async (script: string) => JSON.parse(await page.evaluate(script));
            const field = '[data-part~="composer"] textarea';
            const value = () =>
                run(`return JSON.stringify(document.querySelector('${field}').value);`);
            const wav = readFileSync(join(source, "_voice-message/fixtures/french.wav")).toString(
                "base64",
            );

            await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${conversation}`,
            );
            await until(
                () =>
                    run(
                        "return JSON.stringify(!!document.querySelector('[title=\"Dictate a message\"]'));",
                    ),
                "mic button",
            );
            await run(`
            localStorage.setItem('x.voice-message.engine','local');
            globalThis.audio = new AudioContext({sampleRate:16000});
            const bytes = Uint8Array.from(atob(${JSON.stringify(wav)}), c=>c.charCodeAt(0));
            globalThis.sample = await audio.decodeAudioData(bytes.buffer);
            globalThis.mic = audio.createMediaStreamDestination();
            globalThis.ended = false;
            Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async () => {
                await audio.resume();
                const player = audio.createBufferSource(); player.buffer=sample;player.connect(mic);
                player.onended=()=>{ended=true;};player.start();
                return mic.stream;
            }});
            globalThis.posted = []; globalThis.responses = []; globalThis.started = performance.now();
            const originalFetch = fetch;
            globalThis.fetch = async (url,options) => {
                if (options?.method === 'POST') posted.push(String(url));
                const response = await originalFetch(url,options);
                if (String(url).endsWith('/transcribe')) {
                    responses.push({phase:JSON.parse(options.body).phase,body:await response.clone().json(),elapsed:performance.now()-started});
                }
                return response;
            };
            const box=document.querySelector('${field}');box.value='Draft:';box.dispatchEvent(new Event('input',{bubbles:true}));
            document.querySelector('[title="Dictate a message"]').click();
            return 'null';
        `);
            await until(async () => (await value()) !== "Draft:", "actual live preview", 40_000);
            const partial = await value();

            assert.ok(partial.startsWith("Draft: "));
            assert.equal(
                await run(
                    "return JSON.stringify(!!document.querySelector('[title=\"Stop dictation\"]'));",
                ),
                true,
            );
            assert.equal(await run("return JSON.stringify(responses[0].phase);"), "preview");
            await until(
                () => run("return JSON.stringify(ended);"),
                "sample audio finished",
                20_000,
            );
            await run(
                'document.querySelector(\'[title="Stop dictation"]\').click();return "null";',
            );
            await until(
                () =>
                    run(
                        "return JSON.stringify(!!document.querySelector('[title=\"Dictate a message\"]'));",
                    ),
                "final correction finished",
                60_000,
            );
            const final = await value();
            const result = await run("return JSON.stringify(responses);");

            assert.match(final, /^Draft: Premièrement/i);
            assert.match(final, /cavaliers.*bottes.*équitation/);
            assert.match(final, /étroite/);
            assert.equal(result.at(-1).phase, "final");
            assert.equal(
                result.some((r: any) => r.phase === "preview" && r.body.text),
                true,
            );
            assert.equal(
                await run(
                    "return JSON.stringify(posted.every(url=>url.endsWith('/transcribe')||url.endsWith('/typing')));",
                ),
                true,
            );
            console.log(
                JSON.stringify({
                    partial,
                    final,
                    stages: result.map((r: any) => ({
                        phase: r.phase,
                        seconds: Math.round(r.elapsed) / 1000,
                        model: r.body.model,
                    })),
                }),
            );
            await run("await audio.close();return 'null';");
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
            cleanUp();
        }
    },
);
