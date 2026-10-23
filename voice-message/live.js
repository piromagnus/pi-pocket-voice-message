// The browser half of Mistral Voxtral Realtime. The browser may only talk to its own server (the app's content
// security policy), so the server holds the WebSocket to Mistral: this module streams 16 kHz PCM to it in small
// requests, and the server pushes each piece of text back as a `live` event.

/** 100 ms of audio arrives per worklet block; four of them go in one request (400 ms). */
const BLOCKS_PER_REQUEST = 4;
/** The most audio that may wait to be sent. A slower link gives up on the live preview, not on the recording. */
const MAX_BACKLOG_BYTES = 10 * 16_000 * 2;
/** After Stop, how long to wait for Mistral's last words before the final pass takes over. */
const END_WAIT_MS = 4_000;

/** A block of audio as base64, in pieces small enough for `String.fromCharCode`. */
function encode(bytes) {
    const parts = [];

    for (let at = 0; at < bytes.length; at += 8192) {
        parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
    }

    return btoa(parts.join(""));
}

/**
 * One live session. `onText(text)` hears the whole transcript so far, each time it grows. `onFail()` is called at most
 * once, when the live preview cannot go on; the recording itself is never touched.
 */
export function createLive(pocket, { onText, onFail }) {
    const id = crypto.randomUUID();
    let context = null;
    let node = null;
    let stopEvents = null;
    let stopped = null;
    let sequence = 0;
    let lastDelta = -1;
    let backlog = 0;
    let text = "";
    let blocks = [];
    let sending = Promise.resolve();
    let ready = null;
    let failed = false;
    let closed = false;
    let ended = false;
    let released = false;

    const give = (reason) => {
        if (!failed && !closed) {
            failed = true;
            onFail(reason);
        }
    };

    const hear = (event) => {
        if (closed || failed || event?.sessionId !== id) {
            return;
        }

        if (event.kind === "delta") {
            // Events arrive in order on one stream; a gap would be a dropped event, which the final pass corrects.
            if (
                typeof event.text === "string" &&
                Number.isInteger(event.seq) &&
                event.seq > lastDelta
            ) {
                lastDelta = event.seq;
                text += event.text;
                onText(text.trimStart());
            }
        } else if (event.kind === "error" || event.kind === "closed") {
            give(event.kind);
        }
    };

    const flush = () => {
        if (!blocks.length) {
            return;
        }

        const bytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
        let at = 0;

        for (const block of blocks) {
            bytes.set(new Uint8Array(block), at);
            at += block.byteLength;
        }

        blocks = [];
        const number = sequence++;

        backlog += bytes.length;

        if (backlog > MAX_BACKLOG_BYTES) {
            give("slow");

            return;
        }

        // One request at a time, in order: the server refuses a chunk out of sequence.
        sending = sending.then(async () => {
            if (failed || closed) {
                return;
            }

            try {
                await ready;
                await pocket.api("live/audio", {
                    sessionId: id,
                    seq: number,
                    audio: encode(bytes),
                });
            } catch {
                give("audio");
            } finally {
                backlog -= bytes.length;
            }
        });
    };

    const closeAudio = () => {
        try {
            node?.disconnect();
        } catch {
            // Already disconnected.
        }

        node = null;
        context?.close().catch(() => {});
        context = null;
    };

    /**
     * Free the server's session, once. It waits for `live/start` to settle first: a cancel that overtook the start
     * would find nothing to close, and the session would then open and hold the server's lock until it timed out.
     */
    const releaseServer = () => {
        if (released) {
            return Promise.resolve();
        }

        released = true;

        return Promise.resolve(ready)
            .catch(() => {})
            .then(() => pocket.api("live/cancel", { sessionId: id }))
            .catch(() => {});
    };

    const detach = () => {
        closeAudio();
        stopEvents?.();
        stopEvents = null;
    };

    return {
        /** Start the server's session and the capture together: audio recorded while the session opens is kept. */
        async start(stream) {
            stopEvents = pocket.on("live", hear);
            ready = pocket.api("live/start", { sessionId: id });
            // Never an unhandled rejection: the sender below reads `ready` and gives the failure its one report.
            ready.catch(() => give("start"));

            try {
                context = new AudioContext();
                await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
                await context.resume();

                if (closed) {
                    detach();

                    return;
                }

                node = new AudioWorkletNode(context, "pcm-capture");
                node.port.onmessage = ({ data }) => {
                    if (data === "stopped") {
                        stopped?.();
                    } else if (data instanceof ArrayBuffer && !closed && !ended) {
                        blocks.push(data);

                        if (blocks.length >= BLOCKS_PER_REQUEST) {
                            flush();
                        }
                    }
                };
                context.createMediaStreamSource(stream).connect(node);
            } catch {
                give("capture");
            }
        },

        /** Stop capturing and wait (a little) for Mistral's last words. Always leaves the server's session closed. */
        async end() {
            if (closed || ended) {
                return;
            }

            ended = true;

            if (node) {
                await new Promise((resolve) => {
                    stopped = resolve;
                    node.port.postMessage("stop");
                    setTimeout(resolve, 500);
                });
            }

            flush();
            detach();

            if (!failed) {
                try {
                    const result = await Promise.race([
                        sending.then(() => pocket.api("live/end", { sessionId: id })),
                        new Promise((resolve) => setTimeout(resolve, END_WAIT_MS)),
                    ]);

                    if (result && typeof result.text === "string") {
                        // The server closes its session itself once Mistral is done.
                        released = true;

                        if (result.text.trim()) {
                            onText(result.text.trim());
                        }
                    }
                } catch {
                    // The final pass transcribes the whole recording anyway.
                }
            }

            // Too slow, failed, or never started: free the server's lock so the final pass can run. A no-op after `end`.
            await releaseServer();
            closed = true;
        },

        /** Give everything up at once: leaving, sending, switching session, turning off. Safe to call again. */
        cancel() {
            closed = true;
            detach();
            releaseServer();
        },

        get failed() {
            return failed;
        },
    };
}
