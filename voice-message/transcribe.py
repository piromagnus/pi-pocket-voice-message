"""Offline Whisper transcription. Audio enters through stdin and never touches disk.

Adaptive engine: the large model on the machine's GPU when available, else a small model
on the CPU that anyone's hardware can run. The small model downloads once, on first use.
"""
import io
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MAX_BYTES = 700_000
# Allow codec framing beyond the browser's 120-second recording limit.
MAX_SAMPLES = 16_000 * 125
SMALL_PIN = "536b0662742c02347bc0e980a01041f333bce120"


def answer(value, code=0):
    print(json.dumps(value, ensure_ascii=False), flush=True)
    raise SystemExit(code)


raw = sys.stdin.buffer.read(MAX_BYTES + 1)
if not 16 <= len(raw) <= MAX_BYTES:
    answer({"error": "invalid_audio"}, 2)

try:
    import av
    import numpy as np

    pcm = bytearray()
    with av.open(io.BytesIO(raw)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16_000)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                pcm.extend(converted.to_ndarray().tobytes())
                if len(pcm) > MAX_SAMPLES * 2:
                    answer({"error": "too_long"}, 2)
        for converted in resampler.resample(None):
            pcm.extend(converted.to_ndarray().tobytes())
            if len(pcm) > MAX_SAMPLES * 2:
                answer({"error": "too_long"}, 2)
    if not pcm:
        answer({"error": "invalid_audio"}, 2)
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
except Exception:
    answer({"error": "invalid_audio"}, 2)

runtime = Path(os.environ.get("VOICE_RUNTIME") or Path(__file__).parent.parent / "_voice-message")
try:
    gpu = int(json.loads((runtime / "config.json").read_text()).get("gpu", 0))
except Exception:
    gpu = 0


def transcribe(model, name, device):
    started = time.perf_counter()
    segments, _ = model.transcribe(
        audio,
        language="fr",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    answer({
        "text": text,
        "model": name,
        "device": device,
        "durationSeconds": round(len(audio) / 16000, 2),
        "transcribeSeconds": round(time.perf_counter() - started, 2),
    })


try:
    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model

    if not os.environ.get("VOICE_FORCE_LIGHT") and (runtime / "model").is_dir():
        try:
            transcribe(
                WhisperModel(
                    str(runtime / "model"),
                    device="cuda",
                    device_index=max(0, gpu),
                    compute_type="int8_float16",
                    cpu_threads=4,
                    local_files_only=True,
                ),
                "whisper-large-v3-turbo",
                "cuda",
            )
        except Exception:
            pass  # No usable GPU or model here: the small model serves anyone's machine.
    small = runtime / "models" / "small"
    if not (small / "model.bin").is_file():
        download_model("small", output_dir=str(small), revision=SMALL_PIN)
    transcribe(
        WhisperModel(
            str(small),
            device="cpu",
            compute_type="int8",
            cpu_threads=min(8, os.cpu_count() or 4),
            local_files_only=True,
        ),
        "whisper-small",
        "cpu",
    )
except SystemExit:
    raise
except Exception:
    answer({"error": "engine_unavailable"}, 3)
