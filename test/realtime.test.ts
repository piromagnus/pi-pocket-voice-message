// Isolated tests for Mistral Voxtral Realtime streaming.
// Uses a local fake WebSocket server via the VOICE_MESSAGE_REALTIME_URL test seam.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import voiceMessage from "../voice-message.ts";

// `ws` comes from the Pi Pocket checkout that runs the tests, never from a fixed path on one machine.
const repo =
    process.env.PI_POCKET_REPO ?? fileURLToPath(new URL("../../pi-pocket", import.meta.url));
const { WebSocketServer } = createRequire(join(repo, "package.json"))("ws");

interface FakeWsServer {
    url: string;
    close: () => Promise<void>;
    onConnection?: (ws: any, req: http.IncomingMessage) => void;
}

async function startFakeWsServer(): Promise<FakeWsServer> {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let connectionHandler: ((ws: any, req: http.IncomingMessage) => void) | undefined;

    wss.on("connection", (ws, req) => {
        if (connectionHandler) {
            connectionHandler(ws, req);
        }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    return {
        url: `ws://127.0.0.1:${port}`,
        get onConnection() {
            return connectionHandler;
        },
        set onConnection(handler) {
            connectionHandler = handler;
        },
        close: async () => {
            wss.clients.forEach((client) => client.terminate());
            wss.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function createHarness() {
    const routes = new Map<string, (req: any) => Promise<any>>();
    const sentEvents: { event: string; data: any; options?: any }[] = [];
    let disposeHandler: (() => void) | undefined;

    const web = {
        client() {},
        onDispose(fn: () => void) {
            disposeHandler = fn;
        },
        route(
            method: string,
            path: string,
            fn: (req: any) => Promise<any>,
            options?: { access?: string },
        ) {
            routes.set(`${method} ${path}`, fn);
        },
        send(event: string, data?: unknown, options?: { to?: string }) {
            sentEvents.push({ event, data, options });
        },
        error(status: number, message: string) {
            return Object.assign(new Error(message), { status });
        },
    };

    return {
        routes,
        sentEvents,
        dispose: () => disposeHandler?.(),
        web,
    };
}

test("Realtime: happy path deltas, ordering, completion, user isolation", async () => {
    const fake = await startFakeWsServer();
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;

    let receivedAuth = "";
    let receivedSessionUpdate: any = null;
    let serverWs: any = null;

    fake.onConnection = (ws, req) => {
        serverWs = ws;
        receivedAuth = req.headers.authorization ?? "";
        ws.on("message", (msg: Buffer) => {
            const data = JSON.parse(msg.toString());
            if (data.type === "session.update") {
                receivedSessionUpdate = data.session;
                ws.send(JSON.stringify({ type: "session.updated", session: data.session }));
            } else if (data.type === "input_audio.append") {
                ws.send(JSON.stringify({ type: "transcription.text.delta", text: "Bonjour " }));
                ws.send(JSON.stringify({ type: "transcription.text.delta", text: "monde" }));
            } else if (data.type === "input_audio.end") {
                ws.send(JSON.stringify({ type: "transcription.done", text: "Bonjour monde" }));
            }
        });
    };

    try {
        process.env.VOICE_MESSAGE_REALTIME_URL = fake.url;
        process.env.MISTRAL_API_KEY = "test-secret-key-123";

        voiceMessage({ agentDir } as never, harness.web as never);

        const startRoute = harness.routes.get("POST live/start")!;
        const audioRoute = harness.routes.get("POST live/audio")!;
        const endRoute = harness.routes.get("POST live/end")!;

        const sessionId = "12345678-1234-1234-1234-123456789abc";
        const userA = { id: "user-alpha" };

        const startRes = await startRoute({
            body: { sessionId },
            user: userA,
        });
        assert.deepEqual(startRes, { ok: true });
        assert.equal(receivedAuth, "Bearer test-secret-key-123");
        assert.deepEqual(receivedSessionUpdate, {
            audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
            target_streaming_delay_ms: 480,
            language: "fr",
        });

        // Send audio chunk seq: 0
        const audioBase64 = Buffer.alloc(100, 1).toString("base64");
        const audioRes = await audioRoute({
            body: { sessionId, seq: 0, audio: audioBase64 },
            user: userA,
        });
        assert.deepEqual(audioRes, { ok: true });

        // Wait a tick for deltas to be processed
        await new Promise((r) => setTimeout(r, 50));

        // Check deltas in harness.sentEvents
        assert.equal(harness.sentEvents.length, 2);
        assert.deepEqual(harness.sentEvents[0], {
            event: "live",
            data: { sessionId, kind: "delta", text: "Bonjour ", seq: 0 },
            options: { to: "user-alpha" },
        });
        assert.deepEqual(harness.sentEvents[1], {
            event: "live",
            data: { sessionId, kind: "delta", text: "monde", seq: 1 },
            options: { to: "user-alpha" },
        });

        // Finish session
        const endRes = await endRoute({
            body: { sessionId },
            user: userA,
        });
        assert.deepEqual(endRes, { text: "Bonjour monde" });
    } finally {
        if (oldEnvUrl !== undefined) process.env.VOICE_MESSAGE_REALTIME_URL = oldEnvUrl;
        else delete process.env.VOICE_MESSAGE_REALTIME_URL;
        if (oldEnvKey !== undefined) process.env.MISTRAL_API_KEY = oldEnvKey;
        else delete process.env.MISTRAL_API_KEY;
        await fake.close();
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Realtime: validation errors (bad seq, oversize, wrong user, 429 concurrency)", async () => {
    const fake = await startFakeWsServer();
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;

    fake.onConnection = (ws) => {
        ws.on("message", (msg: Buffer) => {
            const data = JSON.parse(msg.toString());
            if (data.type === "session.update") {
                ws.send(JSON.stringify({ type: "session.updated", session: data.session }));
            }
        });
    };

    try {
        process.env.VOICE_MESSAGE_REALTIME_URL = fake.url;
        process.env.MISTRAL_API_KEY = "test-secret-key-123";

        voiceMessage({ agentDir } as never, harness.web as never);

        const startRoute = harness.routes.get("POST live/start")!;
        const audioRoute = harness.routes.get("POST live/audio")!;
        const cancelRoute = harness.routes.get("POST live/cancel")!;
        const transcribeRoute = harness.routes.get("POST transcribe")!;

        const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        const userA = { id: "user-a" };
        const userB = { id: "user-b" };

        // Invalid session ID
        await assert.rejects(
            startRoute({ body: { sessionId: "not-a-uuid" }, user: userA }),
            (err: any) => err.status === 400,
        );

        // Start session
        await startRoute({ body: { sessionId }, user: userA });

        // Second start while active -> 429
        await assert.rejects(
            startRoute({
                body: { sessionId: "11111111-2222-3333-4444-555555555555" },
                user: userA,
            }),
            (err: any) => err.status === 429,
        );

        // File transcribe route while live session active -> 429
        await assert.rejects(
            transcribeRoute({
                body: {
                    audio: Buffer.alloc(32).toString("base64"),
                    mimeType: "audio/wav",
                    engine: "mistral",
                },
                signal: new AbortController().signal,
            }),
            (err: any) => err.status === 429,
        );

        // Audio with wrong user -> 404
        const chunk = Buffer.alloc(32).toString("base64");
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 0, audio: chunk }, user: userB }),
            (err: any) => err.status === 404,
        );

        // Audio with wrong session -> 404
        await assert.rejects(
            audioRoute({
                body: { sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff", seq: 0, audio: chunk },
                user: userA,
            }),
            (err: any) => err.status === 404,
        );

        // Audio with bad seq (expected 0, sent 1) -> 409
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 1, audio: chunk }, user: userA }),
            (err: any) => err.status === 409,
        );

        // Audio chunk oversize (> 64KB) -> 400
        const oversized = Buffer.alloc(65 * 1024).toString("base64");
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 0, audio: oversized }, user: userA }),
            (err: any) => err.status === 400,
        );

        // Valid audio chunk seq: 0
        const validRes = await audioRoute({
            body: { sessionId, seq: 0, audio: chunk },
            user: userA,
        });
        assert.deepEqual(validRes, { ok: true });

        // Next chunk seq: 0 again -> 409
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 0, audio: chunk }, user: userA }),
            (err: any) => err.status === 409,
        );

        // Cancel
        const cancelRes = await cancelRoute({ body: { sessionId }, user: userA });
        assert.deepEqual(cancelRes, { ok: true });

        // After cancel, audio route -> 404
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 1, audio: chunk }, user: userA }),
            (err: any) => err.status === 404,
        );
    } finally {
        if (oldEnvUrl !== undefined) process.env.VOICE_MESSAGE_REALTIME_URL = oldEnvUrl;
        else delete process.env.VOICE_MESSAGE_REALTIME_URL;
        if (oldEnvKey !== undefined) process.env.MISTRAL_API_KEY = oldEnvKey;
        else delete process.env.MISTRAL_API_KEY;
        await fake.close();
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Realtime: idle timeout closes socket and sends closed event", async () => {
    const fake = await startFakeWsServer();
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;
    const oldTimeout = process.env.VOICE_MESSAGE_IDLE_TIMEOUT_MS;

    fake.onConnection = (ws) => {
        ws.on("message", (msg: Buffer) => {
            const data = JSON.parse(msg.toString());
            if (data.type === "session.update") {
                ws.send(JSON.stringify({ type: "session.updated", session: data.session }));
            }
        });
    };

    try {
        process.env.VOICE_MESSAGE_REALTIME_URL = fake.url;
        process.env.MISTRAL_API_KEY = "test-secret-key-123";
        process.env.VOICE_MESSAGE_IDLE_TIMEOUT_MS = "50"; // 50ms for test speed

        voiceMessage({ agentDir } as never, harness.web as never);

        const startRoute = harness.routes.get("POST live/start")!;
        const audioRoute = harness.routes.get("POST live/audio")!;

        const sessionId = "22222222-2222-2222-2222-222222222222";
        const user = { id: "user-idle" };

        await startRoute({ body: { sessionId }, user });

        // Wait > 50ms for idle timeout to fire
        await new Promise((r) => setTimeout(r, 90));

        // Event {kind: 'closed'} sent to user
        const closedEvents = harness.sentEvents.filter(
            (e) => e.event === "live" && e.data.kind === "closed",
        );
        assert.equal(closedEvents.length, 1);
        assert.equal(closedEvents[0].options.to, "user-idle");

        // Subsequent audio call should fail with 404
        const chunk = Buffer.alloc(32).toString("base64");
        await assert.rejects(
            audioRoute({ body: { sessionId, seq: 0, audio: chunk }, user }),
            (err: any) => err.status === 404,
        );
    } finally {
        if (oldEnvUrl !== undefined) process.env.VOICE_MESSAGE_REALTIME_URL = oldEnvUrl;
        else delete process.env.VOICE_MESSAGE_REALTIME_URL;
        if (oldEnvKey !== undefined) process.env.MISTRAL_API_KEY = oldEnvKey;
        else delete process.env.MISTRAL_API_KEY;
        if (oldTimeout !== undefined) process.env.VOICE_MESSAGE_IDLE_TIMEOUT_MS = oldTimeout;
        else delete process.env.VOICE_MESSAGE_IDLE_TIMEOUT_MS;
        await fake.close();
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Realtime: server close mid session sends closed event, dispose cleans up", async () => {
    const fake = await startFakeWsServer();
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;

    let serverWs: any = null;
    fake.onConnection = (ws) => {
        serverWs = ws;
        ws.on("message", (msg: Buffer) => {
            const data = JSON.parse(msg.toString());
            if (data.type === "session.update") {
                ws.send(JSON.stringify({ type: "session.updated", session: data.session }));
            }
        });
    };

    try {
        process.env.VOICE_MESSAGE_REALTIME_URL = fake.url;
        process.env.MISTRAL_API_KEY = "test-secret-key-123";

        voiceMessage({ agentDir } as never, harness.web as never);

        const startRoute = harness.routes.get("POST live/start")!;
        const sessionId = "33333333-3333-3333-3333-333333333333";
        const user = { id: "user-close" };

        await startRoute({ body: { sessionId }, user });

        // Server closes socket mid session
        serverWs.close();
        await new Promise((r) => setTimeout(r, 50));

        const closedEvents = harness.sentEvents.filter(
            (e) => e.event === "live" && e.data.kind === "closed",
        );
        assert.equal(closedEvents.length, 1);
        assert.equal(closedEvents[0].options.to, "user-close");

        // Verify web.onDispose runs safely
        harness.dispose();
    } finally {
        if (oldEnvUrl !== undefined) process.env.VOICE_MESSAGE_REALTIME_URL = oldEnvUrl;
        else delete process.env.VOICE_MESSAGE_REALTIME_URL;
        if (oldEnvKey !== undefined) process.env.MISTRAL_API_KEY = oldEnvKey;
        else delete process.env.MISTRAL_API_KEY;
        await fake.close();
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Realtime: test seam never allows external host override, no secrets leaked in errors", async () => {
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;

    try {
        // Attempt external host override -> must be ignored and fallback to wss://api.mistral.ai
        process.env.VOICE_MESSAGE_REALTIME_URL = "wss://evil-attacker.com/ws";
        process.env.MISTRAL_API_KEY = "super-secret-key-99999";

        voiceMessage({ agentDir } as never, harness.web as never);

        const startRoute = harness.routes.get("POST live/start")!;
        const sessionId = "44444444-4444-4444-4444-444444444444";
        const user = { id: "user-security" };

        // Attempting to connect to real Mistral without network / bad setup should fail with safe error and never print the key
        await assert.rejects(startRoute({ body: { sessionId }, user }), (err: any) => {
            assert.ok(!err.message.includes("super-secret-key-99999"));
            assert.ok(!err.message.includes("evil-attacker.com"));
            return err.status === 502 || err.status === 408;
        });
    } finally {
        if (oldEnvUrl !== undefined) process.env.VOICE_MESSAGE_REALTIME_URL = oldEnvUrl;
        else delete process.env.VOICE_MESSAGE_REALTIME_URL;
        if (oldEnvKey !== undefined) process.env.MISTRAL_API_KEY = oldEnvKey;
        else delete process.env.MISTRAL_API_KEY;
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Realtime: a failed start frees the lock, and two starts racing for it cannot both win", async () => {
    const fake = await startFakeWsServer();
    const harness = createHarness();
    const agentDir = await mkdtemp(join(tmpdir(), "voice-rt-"));
    const oldEnvUrl = process.env.VOICE_MESSAGE_REALTIME_URL;
    const oldEnvKey = process.env.MISTRAL_API_KEY;
    let mode: "error" | "ok" = "error";

    fake.onConnection = (ws) => {
        ws.on("message", (msg: Buffer) => {
            const data = JSON.parse(msg.toString());

            if (data.type === "session.update") {
                ws.send(
                    JSON.stringify(
                        mode === "error"
                            ? { type: "error", error: { message: "provider detail" } }
                            : { type: "session.updated", session: data.session },
                    ),
                );
            }
        });
    };

    try {
        process.env.VOICE_MESSAGE_REALTIME_URL = fake.url;
        process.env.MISTRAL_API_KEY = "test-secret-key-123";
        voiceMessage({ agentDir } as never, harness.web as never);

        const start = harness.routes.get("POST live/start")!;
        const cancel = harness.routes.get("POST live/cancel")!;
        const user = { id: "user-alpha" };
        const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

        await assert.rejects(
            start({ body: { sessionId: first }, user }),
            (e: any) => e.status === 502,
        );

        // The failure must not leave the one-at-a-time lock taken: the next start works, and so would a file upload.
        mode = "ok";
        assert.deepEqual(await start({ body: { sessionId: second }, user }), { ok: true });
        await cancel({ body: { sessionId: second }, user });

        // Two starts launched together: exactly one gets the session, the other is told to wait.
        const outcomes = await Promise.allSettled([
            start({ body: { sessionId: first }, user }),
            start({ body: { sessionId: second }, user }),
        ]);

        assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
        const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;

        assert.equal((refused.reason as any).status, 429);
        await cancel({ body: { sessionId: first }, user });
        await cancel({ body: { sessionId: second }, user });
        harness.dispose();
    } finally {
        await fake.close();
        await rm(agentDir, { recursive: true, force: true });
        restore("VOICE_MESSAGE_REALTIME_URL", oldEnvUrl);
        restore("MISTRAL_API_KEY", oldEnvKey);
    }
});

function restore(name: string, value: string | undefined) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
