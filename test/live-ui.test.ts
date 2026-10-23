// Real Pi Pocket + Chromium; fake STT transport and microphone. No billable calls.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
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

test("live draft in real composer: preview before stop, final correction, edits, cancel, send, navigation, permissions", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(source, "voice-message.ts"), join(dropIns, "voice-message.ts"));
    cpSync(join(source, "voice-message"), join(dropIns, "voice-message"), { recursive: true });
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "live-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        await app.setExtensionEnabled(owner(app), "voice-message.ts", true);
        const first = await newSession(app);
        const second = await newSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
        const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const run = async (script: string) => JSON.parse(await page.evaluate(script));
        const has = (selector: string) =>
            run(`return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}));`);
        const wait = (selector: string) => until(() => has(selector), selector);
        const field = '[data-part~="composer"] textarea';
        const value = () => run(`return JSON.stringify(document.querySelector('${field}').value);`);
        const expectValue = (text: string) => until(async () => (await value()) === text, text);
        const type = async (text: string) => {
            await run(
                `const box = document.querySelector('${field}'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', {bubbles:true})); return 'null';`,
            );
        };
        const tap = async (title: string) => {
            await wait(`[title=${JSON.stringify(title)}]`);
            await run(
                `document.querySelector('[title=${JSON.stringify(title)}]').click(); return 'null';`,
            );
        };
        const preview = async () => {
            await run(
                `recorders.findLast(r => !r.main && r.state === 'recording').stop(); return 'null';`,
            );
        };
        const start = async () => {
            await tap("Dictate a message");
            await wait('[title="Stop dictation"]');
        };
        const idle = () => wait('[title="Dictate a message"]');
        const settle = () => new Promise((resolve) => setTimeout(resolve, 550));

        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${first}`,
        );
        await idle();
        await run(`
            localStorage.setItem('x.voice-message.engine','local');
            globalThis.recorders = []; globalThis.tracks = []; globalThis.requests = [];
            globalThis.mode = 'normal'; globalThis.previewText = 'A roug'; globalThis.finalText = 'A rough transcript.';
            globalThis.resolveFinal = null; globalThis.denyMic = false; globalThis.delayMic = false; globalThis.resolveMic = null;
            const originalFetch = fetch;
            globalThis.fetch = async (url, options) => {
                if (!String(url).endsWith('/api/x/voice-message/transcribe')) return originalFetch(url,options);
                const body = JSON.parse(options.body); requests.push(body);
                if (body.phase === 'final' && mode === 'hold') {
                    await new Promise((resolve,reject) => {
                        resolveFinal = resolve;
                        options.signal.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), {once:true});
                    });
                }
                if (mode === 'fail' || (mode === 'preview-fail' && body.phase === 'preview')) {
                    return new Response(JSON.stringify({error:'Engine unavailable'}), {status:503,headers:{'content-type':'application/json'}});
                }
                return new Response(JSON.stringify({text: body.phase === 'preview' ? previewText : finalText}),{headers:{'content-type':'application/json'}});
            };
            Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:() => {
                if (denyMic) return Promise.reject(new DOMException('denied','NotAllowedError'));
                const track = {readyState:'live',stopped:false,stop(){this.readyState='ended';this.stopped=true;}};
                tracks.push(track);
                const stream = {getTracks:()=>[track]};
                return delayMic ? new Promise(resolve => { resolveMic = () => resolve(stream); }) : Promise.resolve(stream);
            }});
            globalThis.MediaRecorder = class {
                static isTypeSupported(){return true;}
                constructor(stream,options){this.state='inactive';this.mimeType='audio/wav';this.stream=stream;this.options=options;recorders.push(this);}
                start(timeslice){this.main=!!timeslice;this.state='recording';}
                stop(){
                    this.state='inactive';
                    setTimeout(()=>{this.ondataavailable?.({data:new Blob([new Uint8Array(32)],{type:'audio/wav'})});this.onstop?.();},0);
                }
            };
            return 'null';
        `);

        await type("Existing draft");
        await start();
        assert.equal(await has('[data-sheet="ext"]'), false, "no recording popup");
        await preview();
        await expectValue("Existing draft A roug");
        assert.equal(
            await run("return JSON.stringify(recorders.findLast(r=>r.main).state);"),
            "recording",
            "text visible before stopping",
        );
        await tap("Stop dictation");
        await expectValue("Existing draft A rough transcript.");
        await idle();
        assert.deepEqual(await run("return JSON.stringify(requests.map(r=>r.phase));"), [
            "preview",
            "final",
        ]);
        await type("I can edit the corrected message.");
        assert.equal(await value(), "I can edit the corrected message.");

        // Editing outside the owned span keeps both the user's prefix and the final correction.
        await type("Prefix");
        await start();
        await preview();
        await expectValue("Prefix A roug");
        await type("Edited prefix A roug");
        await tap("Stop dictation");
        await expectValue("Edited prefix A rough transcript.");
        await idle();

        // A manual correction inside the dictated span wins over the final pass.
        await type("Prefix");
        await start();
        await preview();
        await expectValue("Prefix A roug");
        await type("Prefix My own words");
        await tap("Stop dictation");
        await idle();
        assert.equal(await value(), "Prefix My own words");

        // A slow final must not replace an edit made while it is in flight.
        await type("");
        await run("mode='hold'; return 'null';");
        await start();
        await preview();
        await expectValue("A roug");
        await tap("Stop dictation");
        await until(
            () => run("return JSON.stringify(typeof resolveFinal === 'function');"),
            "pending final",
        );
        await type("My final wording");
        await run("resolveFinal(); resolveFinal=null;mode='normal';return 'null';");
        await idle();
        assert.equal(await value(), "My final wording");

        // Cancellation keeps the preview and ignores a late response.
        await type("");
        await run("mode='hold';return 'null';");
        await start();
        await preview();
        await expectValue("A roug");
        await tap("Stop dictation");
        await until(
            () => run("return JSON.stringify(typeof resolveFinal === 'function');"),
            "held final",
        );
        await tap("Cancel final transcription");
        await idle();
        await run("resolveFinal?.();resolveFinal=null;mode='normal';return 'null';");
        await settle();
        assert.equal(await value(), "A roug");

        // No late insertion after send/clear. Simulate the form's submit event without sending a model message.
        await type("");
        await start();
        await preview();
        await expectValue("A roug");
        await run(
            `const box=document.querySelector('${field}'); box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return 'null';`,
        );
        await idle();
        await type("");
        await settle();
        assert.equal(await value(), "");

        await start();
        await run(`const {navigate}=await import('/store.js');navigate(${second});return 'null';`);
        await idle();
        await settle();
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
        assert.equal(await value(), "");

        // A late permission response cannot reopen a cancelled recorder.
        await run("delayMic=true;return 'null';");
        await tap("Dictate a message");
        await wait('[title="Cancel microphone request"]');
        await tap("Cancel microphone request");
        await run("resolveMic();delayMic=false;return 'null';");
        await until(
            () => run("return JSON.stringify(tracks.at(-1).stopped);"),
            "late mic released",
        );
        await idle();

        await run("denyMic=true;return 'null';");
        await tap("Dictate a message");
        await idle();
        await run("denyMic=false;mode='fail';return 'null';");
        await start();
        await preview();
        await settle();
        await tap("Stop dictation");
        await idle();
        assert.equal(await value(), "");
        await run("mode='normal';return 'null';");

        assert.equal(
            await run("return JSON.stringify(document.documentElement.scrollWidth <= innerWidth);"),
            true,
        );
        await start();
        await app.setExtensionEnabled(owner(app), "voice-message.ts", false);
        await until(async () => !(await has('[title="Stop dictation"]')), "extension disabled");
        assert.equal(await run("return JSON.stringify(tracks.at(-1).stopped);"), true);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        cleanUp();
    }
});
