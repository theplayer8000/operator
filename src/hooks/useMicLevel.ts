import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The microphone in whatever device is holding the page, read locally.
 *
 * The owner's ask: *"still also need that instant like feed back when talking
 * any ideas on how wr do thst"*. This is the answer, and the important part is
 * what it does NOT do — it never touches the network.
 *
 * `useVoiceActivity` polls `/api/listen` every 250ms for the level of the
 * microphone attached to the *server*. That is right for the wall display,
 * which is showing you the room the server is in. It is hopeless as feedback
 * while you speak: every update is a round trip, so the response always lags
 * your voice by a visible fraction of a second, and polling faster only makes
 * it a busier kind of late.
 *
 * An `AnalyserNode` reads the waveform in this tab at frame rate. Zero
 * latency, nothing in flight, and it works when the server's microphone is
 * disconnected — which is the normal state of the owner's Bluetooth headset.
 *
 * ## Why this became possible
 *
 * `getUserMedia` requires a secure context. `docs/known-issues.md` says
 * Operator is reached "at a bare IP, so every secure-context API is still
 * unavailable" — that was true, and is now out of date: `tailscale serve`
 * publishes the app at `https://<machine>.<tailnet>.ts.net` with a real
 * certificate. Reached by that hostname the page is secure and the microphone
 * is available; reached by a bare `100.x` address it is not, and `error` says
 * so rather than failing mysteriously.
 *
 * ## The level is a ref, deliberately
 *
 * Sixty state updates a second would re-render the tree sixty times a second
 * to move one circle. The canvas reads `levelRef.current` inside its own
 * animation frame instead, so the whole thing costs one number per frame.
 */

export interface MicLevel {
  /** Live 0–1 peak. Read inside a rAF loop; it changes every frame. */
  levelRef: React.MutableRefObject<number>;
  /** The stream is open. */
  active: boolean;
  /** Why it is not open, when the owner tried and it did not work. */
  error: string | null;
  /** Browser could do this at all. False on an insecure origin. */
  supported: boolean;
  /** Must be called from a user gesture — browsers require one, iOS strictly. */
  enable: () => Promise<void>;
  disable: () => void;
}

export function useMicLevel(): MicLevel {
  const levelRef = useRef(0);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    // The same test the browser applies. Stated explicitly so the UI can say
    // "open it over https://…ts.net" instead of showing a dead button.
    (window.isSecureContext ?? false);

  const disable = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    levelRef.current = 0;
    setActive(false);
  }, []);

  const enable = useCallback(async () => {
    if (streamRef.current) return;
    setError(null);

    if (!supported) {
      setError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "The microphone needs a secure page — open Operator at its https://…ts.net address rather than a bare IP."
          : "This browser will not give a page the microphone.",
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          /*
            Let the platform clean the signal up. The owner's own microphones
            are poor — his speech peaked at 0.0009 against a 0.0007 room floor
            on the desktop rig — and a phone's built-in processing is far
            better than anything worth reimplementing here.
          */
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) throw new Error("no AudioContext");
      const ctx = new AudioCtor();
      ctxRef.current = ctx;

      // iOS starts an AudioContext suspended until a gesture resumes it. Since
      // enable() is already called from one, this is the moment to do it.
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      // Small window: this measures loudness, not pitch. 512 samples is about
      // 10ms at 48kHz — responsive enough to track a syllable.
      analyser.fftSize = 512;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      const read = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          // Byte data is centred on 128; distance from centre is amplitude.
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        /*
          Fast attack, slow release.

          Tracking the raw peak makes the core flicker on every consonant,
          which reads as broken rather than responsive. Rising instantly and
          falling gently is how a level meter has always behaved, and it is
          what makes speech look like one continuous thing.
        */
        levelRef.current = peak > levelRef.current ? peak : levelRef.current * 0.88 + peak * 0.12;
        rafRef.current = requestAnimationFrame(read);
      };
      rafRef.current = requestAnimationFrame(read);
      setActive(true);
    } catch (err) {
      const name = (err as Error)?.name;
      setError(
        name === "NotAllowedError"
          ? "Microphone permission was refused. Allow it in the site settings and try again."
          : name === "NotFoundError"
            ? "No microphone on this device."
            : ((err as Error)?.message ?? "Could not open the microphone."),
      );
      disable();
    }
  }, [supported, disable]);

  // Release the microphone on unmount. A stream left open keeps the recording
  // indicator lit, which on a phone looks exactly like an app spying on you.
  useEffect(() => disable, [disable]);

  return { levelRef, active, error, supported, enable, disable };
}
