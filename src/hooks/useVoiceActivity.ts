import { useEffect, useRef, useState } from "react";

/**
 * What the room sounds like, for anything that wants to react to a voice.
 *
 * The owner's brief: the mission map should pulse when Operator hears him, and
 * pulse differently when it answers. So the voice interface is not a widget
 * bolted next to the graph — it *is* the graph. This hook is the signal that
 * makes that possible, and it owns no rendering.
 *
 * ## Two sources, deliberately
 *
 * **Hearing** comes from the server (`/api/listen`), because the microphone is
 * held by `server/listen.mjs` and a browser opening a second one gets digital
 * silence — measured, and it cost an evening.
 *
 * **Speaking** is read straight from `speechSynthesis`, because speech out
 * happens in this browser and the server genuinely does not know about it.
 * Asking the server would be inventing a round trip to learn something the page
 * already has.
 *
 * ## Polling, and why this one is fast
 *
 * 250ms, against 10s for the client monitor and 2s for jobs. A meter that lags
 * a second behind a voice reads as broken rather than slow — this is the one
 * place in the app where latency is the feature. The route it hits is the
 * cheapest in `server/index.mjs`: four numbers already in memory.
 *
 * It stops entirely when the tab is hidden. There is nothing to animate and a
 * background tab polling four times a second for a meter nobody can see is the
 * kind of thing that quietly costs a phone its battery.
 */

export interface VoiceActivity {
  /** The microphone is open on the server. */
  listening: boolean;
  /** Loudest recent sample, 0–1. */
  level: number;
  /** The bar a clap has to beat, so a UI can show where the line is. */
  threshold: number;
  /** Operator is talking, from `speechSynthesis` in this browser. */
  speaking: boolean;
  /** Rises on every clap heard — useful for a one-shot flash. */
  claps: number;
  /** Set when the listener is off or broken, so a UI can stay honest. */
  reason: string | null;
}

const POLL_MS = 250;

export function useVoiceActivity(enabled = true): VoiceActivity {
  const [activity, setActivity] = useState<VoiceActivity>({
    listening: false,
    level: 0,
    threshold: 0,
    speaking: false,
    claps: 0,
    reason: null,
  });

  /*
    One request in flight at a time. At 250ms a slow response would otherwise
    stack requests behind each other and the meter would arrive in bursts —
    the same failure the job poller was written to avoid.
  */
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;

    /*
      Speaking is read every tick regardless of what the network did.

      It deliberately does NOT live inside the fetch: speech out is local, so
      on a machine with no microphone — where `/api/listen` fails every time —
      the speaking indicator must still work. Folding it into the success path
      would silently couple "Operator can talk" to "Operator can hear", which
      are unrelated and fail independently.
    */
    const speakingNow = () =>
      typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis.speaking
        : false;

    const tick = async () => {
      if (stopped) return;

      /*
        A hidden tab reports silence rather than freezing.

        Skipping the poll and keeping the last value would leave a map glowing
        mid-syllable for as long as the tab stays in the background, and it
        would still be glowing when you came back — showing a level that was
        true a minute ago.
      */
      if (typeof document !== "undefined" && document.hidden) {
        setActivity((prev) =>
          prev.level === 0 && !prev.speaking ? prev : { ...prev, level: 0, speaking: false },
        );
        return;
      }

      setActivity((prev) => (prev.speaking === speakingNow() ? prev : { ...prev, speaking: speakingNow() }));

      // One request in flight at a time. At 250ms a slow response would
      // otherwise stack requests and the meter would arrive in bursts.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/listen", { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Omit<VoiceActivity, "speaking">;
        if (stopped) return;
        setActivity((prev) => ({ ...prev, ...body }));
      } catch {
        /*
          Silent. The listener being off is the normal case on a machine with
          no microphone configured, and an error banner for it would be noise
          on every page that reacts to voice. `listening: false` already says
          everything a UI needs.
        */
        if (!stopped) setActivity((prev) => ({ ...prev, listening: false, level: 0 }));
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return activity;
}
