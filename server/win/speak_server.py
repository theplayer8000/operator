# Turn text into a WAV file, with the model held in memory.
#
# ## Why a resident process, again
#
# The same measurement that produced `transcribe_server.py`: spawning per call
# spent three quarters of its time on startup rather than work — uv resolving,
# Python booting, the import, and the model load. Kokoro's ONNX graph is ~310MB
# and loading it per sentence would make a two-word acknowledgement slower than
# the answer it is acknowledging.
#
# ## The protocol, and the trap in it
#
#   stdin:  one JSON object per line — {"text","voice","speed","out"}
#   stdout: OK|<voice>|<samples>    or    ERR|<reason>
#           and one READY|<voice,voice,…> line once the model is loaded
#
# **stdout must be flushed by hand after every line.** Python block-buffers
# stdout when it is a pipe rather than a terminal, so without the flush the
# audio is written in milliseconds and the line announcing it sits in a buffer
# that never empties — indistinguishable from a hang. That failure has already
# cost this project a session once, in the transcriber, which is why
# `server/tts.mjs` also passes `-u`. Both, deliberately.
#
# ## Nothing leaves the machine
#
# kokoro-onnx runs the model locally through onnxruntime on the CPU. The only
# network access in this file's life is uv resolving the package on first run,
# which is a package fetch in the same sense `ollama pull` is — not audio going
# anywhere. ElevenLabs and Deepgram were refused precisely to avoid that.

import json
import os
import sys
import wave


def fail(reason: str) -> None:
    """One line out, flushed, then stop. The caller only ever sees stdout."""
    print(f"ERR|{reason}", flush=True)


def main() -> int:
    if len(sys.argv) < 3:
        fail("usage: speak_server.py <model.onnx> <voices.bin>")
        return 2

    model_path, voices_path = sys.argv[1], sys.argv[2]
    for path in (model_path, voices_path):
        if not os.path.exists(path):
            fail(f"missing: {path}")
            return 2

    """
    espeak-ng, found explicitly rather than hoped for.

    Kokoro phonemises before synthesising, and the backend needs the espeak-ng
    shared library. Recent kokoro-onnx vendors one; older versions expect a
    system install found through these variables. Setting them when they are
    absent from the environment costs nothing and removes the single most
    likely first-run failure — a missing phonemiser surfaces as an error that
    mentions neither espeak nor Kokoro.
    """
    default_espeak = r"C:\Program Files\eSpeak NG"
    if os.path.isdir(default_espeak):
        os.environ.setdefault(
            "PHONEMIZER_ESPEAK_LIBRARY", os.path.join(default_espeak, "libespeak-ng.dll")
        )
        os.environ.setdefault(
            "PHONEMIZER_ESPEAK_PATH", os.path.join(default_espeak, "espeak-ng.exe")
        )
        os.environ.setdefault(
            "ESPEAK_DATA_PATH", os.path.join(default_espeak, "espeak-ng-data")
        )

    try:
        from kokoro_onnx import Kokoro
    except ImportError as err:
        fail(f"kokoro-onnx is not installed: {err}")
        return 3

    try:
        kokoro = Kokoro(model_path, voices_path)
    except Exception as err:  # noqa: BLE001 — the caller wants the reason, not a trace
        fail(f"could not load the model: {err}")
        return 1

    """
    Announce the voices the PACK actually contains, rather than a hardcoded
    list. The voice pack is a separate download from the model and versions
    independently, so a list baked in here would eventually offer a voice that
    does not exist — and the failure would land on whoever picked it.
    """
    try:
        voices = sorted(kokoro.get_voices())
    except Exception:  # noqa: BLE001
        voices = []
    print("READY|" + ",".join(voices), flush=True)

    for line in sys.stdin:
        raw = line.strip().lstrip("\ufeff").strip()
        if not raw:
            continue
        if raw == "QUIT":
            return 0
        try:
            print(speak_one(kokoro, raw), flush=True)
        except Exception as err:  # noqa: BLE001 — one bad request must not end the process
            print(f"ERR|{err}", flush=True)

    return 0


def speak_one(kokoro, raw: str) -> str:
    request = json.loads(raw)
    text = str(request.get("text") or "").strip()
    if not text:
        return "ERR|nothing to say"

    voice = request.get("voice") or "af_heart"
    speed = float(request.get("speed") or 1.0)
    out = request.get("out")
    if not out:
        return "ERR|no output path given"

    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-gb")

    """
    Written as 16-bit PCM by hand rather than through soundfile or scipy.

    Kokoro returns float32 in -1..1; a WAV header and a scaled int16 copy is
    twenty lines, and it keeps this file's dependency list to exactly one
    package. Every extra wheel is another thing that can fail to build for
    CPython 3.11 on first run, which is already the riskiest moment here.
    """
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(to_pcm16(samples))

    return f"OK|{voice}|{len(samples)}"


def to_pcm16(samples) -> bytes:
    """float32 -1..1 to little-endian int16, clipped rather than wrapped."""
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


if __name__ == "__main__":
    sys.exit(main())
