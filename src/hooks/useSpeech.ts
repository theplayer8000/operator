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
      Cancel on unmount, or navigating away leaves Operator talking to an empty
      room with no control on screen to stop it.
    */
    return () => {
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

  /*
    The <audio> element playing Kokoro's output.

    A ref rather than state: it is replaced on every sentence and nothing
    renders from it, so re-rendering the tree to swap an audio element would be
    work for no picture.
  */
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    // Release the object URL, or a long session leaks one blob per sentence.
    if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
    audioRef.current = null;
  }, []);

  /** The browser's own voice. Kept as the fallback — see speak() above. */
  const speakWithSystemVoice = useCallback(
    (clean: string) => {
      const utterance = new SpeechSynthesisUtterance(clean);
      const chosen = voiceName ? voices.find((v) => v.name === voiceName) : bestVoice(voices);
      if (chosen) utterance.voice = chosen;
      utterance.rate = 1.05;

      utterance.onend = () => {
        currentRef.current = null;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        currentRef.current = null;
        setSpeaking(false);
      };

      currentRef.current = utterance;
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

      const el = new Audio(URL.createObjectURL(blob));
      audioRef.current = el;
      setSpeaking(true);
      const done = () => {
        if (audioRef.current === el) {
          stopAudio();
        }
        setSpeaking(false);
      };
      el.onended = done;
      el.onerror = done;
      await el.play();
    },
    [stopAudio],
  );

  const stop = useCallback(() => {
    // Both engines: whichever is talking, "stop" has to mean stop.
    if (supported) window.speechSynthesis.cancel();
    stopAudio();
    currentRef.current = null;
    setSpeaking(false);
  }, [supported, stopAudio]);

  const speak = useCallback(
    (text: string) => {
      if (!supported || !enabled) return;
      const clean = speakableText(text);
      if (!clean) return;

      // One thing at a time. Queuing would have it read a reply from two turns
      // ago over the top of the current one.
      window.speechSynthesis.cancel();
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
  };
}
