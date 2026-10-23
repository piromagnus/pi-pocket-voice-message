import assert from "node:assert/strict";
import { test } from "node:test";
import voiceMessage from "../voice-message.ts";

test("transcription phase validates strictly and preview uses the normal Mistral route", async () => {
    const oldKey = process.env.MISTRAL_API_KEY;
    const oldFetch = globalThis.fetch;
    let route: (request: any) => Promise<any>;
    let calls = 0;
    const web = {
        client() {},
        onDispose() {},
        route(_method: string, _path: string, handler: typeof route) {
            if (_path === "transcribe") {
                route = handler;
            }
        },
        error(status: number, message: string) {
            return Object.assign(new Error(message), { status });
        },
    };
    const request = (phase?: unknown) => ({
        signal: new AbortController().signal,
        body: {
            audio: Buffer.alloc(32, 65).toString("base64"),
            mimeType: "audio/wav",
            engine: "mistral",
            ...(phase === undefined ? {} : { phase }),
        },
    });

    try {
        process.env.MISTRAL_API_KEY = "voice-test-key";
        globalThis.fetch = (async () => {
            calls++;
            return new Response(JSON.stringify({ text: "Bonjour." }));
        }) as typeof fetch;
        voiceMessage({ agentDir: "/unused" } as never, web as never);

        await assert.rejects(route!(request("other")), (error: any) => error.status === 400);
        assert.equal(calls, 0);
        const preview = await route!(request("preview"));
        const final = await route!(request());
        assert.deepEqual(preview, final);
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = oldFetch;

        if (oldKey === undefined) {
            delete process.env.MISTRAL_API_KEY;
        } else {
            process.env.MISTRAL_API_KEY = oldKey;
        }
    }
});

test("Mistral response reading stops at the byte limit", async () => {
    const oldKey = process.env.MISTRAL_API_KEY;
    const oldFetch = globalThis.fetch;
    let route: (request: any) => Promise<any>;
    let cancelled = false;
    const web = {
        client() {},
        onDispose() {},
        route(_method: string, _path: string, handler: typeof route) {
            if (_path === "transcribe") {
                route = handler;
            }
        },
        error(status: number, message: string) {
            return Object.assign(new Error(message), { status });
        },
    };

    try {
        process.env.MISTRAL_API_KEY = "voice-test-key";
        globalThis.fetch = (async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(110_001));
                        controller.enqueue(new Uint8Array(1));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
            )) as typeof fetch;
        voiceMessage({ agentDir: "/unused" } as never, web as never);

        await assert.rejects(
            route!({
                signal: new AbortController().signal,
                body: {
                    audio: Buffer.alloc(32, 65).toString("base64"),
                    mimeType: "audio/wav",
                    engine: "mistral",
                },
            }),
            (error: any) => error.status === 502 && /too long/.test(error.message),
        );
        assert.equal(cancelled, true);
    } finally {
        globalThis.fetch = oldFetch;

        if (oldKey === undefined) {
            delete process.env.MISTRAL_API_KEY;
        } else {
            process.env.MISTRAL_API_KEY = oldKey;
        }
    }
});
