import { useCallback, useEffect, useRef, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * Operator speaking. Phase 1 of `docs/presence-layer-design.md`.
 *
 * ## Why this one is first
 *
 * It is the largest change in how the thing feels for the least risk. Speech
 * synthesis is on-device on both Windows and iOS, adds no dependency, and sends
 * nothing anywhere — unlike recognition, which streams audio to Google in
 * Chrome and is the reason ADR 0015 settled on local Whisper for the input
 * half.
 *
 * It is also **not secure-context gated**, so unlike the microphone (and the
 * camera, and `crypto.randomUUID`) it works at the bare tailnet IP as well as
 * the `https` hostname. That makes it the one part of voice with no deployment
 * caveat attached.
 *
 * ## The preference is local, deliberately
 *
 * Whether Operator talks out loud is a property of the DEVICE you are at, not
 * of the account. The desk should be able to speak while the phone in a quiet
 * room does not, and syncing it through the store would make one of those
 * choices overwrite the other. So it lives in `localStorage` and is the rare
 * case where that is the right home rather than an offline mirror.
 */

const ENABLED_KEY = "speech.enabled";
const VOICE_KEY = "speech.voice";
/**
 * Which speaker Operator talks through. Same reasoning as the two above: a
 * property of the device you are at, so `localStorage` rather than the store.
 */
const OUTPUT_KEY = "speech.output";

export interface SpeechState {
  /** False when the browser has no synthesis at all — hide the control, don't offer it. */
  supported: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Currently speaking, so the UI can show it and offer to stop. */
  speaking: boolean;
  voices: SpeechSynthesisVoice[];
  voiceName: string | null;
  setVoiceName: (name: string | null) => void;
  speak: (text: string) => void;
  stop: () => void;

  /**
   * This browser will let a page choose an output device at all.
   *
   * False on Safari and on every iOS browser, since they all run WebKit. The
   * UI must SAY that rather than showing a picker that quietly does nothing —
   * a dead control is how "I set it and it still echoes" becomes another
   * debugging round.
   */
  outputSupported: boolean;
  /** Speakers this browser can offer. Empty until it has been asked. */
  outputs: MediaDeviceInfo[];
  /** Chosen device id, or null for "whatever the system is using". */
  outputId: string | null;
  setOutputId: (id: string | null) => void;
  /**
   * True once device labels are readable.
   *
   * Browsers withhold them until the microphone has been granted once on this
   * origin — the list of your audio devices is itself identifying. Before that
   * the ids exist and the names do not, which is a picker of hex strings.
   */
  outputsNamed: boolean;
  /** Why the chosen speaker is not the one being used, when that happens. */
  outputError: string | null;
  /** Spend one microphone grant so the browser will name the devices. */
  nameOutputs: () => Promise<void>;
}

/**
 * Strip what should be heard from what is only meant to be read.
 *
 * A worker's reply is markdown written for a screen. Read aloud verbatim it
 * says "asterisk asterisk" and recites file paths character by character, which
 * is worse than silence — so code blocks go entirely (nobody wants a shell
 * command dictated), and the light formatting around prose is removed rather
 * than pronounced.
 */
export function speakableText(markdown: string): string {
  return (
    markdown
      // Fenced code: announce it rather than read it.
      .replace(/```[\s\S]*?```/g, " (code omitted) ")
      .replace(/`[^`]*`/g, " ")
      // Links: say the words, not the URL.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The best voice on this machine, when nothing has been chosen.
 *
 * Setting no voice at all hands it to the platform default, which is reliably
 * the worst one installed — on Windows that is a decades-old formant
 * synthesiser sitting next to perfectly good neural voices nobody selected.
 * The owner's "i need a voice for it" is mostly this: not a missing feature, a
 * default nobody picked.
 *
 * Preference order, best first:
 *
 *   1. Windows neural voices, which carry "Natural" in the name
 *   2. Apple's better tiers, marked "Premium" or "Enhanced"
 *   3. British English, because he is
 *   4. Any English voice at all
 *
 * A real improvement with no new dependency, and honest about its ceiling: a
 * genuinely good voice means Piper or similar, which is a binary to ship and
 * still queued.
 */
function bestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const pool = english.length ? english : voices;

  const byName = (needle: string) =>
    pool.find((v) => v.name.toLowerCase().includes(needle.toLowerCase()));

  return (
    byName("natural") ??
    byName("premium") ??
    byName("enhanced") ??
    pool.find((v) => v.lang?.toLowerCase() === "en-gb") ??
    pool[0] ??
    null
  );
}

/*
  Whether Operator is talking, readable from anywhere.

  Module scope rather than React state on purpose. Speech out happens inside
  one hook instance, but the thing that needs to know is the TRANSCRIBER on a
  different branch of the tree — a microphone in the same room as a speaker
  hears the speaker, and the first miss the digest turned up was Operator's own
  sentence transcribed as though the owner had said it.

  `useVoiceActivity` used to answer this by reading `speechSynthesis.speaking`,
  which was right until Kokoro arrived: Kokoro plays through an <audio> element
  and speechSynthesis knows nothing about it, so the common path was invisible
  exactly when it mattered.
*/
let operatorSpeaking = false;

/** True while Operator is talking, through EITHER voice. */
export function isOperatorSpeaking() {
  return operatorSpeaking || (typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis.speaking
    : false);
}

/*
  ## Why iOS was silent, and why this is not a ref inside the hook

  Operator spoke fine at the desk and said nothing at all on the phone. Not a
  server problem, not Kokoro: iOS refuses to play audio that was not started by
  a user gesture, and it tracks that permission **per <audio> element**. The
  code created `new Audio(blob)` for every sentence, so every element was a
  brand-new one that had never been touched — permanently blocked, silently,
  with `play()` rejecting into a catch that fell through to the system voice,
  which iOS blocks for the same reason. Two engines, one cause, no error on
  screen.

  So there is ONE element for the life of the page. It is played once during a
  real tap — of a fraction of a second of silence — and from then on it is an
  element the user has activated, so changing `src` and calling `play()` again
  is allowed however long afterwards.

  Module scope rather than a ref because the unlocking tap and the speaking are
  in different components: the tap that turns the microphone on is what pays
  for the whole page's ability to speak.
*/
let sharedAudio: HTMLAudioElement | null = null;
let unlocked = false;

/** The one element, made on first use. */
function audioElement(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    // Speech, not music: keep playing when the phone's screen locks.
    sharedAudio.preload = "auto";
  }
  return sharedAudio;
}

/*
  ## Choosing the speaker, and why it is worth the code

  Operator plays through the desk speakers while the owner listens on a
  Bluetooth headset, so it hears itself and answers its own sentence. The
  standing defence is `echoCancellation: true` in `useMicLevel`, and in that
  arrangement it is INERT: a canceller subtracts the playback stream from the
  captured one, and two different devices share no clock, so there is nothing to
  subtract. `usePhoneTranscript` therefore carries the whole load — it discards
  any segment recorded while Operator was talking, plus a 400ms tail for the
  room's decay.

  Playing through the SAME device the microphone is on is what makes echo
  cancellation start working, because then there is one clock and one stream to
  reference. That is the row ADR 0015 lists as "output device selection", and
  `setSinkId` is the whole of it.

  Two honest limits, both surfaced in Settings rather than hidden here:

  - WebKit has no `setSinkId`, so this does nothing on Safari or anything on
    iOS. The phone keeps the software guard alone.
  - The `speechSynthesis` fallback cannot be routed at all. It is the browser's
    own engine, not an element, and it plays wherever the platform decides.
*/

/** Whether a page may choose its output device here at all. */
export function outputRoutingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function"
  );
}

/**
 * The preference is read from storage on every use rather than cached.
 *
 * There is one audio element and several mounted copies of this hook, so a
 * module-level cache would be a second source of truth that the Settings page
 * could change while the map's copy carried on using the old one.
 */
function chosenOutput(): string | null {
  return readStorage<string | null>(OUTPUT_KEY, null);
}

/*
  The device the element is actually pointed at, set only on SUCCESS.

  Compared against the wish rather than reading `el.sinkId`, because after a
  device disappears the element keeps reporting the id it was given while the
  browser plays through the default. Tracking the successful applications means
  a failed one is retried on the next sentence, which is what makes a headset
  that comes back start working again without a reload.
*/
let appliedSink: string | null = null;
let sinkError: string | null = null;
const sinkErrorListeners = new Set<(message: string | null) => void>();

function setSinkError(message: string | null) {
  sinkError = message;
  sinkErrorListeners.forEach((fn) => fn(message));
}

/** The last routing failure, for a hook mounting after it happened. */
export function outputError(): string | null {
  return sinkError;
}

/**
 * Point the shared element at the chosen speaker.
 *
 * Never throws. A sentence coming out of the wrong speaker is a worse-sounding
 * success; a sentence not spoken because the headset is in another room is a
 * failure, and this project has already lost a week to audio that silently did
 * nothing.
 */
async function applyOutputDevice(el: HTMLAudioElement): Promise<void> {
  const wanted = chosenOutput();
  if (!outputRoutingSupported()) return;

  // "System default" is the absence of a choice, not a device id: leaving the
  // element unset means it FOLLOWS the OS default when that changes, which
  // pinning it to today's default id would not.
  if (!wanted) {
    if (appliedSink) {
      try {
        await el.setSinkId("");
        appliedSink = null;
        setSinkError(null);
      } catch {
        /* Staying on the previous device is not worth reporting. */
      }
    }
    return;
  }

  if (appliedSink === wanted) return;

  try {
    await el.setSinkId(wanted);
    appliedSink = wanted;
    setSinkError(null);
  } catch (err) {
    appliedSink = null;
    const name = (err as Error)?.name;
    setSinkError(
      name === "NotFoundError"
        ? "That speaker isn't connected — playing through the system default until it's back."
        : name === "NotAllowedError"
          ? "This browser won't let the page choose a speaker here. Allow it in the site settings."
          : ((err as Error)?.message ?? "Could not switch to that speaker."),
    );
  }
}

/**
 * Forget which device the element is on, so the next sentence re-applies.
 *
 * Called when the device list changes. A headset that was unplugged and
 * reconnected is a device that CAN be routed to again, but nothing tells the
 * element that — without this it keeps quietly using the default forever.
 */
function forgetAppliedOutput() {
  appliedSink = null;
}

/**
 * Buy the right to speak later, using a gesture happening now.
 *
 * MUST be called synchronously inside a real user event — an `await` before it
 * ends the gesture as far as the browser is concerned, and it goes back to
 * being blocked. Safe to call repeatedly; it does nothing after the first.
 *
 * A tenth of a second of silent WAV, inline, because a fetch would be async and
 * therefore too late.
 */
export function unlockSpeech() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;

  const el = audioElement();
  /*
    Route now, but do NOT await it — an await here ends the gesture, and the
    right to play is exactly what this function exists to buy. The silent WAV
    coming out of the old device is of no consequence; what matters is that the
    element is already pointed at the right speaker before the first sentence.
  */
  void applyOutputDevice(el);
  el.src =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
  void el.play().catch(() => {
    // Blocked anyway — nothing to do but let the next real sentence try.
    unlocked = false;
  });

  /*
    The fallback voice needs its own gesture, and it is a separate permission.
    An empty utterance is the documented way to spend one without a noise.
  */
  if ("speechSynthesis" in window) {
    try {
      const silent = new SpeechSynthesisUtterance("");
      silent.volume = 0;
      window.speechSynthesis.speak(silent);
    } catch {
      /* older WebKit throws on an empty utterance; the audio path still works */
    }
  }
}

export function useSpeech(): SpeechState {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  const [enabled, setEnabledState] = useState<boolean>(
    () => readStorage<boolean>(ENABLED_KEY, false),
  );
  const [voiceName, setVoiceNameState] = useState<string | null>(
    () => readStorage<string | null>(VOICE_KEY, null),
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);

  /*
    Keep a reference to the utterance being spoken.

    Chrome garbage-collects an utterance that nothing holds, mid-sentence, and
    the speech simply stops with no event. Holding it until `end` fires is the
    documented workaround and the reason this is a ref rather than a local.
  */
  const currentRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (!supported) return;
    /*
      The voice list is populated asynchronously and is EMPTY on first call in
      Chrome. Reading it once at mount gives an empty picker that never fills,
      so `voiceschanged` is the real source and the immediate read is only for
      browsers that already have it.
    */
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  useEffect(() => {
    /*
      Any tap, anywhere, buys the right to speak.

      The microphone button unlocks explicitly, but the first thing he touches
      is not always that — it might be the chat, or a mission. This makes the
      unlock a property of using the page at all rather than of remembering to
      press the right control first, and it costs one listener that removes
      itself.

      `pointerdown` rather than `click`: it fires earlier, and on iOS a scroll
      that never becomes a click still counts as the gesture.
    */
    const onFirstTouch = () => unlockSpeech();
    window.addEventListener("pointerdown", onFirstTouch, { once: true });
    window.addEventListener("touchend", onFirstTouch, { once: true });
    window.addEventListener("keydown", onFirstTouch, { once: true });

    /*
      Cancel on unmount, or navigating away leaves Operator talking to an empty
      room with no control on screen to stop it.
    */
    return () => {
      window.removeEventListener("pointerdown", onFirstTouch);
      window.removeEventListener("touchend", onFirstTouch);
      window.removeEventListener("keydown", onFirstTouch);
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on);
      writeStorage(ENABLED_KEY, on);
      if (!on && supported) {
        window.speechSynthesis.cancel();
        setSpeaking(false);
      }
    },
    [supported],
  );

  const setVoiceName = useCallback((name: string | null) => {
    setVoiceNameState(name);
    writeStorage(VOICE_KEY, name);
  }, []);

  // --- Which speaker it comes out of. See applyOutputDevice above. ---

  const outputSupported = outputRoutingSupported();
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputId, setOutputIdState] = useState<string | null>(
    () => readStorage<string | null>(OUTPUT_KEY, null),
  );
  const [outputErr, setOutputErr] = useState<string | null>(() => outputError());

  const refreshOutputs = useCallback(async () => {
    if (typeof navigator === "undefined") return;
    if (typeof navigator.mediaDevices?.enumerateDevices !== "function") return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      /*
        Windows publishes ALIASES beside the real devices — "Default - Speakers
        (…)" and "Communications - Speakers (…)" pointing at whatever the
        control panel currently selects. Listing them shows one speaker three
        times, which is what made the microphone picker look broken. Filtered
        by id rather than by label, because the prefix is localised and the id
        is not. "System default" is offered by the UI as the null choice, which
        is the same thing without pinning it to today's default.
      */
      setOutputs(
        all.filter(
          (d) =>
            d.kind === "audiooutput" &&
            d.deviceId &&
            d.deviceId !== "default" &&
            d.deviceId !== "communications",
        ),
      );
    } catch {
      /* Not fatal: speech still works, it just cannot be re-pointed. */
    }
  }, []);

  useEffect(() => {
    void refreshOutputs();

    // The routing failure happens inside a sentence, module-side. This is how
    // it reaches a card the owner is looking at.
    const onError = (message: string | null) => setOutputErr(message);
    sinkErrorListeners.add(onError);

    /*
      A device list that changes means one was plugged in or pulled out, and
      the element's routing has to be reconsidered either way — including the
      case that matters, the chosen headset reappearing after Windows dropped
      it.
    */
    const onChange = () => {
      forgetAppliedOutput();
      void refreshOutputs();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);

    return () => {
      sinkErrorListeners.delete(onError);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
    };
  }, [refreshOutputs]);

  const setOutputId = useCallback((id: string | null) => {
    setOutputIdState(id);
    writeStorage(OUTPUT_KEY, id);
    forgetAppliedOutput();
    setSinkError(null);
    /*
      Applied on the tap rather than at the next sentence, so choosing a
      speaker that is not plugged in says so immediately. Waiting until
      Operator next speaks would report the failure minutes later, to whoever
      happened to be on the page.
    */
    if (outputRoutingSupported()) void applyOutputDevice(audioElement());
  }, []);

  const nameOutputs = useCallback(async () => {
    if (typeof navigator === "undefined") return;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") return;
    try {
      /*
        A microphone grant is the only thing that makes device LABELS readable
        — there is no separate permission for "name my speakers". The stream is
        stopped the instant it opens: this is here to buy names, not to listen,
        and a track left running would flip a Bluetooth headset into HFP and
        make everything sound worse for no reason.
      */
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshOutputs();
    } catch {
      /* Refused: the picker stays as unnamed ids, which is honest. */
    }
  }, [refreshOutputs]);

  /*
    The <audio> element playing Kokoro's output.

    A ref rather than state: it is replaced on every sentence and nothing
    renders from it, so re-rendering the tree to swap an audio element would be
    work for no picture.
  */
  const playingRef = useRef(false);

  const stopAudio = useCallback(() => {
    if (!sharedAudio) return;
    sharedAudio.pause();
    // Release the object URL, or a long session leaks one blob per sentence.
    if (sharedAudio.src.startsWith("blob:")) URL.revokeObjectURL(sharedAudio.src);
    playingRef.current = false;
  }, []);

  /**
   * The browser's own voice. Kept as the fallback — see speak() above.
   *
   * This one CANNOT be pointed at a device. `speechSynthesis` is an engine
   * rather than an element, it exposes no sink, and it plays wherever the
   * platform sends it — so a fallback sentence can still come out of the
   * speakers with the headset on, and the self-hearing guard is still the only
   * thing covering that case. Settings says so instead of implying the picker
   * covers everything.
   */
  const speakWithSystemVoice = useCallback(
    (clean: string) => {
      if (!supported) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      const chosen = voiceName ? voices.find((v) => v.name === voiceName) : bestVoice(voices);
      if (chosen) utterance.voice = chosen;
      utterance.rate = 1.05;

      utterance.onend = () => {
        currentRef.current = null;
        operatorSpeaking = false;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        currentRef.current = null;
        operatorSpeaking = false;
        setSpeaking(false);
      };

      currentRef.current = utterance;
      operatorSpeaking = true;
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [supported, enabled, voiceName, voices],
  );


  /**
   * Speak through Kokoro on the server.
   *
   * Fetched as a blob and played from an object URL rather than pointing the
   * element straight at `/api/speak?text=`. Two reasons: a failed synthesis
   * comes back as JSON with a 503, and an <audio> element pointed at that
   * would simply stay silent with no way to fall back; and the text can be
   * long enough to be awkward in a query string.
   */
  const speakLocally = useCallback(
    async (clean: string) => {
      const res = await fetch(`/api/speak?text=${encodeURIComponent(clean)}`);
      if (!res.ok) throw new Error(`speak ${res.status}`);
      const blob = await res.blob();
      if (!blob.size) throw new Error("empty audio");

      /*
        The one shared element, not a new one. See `unlockSpeech` above — on
        iOS a fresh element has never been touched by the user and is blocked
        forever, which is exactly why the phone was silent.
      */
      const el = audioElement();
      /*
        Re-applied per sentence rather than once at startup. A device can
        disappear and come back between two replies — the headset does it every
        time it idles — and the check is a no-op whenever it is already right.
      */
      await applyOutputDevice(el);
      if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
      el.src = URL.createObjectURL(blob);

      operatorSpeaking = true;
      playingRef.current = true;
      setSpeaking(true);
      const done = () => {
        operatorSpeaking = false;
        playingRef.current = false;
        setSpeaking(false);
      };
      el.onended = done;
      el.onerror = done;

      try {
        await el.play();
      } catch (err) {
        // Rejected play leaves the flags set, and then the transcriber thinks
        // Operator is talking forever and discards everything he says.
        done();
        throw err;
      }
    },
    [stopAudio],
  );

  const stop = useCallback(() => {
    // Both engines: whichever is talking, "stop" has to mean stop.
    if (supported) window.speechSynthesis.cancel();
    stopAudio();
    currentRef.current = null;
    operatorSpeaking = false;
    setSpeaking(false);
  }, [supported, stopAudio]);

  const speak = useCallback(
    (text: string) => {
      /*
        `supported` means speechSynthesis exists, and that is the FALLBACK.
        Gating on it would silence Kokoro too on any browser without the
        built-in engine, which is backwards — the good voice does not depend on
        the browser having a bad one.
      */
      if (!enabled) return;
      const clean = speakableText(text);
      if (!clean) return;

      // One thing at a time. Queuing would have it read a reply from two turns
      // ago over the top of the current one.
      if (supported) window.speechSynthesis.cancel();
      stopAudio();

      /*
        Kokoro first, the system voice as the fallback.

        `/api/speak` runs a real TTS model on his own machine — no account, no
        per-character cost, and nothing leaving the box, which is why ElevenLabs
        and Deepgram were refused. Measured 2026-09-01: ~1s for an
        acknowledgement, ~2.1s for a full sentence.

        SpeechSynthesis stays as the fallback rather than being deleted. It is
        instant, it works when the model is unloaded or the machine is busy, and
        losing the ability to speak at all because a 310MB ONNX graph would not
        load is a worse failure than sounding worse for one sentence.
      */
      void speakLocally(clean).catch(() => speakWithSystemVoice(clean));
    },
    [supported, enabled, speakLocally, speakWithSystemVoice],
  );

  return {
    supported,
    enabled,
    setEnabled,
    speaking,
    voices,
    voiceName,
    setVoiceName,
    speak,
    stop,
    outputSupported,
    outputs,
    outputId,
    setOutputId,
    outputsNamed: outputs.some((d) => Boolean(d.label)),
    outputError: outputErr,
    nameOutputs,
  };
}
