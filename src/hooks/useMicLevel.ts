import { useCallback, useEffect, useRef, useState } from "react";
import { readStorage, writeStorage, removeStorage } from "@/lib/storage";

/**
 * The microphone the owner last chose from the picker, remembered per browser.
 *
 * `enable()` with no argument used to hand the choice to the platform default —
 * which on the owner's Windows box was the webcam's microphone, garbled enough
 * that Discord calls were unintelligible, sitting in front of the XLR boom mic
 * he actually wanted. So every time the mic was switched on he had to reopen
 * the picker and choose the right one again.
 *
 * This is stored per browser rather than in the synced store on purpose: a
 * `deviceId` is scoped to one origin in one browser and is stable there once
 * permission has been granted, but means nothing on the phone. The label rides
 * along only so the picker and the logs can say which one is pinned. If the
 * remembered device is gone at open time the constraint throws and `enable()`
 * forgets it and falls back to the default — see below. There is deliberately
 * no hardcoded "YU8" anywhere: the owner picks once and the choice is what
 * persists.
 */
const PREFERRED_MIC_KEY = "mic.preferredInput";
type PreferredMic = { deviceId: string; label: string | null };

const readPreferredMic = (): PreferredMic | null => {
  const saved = readStorage<PreferredMic | null>(PREFERRED_MIC_KEY, null);
  return saved && typeof saved.deviceId === "string" && saved.deviceId ? saved : null;
};
const rememberPreferredMic = (deviceId: string, label: string | null): void => {
  if (deviceId && deviceId !== "default" && deviceId !== "communications") {
    writeStorage<PreferredMic>(PREFERRED_MIC_KEY, { deviceId, label });
  }
};
const forgetPreferredMic = (): void => removeStorage(PREFERRED_MIC_KEY);

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
  /**
   * The open stream, for anything that needs the audio rather than its level.
   *
   * Shared rather than opened twice: a second `getUserMedia` on the same device
   * is a second permission prompt at best, and on some platforms it returns a
   * silent track — the exact failure that cost an evening on the desktop side
   * when two ffmpeg processes fought over one dshow device.
   */
  streamRef: React.MutableRefObject<MediaStream | null>;
  /** The stream is open. */
  active: boolean;
  /**
   * A permission prompt or device open is genuinely in flight.
   *
   * Distinct from "not active", which is also the resting state. The picker
   * spun a spinner on `!active && !error` and so span forever whenever the
   * microphone had simply never been switched on — a progress indicator for
   * something nobody had started.
   */
  connecting: boolean;
  /**
   * The microphone the browser actually chose, as the OS names it.
   *
   * "This device" is not a device — it is whatever the platform considers the
   * default input, which on a machine with three of them is a real question.
   * The owner asked it the moment the thing started working ("which device is
   * it picking off rn cuz its working wth"), and a picker that cannot answer
   * that is hiding the one fact he needs.
   *
   * Only available once permission has been granted; before that browsers
   * report an empty label deliberately, since the list of your microphones is
   * itself identifying.
   */
  deviceLabel: string | null;
  /**
   * Every microphone this browser can offer, so one can be CHOSEN.
   *
   * Without this, `getUserMedia({audio: true})` takes whatever Windows calls
   * the default — which on the owner's machine is the Bluetooth headset that
   * disconnects constantly, not the Realtek sitting next to it. "This device"
   * then looked like a setting while actually being someone else's decision.
   *
   * Labels are empty until permission has been granted at least once: the list
   * of your microphones is itself identifying, so browsers withhold it.
   */
  devices: MediaDeviceInfo[];
  /** Why it is not open, when the owner tried and it did not work. */
  error: string | null;
  /** Browser could do this at all. False on an insecure origin. */
  supported: boolean;
  /**
   * Must be called from a user gesture — browsers require one, iOS strictly.
   * Pass a `deviceId` to open a specific microphone rather than the default.
   */
  enable: (deviceId?: string) => Promise<void>;
  disable: () => void;
}

export function useMicLevel(): MicLevel {
  const levelRef = useRef(0);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  /*
    A stable handle on `enable`, so the track's "ended" listener can call it
    without the callback capturing an older version of itself.
  */
  const enableRef = useRef<((deviceId?: string) => Promise<void>) | null>(null);

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
    setDeviceLabel(null);
    setConnecting(false);
    setActive(false);
  }, []);

  const enable = useCallback(async (deviceId?: string) => {
    // Already open on the microphone being asked for: nothing to do. Asking
    // for a DIFFERENT one means closing this stream first, or the old track
    // keeps the level meter alive on the wrong device.
    if (streamRef.current) {
      const current = streamRef.current.getAudioTracks()[0];
      if (!deviceId || current?.getSettings().deviceId === deviceId) return;
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      cancelAnimationFrame(rafRef.current);
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    }
    setError(null);
    setConnecting(true);

    if (!supported) {
      setError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "The microphone needs a secure page — open Operator at its https://…ts.net address rather than a bare IP."
          : "This browser will not give a page the microphone.",
      );
      setConnecting(false);
      return;
    }

    /*
      Create and resume the AudioContext NOW, while still inside the user
      gesture — before the `getUserMedia` await below.

      iOS only resumes an AudioContext from a genuine gesture, and an `await`
      ends the gesture. Creating it after `getUserMedia` resolved (which is
      what this did until 2026-09-10) left it `suspended` on iOS: the
      microphone opened, the track was live, and the analyser read nothing but
      silence forever — which presented as "the mic is on but it never hears
      me". The `read()` loop below also retries `resume()` as a backstop.
    */
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) {
      setError("This browser has no AudioContext, so the level meter cannot run.");
      setConnecting(false);
      return;
    }
    const ctx = new AudioCtor();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    /*
      No explicit choice from the picker — reach for the one the owner last
      chose here rather than the platform default (which was the garbled webcam
      mic). Falls through to the default when nothing is remembered or the
      remembered device has since been unplugged (OverconstrainedError below).
    */
    const preferred = deviceId ? null : readPreferredMic();
    const wantedId = deviceId ?? preferred?.deviceId;

    const audioConstraints = (id: string | undefined): MediaTrackConstraints => ({
      ...(id ? { deviceId: { exact: id } } : {}),
      /*
        Let the platform clean the signal up. The owner's own microphones
        are poor — his speech peaked at 0.0009 against a 0.0007 room floor
        on the desktop rig — and a phone's built-in processing is far
        better than anything worth reimplementing here.
      */
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(wantedId) });
      } catch (err) {
        // A remembered microphone that has since been unplugged throws
        // OverconstrainedError. Forget it and open the default instead — a
        // dead "mic on" button is worse than the wrong microphone.
        if ((err as Error)?.name === "OverconstrainedError" && wantedId && wantedId !== deviceId) {
          forgetPreferredMic();
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(undefined) });
        } else {
          throw err;
        }
      }
      streamRef.current = stream;

      /*
        Bluetooth headsets drop their microphone when audio plays.

        A headset runs either HFP (microphone works, playback is poor) or A2DP
        (playback is good, there is no microphone). Windows switches profile
        when something plays — so Operator SPEAKING kills the very microphone
        that was listening to him, and the owner sees "it keeps on turning the
        mic off" with no obvious cause.

        The track ends rather than erroring, so nothing throws and nothing
        reports a failure; it simply goes quiet forever. Watching for that and
        reopening is the only way back, and it is why this cannot just be left
        to the user noticing.
      */
      const track = stream.getAudioTracks()[0];
      track?.addEventListener("ended", () => {
        // Only if this is still the live stream — a deliberate disable() also
        // ends the track, and reopening then would be fighting the user.
        if (streamRef.current !== stream) return;
        console.info("[operator] microphone ended (likely a Bluetooth profile switch) — reopening");
        const id = track.getSettings().deviceId;
        disable();
        // A beat, so the profile switch finishes before we ask for it back.
        window.setTimeout(() => void enableRef.current?.(id), 800);
      });
      // What the platform actually handed over, which is the only honest
      // answer to "which microphone is this".
      const openedLabel = stream.getAudioTracks()[0]?.label || null;
      setDeviceLabel(openedLabel);

      /*
        An explicit pick from the picker becomes the remembered default for
        next time. `getSettings().deviceId` is the real id even when the caller
        passed `default`/`communications`, so re-selecting the OS default still
        pins the concrete device behind it.
      */
      if (deviceId) {
        rememberPreferredMic(track?.getSettings().deviceId || deviceId, openedLabel);
      }

      /*
        Enumerate only AFTER permission, because that is when labels exist.
        Doing it earlier returns a list of blank entries, which is worse than
        no list — it looks like a broken picker rather than a locked one.
      */
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        /*
          Windows publishes ALIASES next to the real inputs: a "Default -
          Microphone (…)" and a "Communications - Microphone (…)" pointing at
          whatever is currently selected in the control panel. Listing them
          makes one microphone appear three times, which is what the owner was
          looking at when he asked "ehh whats all this".

          They are filtered by the `default`/`communications` deviceId rather
          than by their label, because the label prefix is localised and the id
          is not.
        */
        setDevices(
          all.filter(
            (d) =>
              d.kind === "audioinput" &&
              d.deviceId &&
              d.deviceId !== "default" &&
              d.deviceId !== "communications",
          ),
        );
      } catch {
        /* Not fatal: the microphone still works, it just cannot be re-chosen. */
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      // Small window: this measures loudness, not pitch. 512 samples is about
      // 10ms at 48kHz — responsive enough to track a syllable.
      analyser.fftSize = 512;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      const read = () => {
        // Backstop for the resume above: a context that lost the gesture, or
        // one auto-suspended by the OS after a while, otherwise reads pure
        // silence and the meter dies without a word.
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
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
      setConnecting(false);
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

  enableRef.current = enable;

  // Release the microphone on unmount. A stream left open keeps the recording
  // indicator lit, which on a phone looks exactly like an app spying on you.
  useEffect(() => disable, [disable]);

  return { levelRef, streamRef, active, connecting, error, supported, deviceLabel, devices, enable, disable };
}
