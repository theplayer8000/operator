import { useState } from "react";
import { Mic, MicOff, Check, Loader2 } from "lucide-react";
import type { MicLevel } from "@/hooks/useMicLevel";
import type { VoiceActivity } from "@/hooks/useVoiceActivity";

/**
 * Which microphone Operator is listening through, and a way to change it.
 *
 * The owner's ask: *"can we have it so like this mic on the top left is like
 * this device or pc device ... sorts the mic problem temporarily and then we
 * can slot the boom mic back in"*.
 *
 * It is a real problem rather than a preference. There are three microphones
 * in play and all three have failed differently in one day: the Bluetooth
 * headset disconnects constantly and measured 1.3x signal-to-noise when it did
 * not; the Realtek reads a flat 0.0006 whether or not anyone is speaking; and
 * DroidCam is excellent until the phone locks and then goes silently to zero.
 * The device holding the page is the only one guaranteed to be near his mouth
 * and awake.
 *
 * So this does two things a status light could not: it says which microphone
 * is actually being used, and it lets him move between them without an
 * environment variable and a restart.
 *
 * ## The two are not equivalent, and it says so
 *
 * **This device** is the browser's own microphone: continuous, local, and the
 * only one that transcribes without a clap. **The PC** is whatever
 * `OPERATOR_LISTEN` names — always on, works when nobody is looking at a page,
 * and the one the clap gesture uses. Presenting them as interchangeable would
 * be a lie; the label under each says what it actually gives you.
 */

export type MicChoice = "device" | "pc";

export default function MicSource({
  mic,
  voice,
  choice,
  onChoose,
  autoSend,
  onAutoSend,
  className = "",
}: {
  mic: MicLevel;
  voice: VoiceActivity;
  choice: MicChoice;
  onChoose: (next: MicChoice) => void;
  /** Heard sentences go straight to Operator instead of filling the box. */
  autoSend: boolean;
  onAutoSend: (next: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const usingDevice = choice === "device" && mic.active;
  const heard = voice.listening
    ? Math.min(1, voice.level / Math.max(0.004, voice.threshold))
    : 0;

  const label = usingDevice
    ? "THIS DEVICE"
    : choice === "device"
      ? "MIC OFF"
      : voice.listening
        ? "PC"
        : "PC — OFFLINE";

  const live = usingDevice || (choice === "pc" && voice.listening);

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 font-mono text-[11px] text-ink-500 hover:text-ink-100 transition-colors min-h-[44px]"
        aria-label="Choose which microphone to listen through"
        aria-expanded={open}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-150"
          style={{
            background: live ? "#E8B04D" : "#3A4152",
            boxShadow: live ? "0 0 8px rgba(232,176,77,0.8)" : "none",
            transform: usingDevice ? undefined : `scale(${1 + heard * 0.8})`,
          }}
        />
        {label}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-60 card-base p-1 animate-fade-up">
          {/*
            Each option says what it actually gives you. They are not
            interchangeable — one is continuous and local, the other is always
            on and clap-triggered — and a picker that hid that would just move
            the confusion somewhere harder to find.
          */}
          <Option
            active={choice === "device"}
            busy={choice === "device" && !mic.active && !mic.error}
            disabled={!mic.supported}
            title={mic.deviceLabel ? `This device — ${mic.deviceLabel}` : "This device"}
            detail={
              !mic.supported
                ? "Needs the https://…ts.net address — a bare IP is not a secure page."
                : mic.active
                  ? "Continuous, and transcribes without a clap. The browser applies its own noise suppression and auto-gain, which is why this often sounds better than the same microphone through ffmpeg."
                  : "The microphone in whatever you are holding. Continuous, and transcribes without a clap."
            }
            onClick={() => {
              onChoose("device");
              void mic.enable();
              setOpen(false);
            }}
          />
          <Option
            active={choice === "pc"}
            title={voice.device ? `PC — ${voice.device}` : "PC"}
            detail={
              voice.listening
                ? "Always on, even with no page open. Clap twice to make it listen."
                : (voice.reason ?? "Not running.")
            }
            onClick={() => {
              onChoose("pc");
              mic.disable();
              setOpen(false);
            }}
          />
          {/*
            Auto-send, as a switch rather than a decision made for him.

            He asked for it directly — "at the moment i say something it pastes
            into the box and i gotta click send". It is a toggle and not the
            silent default because it spends money: a misheard sentence becomes
            a job with nothing in between. The filters in front of it are what
            make it reasonable at all — a voiced-fraction check for typing,
            Whisper's VAD, and the hallucination list that stopped twenty
            phantom jobs.
          */}
          <button
            onClick={() => onAutoSend(!autoSend)}
            className="w-full text-left px-3 py-2.5 rounded-badge hover:bg-base-700/60 transition-colors min-h-[44px] border-t border-base-600 mt-1"
          >
            <span className="flex items-center gap-2">
              <span
                className={`w-8 h-4 rounded-full shrink-0 relative transition-colors ${
                  autoSend ? "bg-xp/70" : "bg-base-600"
                }`}
              >
                <span
                  className="absolute top-0.5 w-3 h-3 rounded-full bg-ink-100 transition-all"
                  style={{ left: autoSend ? "18px" : "2px" }}
                />
              </span>
              <span className="text-sm text-ink-300">Send as I speak</span>
            </span>
            <span className="block text-[11px] text-ink-700 mt-0.5 leading-relaxed">
              {autoSend
                ? "Each sentence goes straight to Operator."
                : "Sentences fill the box; you press send."}
            </span>
          </button>

          {mic.error && (
            <p className="px-3 py-2 text-[11px] text-vital-down leading-relaxed">{mic.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  active,
  busy,
  disabled,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  busy?: boolean;
  disabled?: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-2.5 rounded-badge transition-colors min-h-[44px] ${
        disabled ? "opacity-40 cursor-default" : "hover:bg-base-700/60"
      }`}
    >
      <span className="flex items-center gap-2">
        {busy ? (
          <Loader2 size={12} className="animate-spin text-ink-600 shrink-0" />
        ) : active ? (
          <Check size={12} className="text-xp shrink-0" />
        ) : disabled ? (
          <MicOff size={12} className="text-ink-700 shrink-0" />
        ) : (
          <Mic size={12} className="text-ink-600 shrink-0" />
        )}
        <span className={`text-sm truncate ${active ? "text-ink-100" : "text-ink-300"}`}>
          {title}
        </span>
      </span>
      <span className="block text-[11px] text-ink-700 mt-0.5 leading-relaxed">{detail}</span>
    </button>
  );
}
