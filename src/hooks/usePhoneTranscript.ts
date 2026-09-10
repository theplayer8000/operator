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

/**
 * Quiet for this long, after speech, ends the sentence.
 *
 * 1200ms, down from the 2000 he originally asked for. Measured 2026-09-01: the
 * round trip from silence to text on screen is this wait plus 287ms of upload
 * and transcription — so the perceived "it says transcribing then takes a
 * while" was almost entirely this constant, not the model.
 *
 * Not lower than this. Below about a second it starts cutting on the pause
 * between clauses, and half a sentence transcribed confidently is worse than
 * waiting: the wrong half gets sent somewhere.
 */
const SILENCE_MS = 1200;
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
/**
 * Keep treating the room as Operator's for this long after it stops talking.
 *
 * The flag drops the instant playback ends, but the ROOM does not: a speaker
 * across the desk keeps reverberating, and the last syllable arrives at the
 * microphone after the audio element has already fired `ended`. Without a tail
 * the closing word of Operator's own sentence starts a fresh segment and gets
 * transcribed as his.
 *
 * This matters here specifically because echo cancellation cannot help. It
 * works by referencing the playback stream, and the owner plays through
 * SPEAKERS while listening on a BLUETOOTH HEADSET — two devices, no shared
 * clock, nothing for the canceller to subtract. `echoCancellation: true` is
 * set and is simply inert in that arrangement.
 *
 * 400ms: long enough for a small room's decay, short enough that answering
 * immediately still works.
 */
const SPEECH_TAIL_MS = 400;

export interface PhoneTranscript {
  /** Most recent lines heard, newest last. Capped. */
  lines: string[];
  /** A segment is being transcribed right now. */
  working: boolean;
  /** Last failure, if the upload or transcription broke. */
  error: string | null;
  /**
   * The most recent thing heard, and whether the server already acted on it.
   *
   * `handled` is the flag the page needs before forwarding a sentence to a
   * worker: an intent that ran has already changed the data, and sending it on
   * as well would ask Claude to do it a second time at Claude's price.
   */
  last: { text: string; handled: boolean; say: string; stopped: boolean } | null;
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

export function usePhoneTranscript(
  mic: MicLevel,
  enabled: boolean,
  /**
   * True while Operator is talking.
   *
   * A microphone in the same room as a speaker hears the speaker. The very
   * first miss the digest turned up was Operator's own sentence — "Sorry, say
   * that again please, I didn't quite hear you." — recorded, uploaded and
   * transcribed as though he had said it. Left alone that is a feedback loop:
   * it answers, hears itself, and answers again.
   *
   * `server/listen.mjs` has had `muteBriefly` for this since the clap detector
   * was triggering on Operator's own voice through the speakers. The browser
   * microphone had no equivalent.
   */
  speaking = false,
): PhoneTranscript {
  const [lines, setLines] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("waiting for you to speak");
  const [last, setLast] = useState<
    { text: string; handled: boolean; say: string; stopped: boolean } | null
  >(null);
  /*
    Through a ref so the recording effect never restarts when a sentence
    lands — tearing down the MediaRecorder to publish a result would drop the
    next thing he says.
  */
  const setHandledRef = useRef(setLast);
  setHandledRef.current = setLast;

  const stoppedRef = useRef(false);
  /*
    Read through a ref so a change while recording does not restart the loop —
    the segment in flight needs to KNOW he spoke, not be torn down for it.
  */
  const speakingRef = useRef(speaking);
  /** When Operator last stopped talking, for the tail above. */
  const spokeUntil = useRef(0);
  if (speakingRef.current && !speaking) spokeUntil.current = Date.now();
  speakingRef.current = speaking;

  /** Operator is talking, or was recently enough that the room still is. */
  const roomIsOperators = () =>
    speakingRef.current || Date.now() - spokeUntil.current < SPEECH_TAIL_MS;

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
      /*
        The loudest the mic got this segment, even below SPEECH_PEAK. Only used
        to make "waiting for you to speak" say WHY it is still waiting — a dead
        or silent input (0%) reads completely differently from a live one that
        is just too quiet (1%), and the two were indistinguishable from the
        phone before.
      */
      let maxSeen = 0;
      /*
        Set if Operator spoke at any point during this recording. The whole
        segment is discarded rather than trimmed — a sentence half his and half
        Operator's is worse than no sentence, because the half that survives is
        still confidently sent somewhere.
      */
      let overlappedSpeech = false;
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

        /*
          NOT discarded outright when Operator was talking.

          The self-hearing guard was right about the feedback loop and wrong
          about the one case that matters most: interrupting. "Stop" is said
          precisely WHILE it is talking, so discarding overlapped audio
          client-side meant the barge-in could never arrive.

          It is uploaded with a flag instead, and the server honours nothing
          from an overlapped segment except a stop. The loop stays closed —
          Operator's own sentence cannot become a request — while the one word
          that has to get through, gets through.
        */
        if (!heardSpeech) {
          setStatus(
            maxSeen < 0.005
              ? "waiting — the mic is on but reading silence (wrong input, muted, or its level is at zero)"
              : `waiting — heard ${(maxSeen * 100).toFixed(0)}%, needs ${SPEECH_PEAK * 100}% (speak up, or raise the input level)`,
          );
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
            headers: {
              "content-type": blob.type || "application/octet-stream",
              // Tells the server this may contain Operator's own voice, so
              // nothing but a stop command may come out of it.
              ...(overlappedSpeech ? { "x-overlapped": "1" } : {}),
            },
            body: blob,
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body?.reason ?? body?.error ?? `server said ${res.status}`);
          const text = String(body?.text ?? "").trim();
          if (text) {
            setError(null);
            /*
              The server may have already DONE it.

              `server/intent.mjs` turns a spoken sentence into a capability
              action with no model in the loop, so "tick off bench press" is
              handled in microseconds server-side and never becomes a job.
              `handled` says so, and it must be honoured even when the intent
              only got as far as a question ("did you mean X or Y?") — sending
              that on to a worker would treat his answer as a fresh request.
            */
            const handled = Boolean(body?.handled);
            setStatus(handled ? String(body?.say ?? "done") : "heard it");
            // Capped: this is a glance under the core, not a document.
            setLines((prev) => [...prev, text].slice(-6));
            setHandledRef.current({
              text,
              handled,
              say: String(body?.say ?? ""),
              stopped: Boolean(body?.command?.stop),
            });
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
        if (roomIsOperators()) overlappedSpeech = true;
        const v = mic.levelRef.current;
        ticks += 1;
        if (v > maxSeen) maxSeen = v;

        if (v >= SPEECH_PEAK) {
          voicedTicks += 1;
          heardSpeech = true;
          quietFor = 0;
        } else if (heardSpeech) {
          quietFor += TICK_MS;
        }

        /*
          Say WHY it is still waiting, live, without ending the segment — a
          segment with no speech only ends at the 20s cap, so onstop's
          diagnostic would be 20s late. Throttled, and only once it has been
          quiet long enough that "still waiting" is a real state rather than
          the half-second before someone starts talking.
        */
        if (!heardSpeech && Date.now() - startedAt > 3000 && ticks % 20 === 0) {
          setStatus(
            maxSeen < 0.005
              ? "waiting — mic on but reading silence (wrong input, muted, or level at zero)"
              : `waiting — heard ${(maxSeen * 100).toFixed(0)}%, needs ${SPEECH_PEAK * 100}% (speak up / raise the input)`,
          );
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

  return { lines, working, error, status, last, clear: () => setLines([]) };
}
