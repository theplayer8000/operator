# A transcriber that stays running, so the model is loaded once and not once
# per sentence.
#
# ## Why this exists
#
# Measured on this machine, 2026-08-31, transcribing three seconds of audio:
#
#     uv + python startup      1240 ms
#     import faster_whisper     863 ms
#     load base.en (int8)      1611 ms
#     actually transcribing    1290 ms
#     -------------------------------
#     total                    ~5000 ms
#
# Three quarters of that is setup, and `transcribe.py` paid all of it on every
# single utterance because it was spawned fresh each time. The work was never
# the slow part.
#
# This is the same finding as `server/ollama.mjs`'s keep-alive comment, where a
# one-word classification took 24.4 seconds of which 21.3 was loading the model
# from disk. Identical shape, identical fix: hold the thing in memory.
#
# ## The protocol, and the trap in it
#
# One absolute file path per line on stdin; one result line per input on
# stdout. Same output contract as `transcribe.py` so the caller is unchanged:
#
#     TEXT|<confidence>|<the words>   or   NOSPEECH   or   ERR|<reason>
#
# **stdout must be flushed by hand after every line.** Python block-buffers
# stdout when it is a pipe rather than a terminal, so without the flush the
# caller waits forever for a line that was computed instantly and is sitting in
# a buffer. A previous attempt at a persistent helper in this project died on
# exactly this class of bug — `powershell -Command -` buffers stdin until EOF
# and never behaves as a REPL — and it cost a session before anyone noticed the
# work was being done and simply not delivered.
#
# Filtering is imported from `transcribe.py` rather than copied, so the
# hallucination rules cannot drift between the two paths.

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    model_size = sys.argv[1] if len(sys.argv) > 1 else "base.en"

    try:
        from faster_whisper import WhisperModel
        from transcribe import (
            _looks_hallucinated,
            MIN_AVG_LOGPROB,
            MAX_NO_SPEECH_PROB,
        )
    except ImportError as err:
        print(f"ERR|{err}", flush=True)
        return 3

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
    except Exception as err:  # noqa: BLE001
        print(f"ERR|{err}", flush=True)
        return 1

    # Tells the caller the model is resident and the next line will be fast.
    # Without it there is no way to distinguish "still loading" from "hung".
    print("READY", flush=True)

    for line in sys.stdin:
        # Strip a BOM as well as whitespace. Measured: the first line written to
        # this process arrived as "﻿D:\\...", and the path was rejected as
        # invalid — a whole utterance lost to three invisible bytes. Whatever
        # the writer is, the path is what matters.
        path = line.strip().lstrip("﻿").strip()
        if not path:
            continue
        if path == "QUIT":
            return 0
        try:
            print(transcribe_one(model, path), flush=True)
        except Exception as err:  # noqa: BLE001 — one bad file must not end the process
            print(f"ERR|{err}", flush=True)

    return 0


def transcribe_one(model, path: str) -> str:
    from transcribe import (
        _looks_hallucinated,
        MIN_AVG_LOGPROB,
        MAX_NO_SPEECH_PROB,
    )
    import math

    segments, _info = model.transcribe(
        path,
        beam_size=1,
        # Silero VAD, load-bearing rather than a refinement: Whisper invents
        # plausible text out of silence, and a clap-triggered capture is mostly
        # silence when nobody speaks.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )

    kept = []
    scores = []
    for seg in segments:
        body = seg.text.strip()
        if not body:
            continue
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
    if not text:
        return "NOSPEECH"

    confidence = max(0.0, min(1.0, math.exp(sum(scores) / len(scores))))
    return f"TEXT|{confidence:.2f}|{text}"


if __name__ == "__main__":
    sys.exit(main())
