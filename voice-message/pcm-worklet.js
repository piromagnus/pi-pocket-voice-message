// Runs in the audio rendering thread. Turns the microphone into 16 kHz mono 16-bit PCM, in blocks of 100 ms.
// The context runs at the device's rate (usually 44.1 or 48 kHz); averaging the samples of each output step is
// enough to decimate speech.
class PcmCapture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.ratio = sampleRate / 16000;
        this.out = new Int16Array(1600);
        this.filled = 0;
        this.sum = 0;
        this.count = 0;
        this.seen = 0;
        this.next = this.ratio;
        this.active = true;
        this.port.onmessage = ({ data }) => {
            if (data === "stop") {
                this.send(this.filled);
                this.port.postMessage("stopped");
                this.active = false;
            }
        };
    }

    /** Hand the first `length` samples to the page. The page owns the copy, so the next block can reuse `out`. */
    send(length) {
        if (length > 0) {
            const copy = this.out.slice(0, length);

            this.port.postMessage(copy.buffer, [copy.buffer]);
            this.filled = 0;
        }
    }

    process(inputs) {
        const channel = inputs[0]?.[0];

        if (!this.active) {
            return false;
        }

        if (!channel) {
            return true;
        }

        for (let index = 0; index < channel.length; index++) {
            this.sum += channel[index];
            this.count += 1;
            this.seen += 1;

            if (this.seen >= this.next) {
                const value = Math.max(-1, Math.min(1, this.sum / this.count));

                this.out[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
                this.sum = 0;
                this.count = 0;
                this.next += this.ratio;

                if (this.filled === this.out.length) {
                    this.send(this.filled);
                }
            }
        }

        return true;
    }
}

registerProcessor("pcm-capture", PcmCapture);
