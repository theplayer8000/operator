import { useCallback, useEffect, useRef, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * Two claps, to summon Operator. Phase 4b of `docs/presence-layer-design.md`.
 *
 * ## Why this is cheap, and why that matters
 *
 * A clap is a sharp amplitude transient, so detecting two inside a window is
 * arithmetic over `AnalyserNode` output — **no model, no dependency, and no
 * audio leaving the page**, not even to Operator's own server. That is a better
 * privacy position than a wake *word*, which has to understand speech to know
 * it was said, and it is why this is buildable now while speech input is not.
 *
 * ## What it costs, stated where it is implemented
 *
 * **The microphone is open the whole time it is armed.** Nothing is recorded,
 * stored or transmitted — the analyser reads a rolling buffer and keeps
 * nothing — but the browser will show its recording indicator and the tab holds
 * the device. That is a posture change, so it is off by default, per-device,
 * and never enabled as a side effect of turning on speech.
 *
 * `getUserMedia` is also **secure-context gated**: this works on
 * `https://<host>.<tailnet>.ts.net` and never at a bare tailnet IP. Third
 * feature to hit that (after the clipboard and `crypto.randomUUID`), and it
 * presents as a permissions failure with no explanation, so `reason` says so
 * explicitly rather than leaving it to be discovered.
 */

const ENABLED_KEY = "clap.enabled";

/*
  Above this fraction of full scale counts as a transient worth considering.

  Lowered from 0.34 after the owner's claps stopped registering: he had swapped
  to a wired headset, and `autoGainControl: false` (which this needs, or the
  gain rides the transient away) means a quieter input simply never reaches a
  fixed bar. A threshold picked without seeing a level meter is a guess, which
  is why there is now a level meter — see `level` below.
*/
const PEAK_THRESHOLD = Number(
  typeof localStorage !== "undefined" ? (localStorage.getItem("os.clap.threshold") ?? "") : "",
) || 0.18;
/** A clap is over fast. Anything sustained above threshold is not one. */
const MAX_CLAP_MS = 140;
/** Two claps must fall inside this window to count as the gesture. */
const MIN_GAP_MS = 90;
const MAX_GAP_MS = 700;
/** Ignore everything for this long after firing, so one gesture fires once. */
const COOLDOWN_MS = 1500;

export interface ClapState {
  supported: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** True once the mic is actually open — not the same as `enabled`. */
  listening: boolean;
  /** Why it is not listening, when that needs saying. */
  reason: string | null;
  /**
   * Loudest thing heard recently, 0–1, and the threshold it has to beat.
   *
   * Exposed so the UI can show a meter. Without one, "clapping does nothing"
   * has three indistinguishable causes — the mic is not open, the mic is open
   * but hears nothing, or it hears you and the bar is too high — and only the
   * third is a number I can change. A meter tells all three apart at a glance.
   */
  level: number;
  threshold: number;
  /** How many claps it has heard since arming. Proof it is working at all. */
  claps: number;
}

/**
 * @param onDoubleClap fired on the SECOND clap, deliberately — the caller
 *   opens its capture buffer here so anything said during the transition is
 *   caught. Waiting until after a view switch makes the interaction
 *   clap-wait-talk, which is worse than a keyboard shortcut.
 * @param muted while true, detection pauses. Pass `speech.speaking`: Operator
 *   talking through the speakers the mic can hear is how a clap detector
 *   triggers on itself.
 */
export function useClapListener(onDoubleClap: () => void, muted = false): ClapState {
  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    ("AudioContext" in window || "webkitAudioContext" in window);

  const [enabled, setEnabledState] = useState<boolean>(() =>
    readStorage<boolean>(ENABLED_KEY, false),
  );
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [claps, setClaps] = useState(0);
  /*
    Say why it cannot work, without waiting to be switched on.

    The first version only set a reason after `enabled` — so where the browser
    has no microphone API at all, the caller hid the control and there was
    nothing on screen at all. At a bare tailnet IP that is exactly the case:
    `navigator.mediaDevices` is undefined outside a secure context, so the
    feature silently did not exist rather than explaining itself. Which is the
    single most likely thing to be wrong, and was the hardest state to debug.
  */
  const [reason, setReason] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    /*
      `Boolean(...)` rather than a bare truthiness test, because TypeScript's
      DOM types declare `getUserMedia` as always defined and reject the check as
      redundant. It is not: outside a secure context `navigator.mediaDevices` is
      undefined entirely, which is precisely the case being detected here.
    */
    if (
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      ("AudioContext" in window || "webkitAudioContext" in window)
    ) {
      return null;
    }
    return window.isSecureContext
      ? "This browser has no microphone access."
      : "Needs the https address — a microphone is unavailable at a bare IP or over plain http.";
  });

  // Kept in refs so the audio loop never re-subscribes; it must not restart
  // every time a parent re-renders.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const callbackRef = useRef(onDoubleClap);
  callbackRef.current = onDoubleClap;

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writeStorage(ENABLED_KEY, on);
    if (!on) setReason(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!supported) {
      setReason(
        window.isSecureContext
          ? "This browser has no microphone access."
          : "Needs the https address — a microphone is unavailable at a bare IP.",
      );
      return;
    }

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    /*
      Transient state for the detector. Deliberately local to this effect
      rather than component state: it changes many times a second and nothing
      renders from it, so putting it in React would be a re-render per audio
      frame for no visible reason.
    */
    let aboveSince = 0;
    let lastClapAt = 0;
    let firstClapAt = 0;
    let cooldownUntil = 0;
    let peakHold = 0;
    let lastPublish = 0;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Every one of these would fight a clap detector: AGC re-levels the
            // transient away, noise suppression treats it as noise, and echo
            // cancellation is tuned for speech.
            autoGainControl: false,
            noiseSuppression: false,
            echoCancellation: false,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        context = new Ctor();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        // Small window: a clap is short, and a large FFT smears it into the
        // frames either side.
        analyser.fftSize = 512;
        source.connect(analyser);

        const buffer = new Uint8Array(analyser.fftSize);
        setListening(true);
        setReason(null);

        const tick = () => {
          if (cancelled) return;
          frame = requestAnimationFrame(tick);
          if (mutedRef.current) return;

          analyser.getByteTimeDomainData(buffer);
          // Peak deviation from the 128 midpoint, as a fraction of full scale.
          let peak = 0;
          for (let i = 0; i < buffer.length; i++) {
            const v = Math.abs(buffer[i] - 128) / 128;
            if (v > peak) peak = v;
          }

          const now = performance.now();

          /*
            Publish the level, but only a few times a second.

            The audio loop runs at frame rate; calling setState on every frame
            would re-render the whole layout 60 times a second to move a meter
            two pixels. A decaying peak also reads far better than an
            instantaneous one — a clap is over in a few frames and would
            otherwise be a flicker nobody could see.
          */
          if (peak > peakHold) peakHold = peak;
          if (now - lastPublish > 100) {
            lastPublish = now;
            setLevel(peakHold);
            peakHold *= 0.55;
          }

          if (now < cooldownUntil) return;

          if (peak >= PEAK_THRESHOLD) {
            if (!aboveSince) aboveSince = now;
            return;
          }

          // Just dropped back below threshold — was that a clap?
          if (!aboveSince) return;
          const duration = now - aboveSince;
          aboveSince = 0;
          // Sustained loudness is music or a voice, not a clap.
          if (duration > MAX_CLAP_MS) return;

          const sinceLast = now - lastClapAt;
          lastClapAt = now;

          if (firstClapAt && sinceLast >= MIN_GAP_MS && sinceLast <= MAX_GAP_MS) {
            firstClapAt = 0;
            cooldownUntil = now + COOLDOWN_MS;
            setClaps((n) => n + 1);
            callbackRef.current();
            return;
          }
          firstClapAt = now;
        };
        frame = requestAnimationFrame(tick);
      } catch (err) {
        const name = (err as { name?: string })?.name;
        setListening(false);
        setReason(
          name === "NotAllowedError"
            ? "Microphone permission was refused for this site."
            : name === "NotFoundError"
              ? "No microphone found on this device."
              : `Couldn't open the microphone: ${String((err as Error)?.message ?? err)}`,
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // Release the device rather than leaving the recording indicator on
      // after the page has moved on.
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
      setListening(false);
      setLevel(0);
    };
  }, [enabled, supported]);

  return { supported, enabled, setEnabled, listening, reason, level, threshold: PEAK_THRESHOLD, claps };
}
