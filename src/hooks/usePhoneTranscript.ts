import { useEffect, useRef, useState } from "react";
import type { MicLevel } from "./useMicLevel";

/**
 * What this device is hearing, in words.
 *
 * The owner turned the microphone on, watched the core move with his voice,
 * and asked the obvious question: *"mic works on phone so why isnt the thing
 * working"*. Because the level was local and the WORDS were not — Whisper was
 * listening to the microphone attached to the PC, in a different room. This
 * closes that gap: the device records itself and posts the audio to Operator's
 * own server.
 *
 * ## Not the browser's speech recognition
 *
 * `SpeechRecognition` exists and would have been one line. On iOS it sends the
 * audio to **Apple** — an external host under CLAUDE.md's approval rule, and
 * his voice rather than a prompt. He has approved no such thing. The whole
 * path here stays on hardware he owns: device → his server over the tailnet →
 * the resident Whisper the clap gesture already uses.
 *
 * ## It sends when you stop talking, not on a timer
 *
 * The first version cut every four seconds regardless, which chopped sentences
 * in half and uploaded silence when nobody spoke. His design, and it is the
 * right one: *"every sentence after like i stop talking for more than 2 secs
 * it sends"*. A segment ends when speech has been heard AND the room has been
 * quiet for two seconds — the same rule `server/listen.mjs` uses for the clap
 * capture, arrived at separately for the same reason.
 *
 * ## Typing is not talking
 *
 * He reported the phone picking up his keyboard and "messing it about". A peak
 * threshold cannot separate those: a keystroke is as loud as a syllable. What
 * separates them is DURATION — speech sustains across tenths of a second,
 * typing is a spike and gone. So a segment must be voiced for a minimum
 * FRACTION of its length before it is worth uploading, which is the same
 * measurement `captureAndTranscribe` calls `voicedPct`.
 *
 * ## Segments, not a stream
 *
 * Each segment is recorded and posted whole. A `MediaRecorder` timeslice would
 * be cheaper, but only the FIRST chunk of a WebM stream carries the container
 * header — every later chunk on its own is undecodable.
 */

/** Quiet for this long, after speech, ends the sentence. The owner's number. */
const SILENCE_MS = 2000;
/** Nothing runs longer than this, however long someone talks. */
const MAX_SEGMENT_MS = 20_000;
/** Below this the level is room tone, not a voice. */
const SPEECH_PEAK = 0.02;
/**
 * Fraction of the recording that must be above the bar.
 *
 * This is the typing filter. A keystroke peaks as high as a syllable but lasts
 * a fraction as long, so loudness alone cannot tell them apart — sustained
 * energy can. Eight percent of a window is roughly a short word; a burst of
 * typing does not come close.
 */
const MIN_VOICED = 0.08;
/** How often the level is sampled. Fine enough to measure a syllable. */
const TICK_MS = 50;

export interface PhoneTranscript {
  /** Most recent lines heard, newest last. Capped. */
  lines: string[];
  /** A segment is being transcribed right now. */
  working: boolean;
  /** Last failure, if the upload or transcription broke. */
  error: string | null;
  /**
   * What the last segment actually did.
   *
   * Exists because "it's detecting nilch" is not debuggable from another
   * machine: silence-discarded, a zero-byte recording, a rejected upload and a
   * transcript of nothing all look identical from the outside. This turns that
   * into one readable line, and it found a real bug within a single round.
   */
  status: string;
  clear: () => void;
}

export function usePhoneTranscript(mic: MicLevel, enabled: boolean): PhoneTranscript {
  const [lines, setLines] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("waiting for you to speak");

  const stoppedRef = useRef(false);

  useEffect(() => {
    const stream = mic.streamRef.current;
    if (!enabled || !mic.active || !stream) return;
    if (typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio.");
      setStatus("no MediaRecorder");
      return;
    }

    stoppedRef.current = false;

    /*
      Whatever the platform will actually give us. Safari records MP4/AAC and
      Chrome WebM/Opus; ffmpeg on the server reads both without being told
      which, because the container is in the bytes. Passing an unsupported
      mimeType throws, so it is only set when the browser confirms it.
    */
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (t) => MediaRecorder.isTypeSupported?.(t),
    );

    let timer = 0;

    const runSegment = () => {
      if (stoppedRef.current) return;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      } catch (err) {
        setError(`Could not record: ${(err as Error)?.message ?? err}`);
        setStatus("MediaRecorder refused this stream");
        return;
      }

      /*
        Per-segment, NOT shared. These lived in the enclosing scope once, and
        because `onstop` starts the next segment before evaluating the finished
        one, the checks read values that had just been reset — every segment
        reported "quiet" however loudly he spoke, and nothing was ever sent.
      */
      let ticks = 0;
      let voicedTicks = 0;
      let heardSpeech = false;
      let quietFor = 0;
      const startedAt = Date.now();
      const parts: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(parts, { type: recorder.mimeType || "audio/webm" });
        const voiced = ticks ? voicedTicks / ticks : 0;

        // Start listening again immediately, so a slow upload never leaves a
        // gap he can speak into.
        if (!stoppedRef.current) runSegment();

        if (!heardSpeech) {
          setStatus("waiting for you to speak");
          return;
        }
        if (blob.size < 800) {
          setStatus(`recorded ${blob.size}B — too small to send`);
          return;
        }
        if (voiced < MIN_VOICED) {
          // Almost always typing, a door, a knock — loud but not sustained.
          setStatus(
            `ignored a noise (${(voiced * 100).toFixed(0)}% voiced, needs ${MIN_VOICED * 100}%)`,
          );
          return;
        }

        setStatus(`sending ${(blob.size / 1024).toFixed(0)}KB, ${(voiced * 100).toFixed(0)}% voiced`);
        setWorking(true);
        try {
          const res = await fetch("/api/listen/transcribe", {
            method: "POST",
            headers: { "content-type": blob.type || "application/octet-stream" },
            body: blob,
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body?.reason ?? body?.error ?? `server said ${res.status}`);
          const text = String(body?.text ?? "").trim();
          if (text) {
            setError(null);
            setStatus("heard it");
            // Capped: this is a glance under the core, not a document.
            setLines((prev) => [...prev, text].slice(-6));
          } else {
            setStatus("sent, but no speech found in it");
          }
        } catch (err) {
          setError((err as Error)?.message ?? "Could not transcribe.");
        } finally {
          setWorking(false);
        }
      };

      recorder.start();

      timer = window.setInterval(() => {
        const v = mic.levelRef.current;
        ticks += 1;

        if (v >= SPEECH_PEAK) {
          voicedTicks += 1;
          heardSpeech = true;
          quietFor = 0;
        } else if (heardSpeech) {
          quietFor += TICK_MS;
        }

        /*
          End on silence after speech, or at the hard cap.

          Silence BEFORE any speech never ends the segment — it just keeps
          listening. That is what makes this feel like it is waiting for you
          rather than sampling on a clock, and it is why the first version
          chopped sentences in half.
        */
        const done =
          (heardSpeech && quietFor >= SILENCE_MS) || Date.now() - startedAt >= MAX_SEGMENT_MS;
        if (done) {
          window.clearInterval(timer);
          if (recorder.state !== "inactive") recorder.stop();
        }
      }, TICK_MS);
    };

    runSegment();

    return () => {
      stoppedRef.current = true;
      window.clearInterval(timer);
    };
  }, [enabled, mic.active, mic.streamRef, mic.levelRef]);

  return { lines, working, error, status, clear: () => setLines([]) };
}
