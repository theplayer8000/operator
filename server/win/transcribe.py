# Turn one WAV file into one line of text. Nothing else.
#
# ## Why Python is here at all
#
# ADR 0015's amendment argued against it: `server/` is Node with one npm
# dependency, and every external capability spawns a binary. The owner has since
# accepted a Python runtime for this, which is what makes faster-whisper an
# option rather than a rewrite.
#
# It still runs as a SPAWNED PROCESS with a text interface — a path in, a line
# out — so nothing about `server/` changes and swapping in whisper.cpp later is
# a one-line change at the call site rather than a refactor.
#
# ## Why not Windows' own recogniser
#
# Tried first, and it cannot work here: `System.Speech` transcribes from the
# Windows *default* recording device and cannot target a named one. This machine
# has three active microphones (DroidCam, the headset, Realtek), so "default"
# is a coin toss — which is what NOSPEECH was. ffmpeg already captures from a
# named device in `server/listen.mjs` and does it reliably, so audio arrives
# here as a file and the device problem does not exist.
#
# ## Nothing leaves the machine
#
# The model runs locally. It is downloaded once on first use — a package fetch
# in the same sense `ollama pull` is, not audio going anywhere.
#
#   uv run --python 3.11 --with faster-whisper python transcribe.py <file.wav>
#
# Prints:  TEXT|<confidence>|<the words>   or   NOSPEECH   or   ERR|<reason>

import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("ERR|no audio file given")
        return 2

    path = sys.argv[1]
    # Small and English-only by default: this transcribes short spoken commands
    # on a machine with no usable GPU, where a larger model buys accuracy nobody
    # asked for at a latency everybody notices.
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base.en"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERR|faster-whisper is not installed")
        return 3

    try:
        # int8 on CPU: this box has 4GB of VRAM that ROCm does not cover, so
        # float16 on GPU is not available and int8 is the fastest honest option.
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            path,
            beam_size=1,
            # Silero VAD, which ADR 0015 records as load-bearing rather than a
            # refinement: Whisper invents plausible text out of silence, and a
            # clap-triggered capture is mostly silence when nobody speaks.
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
    except Exception as err:  # noqa: BLE001 — the caller wants the reason, not a trace
        print(f"ERR|{err}")
        return 1

    if not text:
        print("NOSPEECH")
        return 1

    # Language probability stands in for confidence; faster-whisper does not
    # give a per-utterance score, and printing something honest beats printing
    # a number that looks more precise than it is.
    print(f"TEXT|{info.language_probability:.2f}|{text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
