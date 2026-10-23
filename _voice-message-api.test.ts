// No billable requests. The Mistral transport is replaced by a local fake.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import voiceMessage from "./voice-message.ts";

test("Mistral: saved key, exact model, no retries, safe errors, cancellation and concurrency", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "voice-api-"));
    const realFetch = globalThis.fetch;
    const originalKey = process.env.MISTRAL_API_KEY;
    let route: (request: any) => Promise<any>;
    let dispose: () => void;
    let calls = 0;
    let responder = async (_init: RequestInit) =>
        new Response(JSON.stringify({ text: "Bonjour Pierre." }));
    const web = {
        client() {},
        onDispose(fn: () => void) {
            dispose = fn;
        },
        route(method: string, _path: string, fn: typeof route, options: { access: string }) {
            if (_path === "transcribe") {
                assert.equal(options.access, "owner");
                route = fn;
            }
        },
        error(status: number, message: string) {
            return Object.assign(new Error(message), { status });
        },
    };
    const request = (signal = new AbortController().signal) => ({
        signal,
        body: {
            audio: Buffer.alloc(32, 65).toString("base64"),
            mimeType: "audio/wav",
            engine: "mistral",
        },
    });

    try {
        delete process.env.MISTRAL_API_KEY;
        process.env.VOICE_TEST_MISTRAL_KEY = "test-key-not-a-secret";
        await writeFile(
            join(agentDir, "auth.json"),
            JSON.stringify({ mistral: { type: "api_key", key: "VOICE_TEST_MISTRAL_KEY" } }),
        );
        voiceMessage({ agentDir } as never, web as never);
        globalThis.fetch = (async (url, init) => {
            calls++;
            assert.equal(url, "https://api.mistral.ai/v1/audio/transcriptions");
            assert.equal(init?.method, "POST");
            assert.equal(init?.redirect, "error");
            assert.equal(
                (init?.headers as Record<string, string>).Authorization,
                "Bearer test-key-not-a-secret",
            );
            const form = init?.body as FormData;

            assert.equal(form.get("model"), "voxtral-mini-transcribe-3-0");
            assert.equal(form.get("language"), "fr");
            assert.equal((form.get("file") as File).size, 32);
            assert.ok(init?.signal);

            return responder(init!);
        }) as typeof fetch;
        assert.deepEqual(await route!(request()), {
            text: "Bonjour Pierre.",
            model: "voxtral-mini-transcribe-3-0",
            local: false,
        });
        assert.equal(calls, 1);
        responder = async () => new Response("secret-provider-body", { status: 429 });
        await assert.rejects(
            route!(request()),
            (error: any) => error.status === 502 && !error.message.includes("secret-provider-body"),
        );
        assert.equal(calls, 2);
        responder = async () => new Response("not-json secret-provider-body");
        await assert.rejects(
            route!(request()),
            (error: any) => error.status === 502 && !error.message.includes("secret-provider-body"),
        );
        responder = async () => new Response(JSON.stringify({ text: "x".repeat(120_000) }));
        await assert.rejects(route!(request()), (error: any) => error.status === 502);
        const beforeCommand = calls;

        await writeFile(
            join(agentDir, "auth.json"),
            JSON.stringify({ mistral: { type: "api_key", key: "!never-execute-this" } }),
        );
        await assert.rejects(route!(request()), (error: any) => error.status === 503);
        assert.equal(calls, beforeCommand);
        await writeFile(
            join(agentDir, "auth.json"),
            JSON.stringify({ mistral: { type: "api_key", key: "test-key-not-a-secret" } }),
        );
        let entered: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });

        responder = async (init) =>
            new Promise((_resolve, reject) => {
                entered();
                init.signal!.addEventListener(
                    "abort",
                    () => reject(new Error("secret-transport-detail")),
                    { once: true },
                );
            });
        const stop = new AbortController();
        const pending = route!(request(stop.signal));
        const cancelled = assert.rejects(
            pending,
            (error: any) =>
                error.status === 408 && !error.message.includes("secret-transport-detail"),
        );

        await started;
        await assert.rejects(route!(request()), (error: any) => error.status === 429);
        stop.abort();
        await cancelled;
        responder = async () => new Response(JSON.stringify({ text: "Encore." }));
        assert.equal((await route!(request())).text, "Encore.");
        dispose!();
        await assert.rejects(route!(request()), (error: any) => error.status === 408);
    } finally {
        globalThis.fetch = realFetch;
        delete process.env.VOICE_TEST_MISTRAL_KEY;

        if (originalKey === undefined) {
            delete process.env.MISTRAL_API_KEY;
        } else {
            process.env.MISTRAL_API_KEY = originalKey;
        }

        await rm(agentDir, { recursive: true, force: true });
    }
});
