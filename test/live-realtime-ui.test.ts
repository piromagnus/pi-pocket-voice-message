// Real Pi Pocket + native Chromium audio capture + the extension's real server routes. Only Mistral is replaced, by a
// local WebSocket server that records exactly what it receives. No billable call is made.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo =
    process.env.PI_POCKET_REPO ?? fileURLToPath(new URL("../../pi-pocket", import.meta.url));
const source = fileURLToPath(new URL("../", import.meta.url));
const { cleanUp, newSession, openApp, owner, root, scriptedModel, until } = await import(
    pathToFileURL(join(repo, "test/helpers.ts")).href
);
const { Browsers } = await import(pathToFileURL(join(repo, "src/server/browser.ts")).href);
const { createHandler } = await import(pathToFileURL(join(repo, "src/server/http.ts")).href);
const { WebSocketServer } = createRequire(join(repo, "package.json"))("ws");

const FINAL =
    "Premièrement, la plupart des cavaliers portent des bottes d'équitation avec un talon et une semelle lisse et assez étroite.";
const WORDS = [" Premièrement,", " la plupart", " des cavaliers", " portent des bottes"];

/** The sample's samples, from a WAV file: the format is checked, not assumed. */
function readWav(file: string): Int16Array {
    const bytes = readFileSync(file);

    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    let at = 12;
    let rate = 0;

    while (at + 8 <= bytes.length) {
        const name = bytes.toString("ascii", at, at + 4);
        const size = bytes.readUInt32LE(at + 4);

        if (name === "fmt ") {
            assert.equal(bytes.readUInt16LE(at + 8), 1, "PCM");
            assert.equal(bytes.readUInt16LE(at + 10), 1, "mono");
            rate = bytes.readUInt32LE(at + 12);
            assert.equal(bytes.readUInt16LE(at + 22), 16, "16-bit");
        } else if (name === "data") {
            assert.equal(rate, 16000);

            return new Int16Array(
                bytes.buffer.slice(bytes.byteOffset + at + 8, bytes.byteOffset + at + 8 + size),
            );
        }

        at += 8 + size + (size % 2);
    }

    throw new Error("no data chunk");
}

/** Loudness of each 100 ms: what a transcription engine hears, whatever the codec or the clock did to it. */
function envelope(samples: Int16Array): number[] {
    const out: number[] = [];

    for (let at = 0; at + 1600 <= samples.length; at += 1600) {
        let sum = 0;

        for (let index = at; index < at + 1600; index++) {
            sum += samples[index]! * samples[index]!;
        }

        out.push(Math.sqrt(sum / 1600));
    }

    return out;
}

function correlation(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    const meanA = a.slice(0, length).reduce((x, y) => x + y, 0) / length;
    const meanB = b.slice(0, length).reduce((x, y) => x + y, 0) / length;
    let both = 0;
    let varA = 0;
    let varB = 0;

    for (let index = 0; index < length; index++) {
        both += (a[index]! - meanA) * (b[index]! - meanB);
        varA += (a[index]! - meanA) ** 2;
        varB += (b[index]! - meanB) ** 2;
    }

    return both / Math.sqrt(varA * varB);
}

/** The best match over a few blocks of lag: capture starts a moment after playback does. */
function bestCorrelation(sent: number[], heard: number[]): number {
    let best = -1;

    for (let lag = -8; lag <= 8; lag++) {
        const a = lag >= 0 ? sent.slice(lag) : sent;
        const b = lag >= 0 ? heard : heard.slice(-lag);

        best = Math.max(best, correlation(a, b));
    }

    return best;
}

async function fakeMistral() {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const state = {
        mode: "ok" as "ok" | "fail",
        connections: 0,
        auth: "",
        update: null as any,
        pcm: [] as Buffer[],
        ended: false,
        closed: 0,
        firstAudioAt: 0,
    };

    wss.on("connection", (socket: any, request: any) => {
        state.connections++;
        state.auth = request.headers.authorization ?? "";
        state.ended = false;
        let bytes = 0;
        let sent = 0;
        const say = (text: string) =>
            socket.send(JSON.stringify({ type: "transcription.text.delta", text }));

        socket.on("message", (raw: Buffer) => {
            const message = JSON.parse(raw.toString());

            if (message.type === "session.update") {
                state.update = message.session;
                socket.send(
                    JSON.stringify(
                        state.mode === "fail"
                            ? { type: "error", error: { message: "provider detail" } }
                            : { type: "session.updated", session: message.session },
                    ),
                );
            } else if (message.type === "input_audio.append") {
                const chunk = Buffer.from(message.audio, "base64");

                state.firstAudioAt ||= Date.now();
                state.pcm.push(chunk);
                bytes += chunk.length;

                // One more word for every 1.5 s of audio, as a real engine would while someone speaks.
                while (sent < WORDS.length && bytes >= (sent + 1) * 48_000) {
                    say(WORDS[sent++]!);
                }
            } else if (message.type === "input_audio.end") {
                state.ended = true;

                while (sent < WORDS.length) {
                    say(WORDS[sent++]!);
                }

                socket.send(
                    JSON.stringify({ type: "transcription.done", text: FINAL.slice(0, 66) }),
                );
            }
        });
        socket.on("close", () => {
            state.closed++;
        });
    });

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));

    return {
        state,
        url: `ws://127.0.0.1:${(http.address() as { port: number }).port}`,
        close: async () => {
            wss.clients.forEach((client: any) => client.terminate());
            wss.close();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

test("live Mistral dictation: words appear while speaking, the audio is the real microphone, the final pass corrects", async () => {
    const mistral = await fakeMistral();
    const saved = {
        url: process.env.VOICE_MESSAGE_REALTIME_URL,
        key: process.env.MISTRAL_API_KEY,
    };

    process.env.VOICE_MESSAGE_REALTIME_URL = mistral.url;
    process.env.MISTRAL_API_KEY = "test-key-not-a-secret";
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(source, "voice-message.ts"), join(dropIns, "voice-message.ts"));
    cpSync(join(source, "voice-message"), join(dropIns, "voice-message"), { recursive: true });
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "live-rt-")),
        load: async () => undefined,
        save: () => {},
    });
    const fixture = join(source, "_voice-message/fixtures/french.wav");
    const wav = readFileSync(fixture).toString("base64");

    try {
        await app.setExtensionEnabled(owner(app), "voice-message.ts", true);
        const first = await newSession(app);
        const second = await newSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
        const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const run = async (script: string) => JSON.parse(await page.evaluate(script));
        const field = '[data-part~="composer"] textarea';
        const value = () => run(`return JSON.stringify(document.querySelector('${field}').value);`);
        const has = async (selector: string) =>
            (await run(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`,
            )) === true;
        const wait = (selector: string, ms = 10_000) => until(() => has(selector), selector, ms);
        const notices = () =>
            run(
                'return JSON.stringify([...document.querySelectorAll(".notice")].map((n) => n.textContent.trim()));',
            );
        const tap = async (title: string) => {
            await wait(`[title=${JSON.stringify(title)}]`);
            await run(
                `document.querySelector('[title=${JSON.stringify(title)}]').click(); return 'null';`,
            );
        };
        const owner$ = async (path: string, body: unknown) =>
            fetch(`${base}/api/x/voice-message/${path}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "Content-Type": "application/json",
                    "X-Pocket": "1",
                },
                body: JSON.stringify(body),
            });

        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${first}`,
        );
        await wait('[title="Dictate a message"]');
        await run(`
            localStorage.setItem('x.voice-message.engine', 'mistral');
            globalThis.audio = new AudioContext();
            const bytes = Uint8Array.from(atob(${JSON.stringify(wav)}), (c) => c.charCodeAt(0));
            globalThis.sample = await audio.decodeAudioData(bytes.buffer);
            globalThis.finished = false;
            globalThis.finals = [];
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
                await audio.resume();
                const destination = audio.createMediaStreamDestination();
                const player = audio.createBufferSource();
                player.buffer = sample; player.connect(destination);
                player.onended = () => { finished = true; };
                player.start();
                return destination.stream;
            }});
            // Only the file route is faked (it would reach the real Mistral). The live routes are the real ones.
            const originalFetch = fetch;
            globalThis.fetch = async (url, options) => {
                if (String(url).endsWith('/api/x/voice-message/transcribe')) {
                    finals.push(JSON.parse(options.body).phase);
                    return new Response(JSON.stringify({ text: ${JSON.stringify(FINAL)} }), { headers: { 'content-type': 'application/json' } });
                }
                return originalFetch(url, options);
            };
            const box = document.querySelector('${field}');
            box.value = 'Draft:'; box.dispatchEvent(new Event('input', { bubbles: true }));
            return 'null';
        `);

        // 1. Words show up while the person is still speaking.
        await tap("Dictate a message");
        await until(
            async () => (await value()).startsWith("Draft: Premièrement"),
            "the first live words",
            20_000,
        );
        assert.equal(await has('[title="Stop dictation"]'), true, "still recording");
        assert.equal(
            await run("return JSON.stringify(finished);"),
            false,
            "the sample is still playing",
        );
        const partial = await value();

        assert.ok(
            partial.length < `Draft: ${FINAL}`.length,
            "a partial transcript, not the whole one",
        );
        assert.equal(await has('[data-sheet="ext"]'), false, "no popup");

        // 2. Let the sample end, then Stop.
        await until(() => run("return JSON.stringify(finished);"), "the sample to end", 20_000);
        await tap("Stop dictation");
        await until(
            async () => (await value()) === `Draft: ${FINAL}`,
            "the final correction",
            20_000,
        );
        await wait('[title="Dictate a message"]');

        // 3. What Mistral received.
        assert.equal(mistral.state.auth, "Bearer test-key-not-a-secret");
        assert.deepEqual(mistral.state.update, {
            audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
            target_streaming_delay_ms: 480,
            language: "fr",
        });
        assert.equal(mistral.state.ended, true, "the session was ended, not just dropped");
        assert.deepEqual(
            await run("return JSON.stringify(finals);"),
            ["final"],
            "one final pass, no file previews",
        );

        const heard = new Int16Array(
            Buffer.concat(mistral.state.pcm).buffer.slice(
                0,
                Buffer.concat(mistral.state.pcm).length,
            ),
        );
        const sent = readWav(fixture);
        const seconds = heard.length / 16000;

        assert.ok(
            seconds > 9.5 && seconds < 13.5,
            `about ${sent.length / 16000} s of audio arrived, got ${seconds}`,
        );
        assert.ok(
            bestCorrelation(envelope(sent), envelope(heard)) > 0.8,
            "the audio that arrived is the audio that was spoken",
        );

        // 4. The session is over: nothing left open, and the next one can start.
        await until(async () => mistral.state.closed >= 1, "Mistral's socket closed");
        const again = await owner$("live/start", {
            sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        });

        assert.equal(again.status, 200, "the lock was released");
        await owner$("live/cancel", { sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });

        // 5. Leaving mid-recording closes Mistral's socket and writes nothing more.
        const before = mistral.state.closed;

        await run(`
            const box = document.querySelector('${field}'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis.finished = false; return 'null';
        `);
        await tap("Dictate a message");
        await until(async () => mistral.state.connections >= 3, "a new live session");
        await run(
            `const { navigate } = await import('/store.js'); navigate(${second}); return 'null';`,
        );
        await wait('[title="Dictate a message"]');
        await until(async () => mistral.state.closed > before, "the socket closed after leaving");
        assert.equal(
            (await owner$("live/start", { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }))
                .status,
            200,
        );
        await owner$("live/cancel", { sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });

        // 6. Mistral refuses the session: a clear warning, and the recording still gets its final transcript.
        await run(
            `const { navigate } = await import('/store.js'); navigate(${first}); return 'null';`,
        );
        await wait(field);
        mistral.state.mode = "fail";
        await run(`
            const box = document.querySelector('${field}'); box.value = 'Draft:'; box.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis.finished = false; finals.length = 0; return 'null';
        `);
        await tap("Dictate a message");
        // The microphone is granted before Stop can mean "stop": a tap during the permission step cancels instead.
        await wait('[title="Stop dictation"]');
        await until(
            async () => JSON.stringify(await notices()).includes("Live preview is unavailable"),
            "the warning",
        );
        // Let the person speak: a recording needs at least one second of audio to exist.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await tap("Stop dictation");
        await until(
            async () => (await value()) === `Draft: ${FINAL}`,
            "the final transcript without live words",
            30_000,
        );
        await wait('[title="Dictate a message"]');
        assert.equal(
            (await owner$("live/start", { sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }))
                .status,
            502,
        );
        mistral.state.mode = "ok";
        assert.equal(
            (await owner$("live/start", { sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }))
                .status,
            200,
        );
        await owner$("live/cancel", { sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });

        assert.equal(
            await run("return JSON.stringify(document.documentElement.scrollWidth <= innerWidth);"),
            true,
        );
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        await mistral.close();
        cleanUp();

        for (const [name, old] of [
            ["VOICE_MESSAGE_REALTIME_URL", saved.url],
            ["MISTRAL_API_KEY", saved.key],
        ] as const) {
            if (old === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = old;
            }
        }
    }
});
