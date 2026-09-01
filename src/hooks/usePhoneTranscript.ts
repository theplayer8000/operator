import { useEffect, useRef, useState } from "react";
import type { MicLevel } from "./useMicLevel";

/**
 * What this phone is hearing, in words.
 *
 * The owner turned the microphone on, watched the core move with his voice,
 * and asked the obvious question: *"mic works on phone so why isnt the thing
 * working"*. Because the level was local and the WORDS were not — Whisper was
 * listening to the microphone attached to the PC, in a different room. This
 * closes that gap: the phone records itself and posts the audio to Operator's
 * own server.
 *
 * ## Not the browser's speech recognition
 *
 * `SpeechRecognition` exists and would have been one line. On iOS it sends the
 * audio to **Apple** — an external host under CLAUDE.md's approval rule, and
 * his voice rather than a prompt. He has approved no such thing. The whole
 * path here stays on hardware he owns: phone → his server over the tailnet →
 * the resident Whisper the clap gesture already uses.
 *
 * ## Segments, not a stream
 *
 * Audio is recorded in fixed slices and each is posted whole. A `MediaRecorder`
 * timeslice would be cheaper, but only the FIRST chunk of a WebM stream carries
 * the container header — every later chunk on its own is undecodable. Whole
 * segments are slightly wasteful and always readable.
 *
 * Silence is never uploaded. It costs a round trip and CPU, and feeding Whisper
 * silence is precisely what produced twenty phantom jobs on 2026-08-31.
 */

/** How much audio per segment. Long enough for a sentence, short enough to feel live. */
const SEGMENT_MS = 4000;
/**
 * Below this peak the segment is treated as silence and never sent.
 *
 * 0.02, not the 0.06 first guessed. A phone applies aggressive auto-gain and
 * noise suppression, which flattens peaks — the bar has to sit above room tone
 * and below normal speech, and guessing it high means the feature does nothing
 * and says nothing, which is exactly how it first behaved.
 */
const SILENCE_PEAK = 0.02;

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
   * into one readable line.
   */
  status: string;
  clear: () => void;
}

export function usePhoneTranscript(mic: MicLevel, enabled: boolean): PhoneTranscript {
  const [lines, setLines] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("starting…");

  const recorderRef = useRef<MediaRecorder | null>(null);
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

    let levelTimer = 0;

    const runSegment = () => {
      if (stoppedRef.current) return;

      /*
        Per-segment, NOT shared across segments.

        It was one variable in the enclosing scope, and `onstop` starts the
        next segment before checking the finished one's peak — so the check
        read a value that had just been reset to zero, and every segment was
        reported "quiet" however loudly he spoke. Closing over it per segment
        is what makes the measurement belong to the recording it describes.
      */
      let peak = 0;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      } catch (err) {
        setError(`Could not record: ${(err as Error)?.message ?? err}`);
        setStatus("MediaRecorder refused this stream");
        return;
      }
      recorderRef.current = recorder;
      const parts: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(parts, { type: recorder.mimeType || "audio/webm" });
        // Queue the next segment immediately, so a slow upload does not create
        // a gap in which he can say something that is never heard.
        if (!stoppedRef.current) runSegment();

        /*
          Say why a segment was dropped rather than dropping it quietly. Both
          of these are normal and both look like a broken feature.
        */
        if (blob.size < 800) {
          setStatus(`recorded ${blob.size}B — too small to send`);
          return;
        }
        if (peak < SILENCE_PEAK) {
          setStatus(`quiet (peak ${peak.toFixed(3)} < ${SILENCE_PEAK})`);
          return;
        }
        setStatus(`sending ${(blob.size / 1024).toFixed(0)}KB, peak ${peak.toFixed(2)}`);

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
            setStatus(`heard it (${(blob.size / 1024).toFixed(0)}KB)`);
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
      // Sample the live level while this segment records, so silence can be
      // discarded without decoding the audio.
      const myTimer = window.setInterval(() => {
        const v = mic.levelRef.current;
        if (v > peak) peak = v;
      }, 60);
      levelTimer = myTimer;

      window.setTimeout(() => {
        // Clear THIS segment's timer, not whatever the shared variable points
        // at by now — the next segment may already own it.
        window.clearInterval(myTimer);
        if (recorder.state !== "inactive") recorder.stop();
      }, SEGMENT_MS);
    };

    runSegment();

    return () => {
      stoppedRef.current = true;
      window.clearInterval(levelTimer);
      const r = recorderRef.current;
      if (r && r.state !== "inactive") r.stop();
      recorderRef.current = null;
    };
  }, [enabled, mic.active, mic.streamRef, mic.levelRef]);

  return { lines, working, error, status, clear: () => setLines([]) };
}
