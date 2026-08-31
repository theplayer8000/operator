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

# Whisper's stock hallucinations, lowercased and stripped of punctuation.
#
# These are not guesses. Fed silence or noise, Whisper emits the phrases that
# dominate its training data — the end-cards of YouTube videos — and it emits
# them with high confidence, because as far as the model is concerned it has
# recognised something it has seen a million times.
#
# Observed on this machine on 2026-08-31, each of which started a real Claude
# Code job: "Thanks for watching!", "Thank you.", "Mm-hmm", "Okay.",
# "and into watching this video."
#
# This is a BACKSTOP, not the mechanism. The scores below are what actually
# does the work; a blocklist can only catch what someone has already seen.
HALLUCINATIONS = {
    "thanks for watching",
    "thank you for watching",
    "thanks for watching!",
    "thank you",
    "thanks",
    "you",
    "bye",
    "bye bye",
    "okay",
    "ok",
    "mm-hmm",
    "mmhmm",
    "mm",
    "uh",
    "um",
    "yeah",
    "so",
    "subscribe",
    "please subscribe",
    "like and subscribe",
    "the end",
    "silence",
    "music",
    "applause",
}

# A segment below this is noise dressed as speech.
#
# avg_logprob is the model's mean per-token log probability: genuine speech sits
# around -0.1 to -0.5, and invented text falls away sharply below -1.0.
MIN_AVG_LOGPROB = -1.0

# no_speech_prob is the model's own estimate that a segment contains no speech
# at all. Above this it is saying so directly, and it should be believed.
MAX_NO_SPEECH_PROB = 0.6


def _looks_hallucinated(text: str) -> bool:
    """True when a segment is one of Whisper's silence-fillers."""
    cleaned = text.strip().strip(".,!?-—…\"' ").lower()
    if not cleaned:
        return True
    if cleaned in HALLUCINATIONS:
        return True
    # "Bye. Bye. Bye. Bye." — a single filler repeated is the same failure
    # wearing a longer coat. Observed exactly this on 2026-08-31.
    words = [w.strip(".,!?-—…\"'") for w in cleaned.split()]
    words = [w for w in words if w]
    if len(words) > 2 and len(set(words)) <= 2:
        return True
    return False


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
        kept = []
        scores = []
        for seg in segments:
            body = seg.text.strip()
            if not body:
                continue
            # The model's own two verdicts on whether this is speech. Checked
            # BEFORE the wording, because a score rejects hallucinations nobody
            # has catalogued yet and the blocklist only rejects the known ones.
            no_speech = getattr(seg, "no_speech_prob", 0.0) or 0.0
            logprob = getattr(seg, "avg_logprob", 0.0) or 0.0
            if no_speech > MAX_NO_SPEECH_PROB:
                continue
            if logprob < MIN_AVG_LOGPROB:
                continue
            if _looks_hallucinated(body):
                continue
            kept.append(body)
            scores.append(logprob)

        text = " ".join(kept).strip()
    except Exception as err:  # noqa: BLE001 — the caller wants the reason, not a trace
        print(f"ERR|{err}")
        return 1

    if not text:
        print("NOSPEECH")
        return 1

    """
    Confidence from avg_logprob, NOT language_probability.

    It used to print `info.language_probability`, which on an English-only
    model (`base.en`) is a constant ~1.00 — it can only ever detect the one
    language it supports. So every hallucination arrived stamped "confident"
    and no caller could filter on it. The number was real; it just measured
    nothing about whether the words were said.

    Mapping mean log-probability onto 0–1 keeps the printed contract identical
    while making the value mean something: about 0.9 for clear speech, under
    0.5 for anything the model was guessing at.
    """
    import math

    mean_logprob = sum(scores) / len(scores)
    confidence = max(0.0, min(1.0, math.exp(mean_logprob)))

    print(f"TEXT|{confidence:.2f}|{text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
