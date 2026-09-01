import { useState } from "react";
import { Mic, Check, Loader2, ChevronDown } from "lucide-react";
import type { MicLevel } from "@/hooks/useMicLevel";

/**
 * Which microphone this page listens through.
 *
 * ## It lists real devices, not categories
 *
 * The first version offered "This device" or "the PC", which the owner found
 * confusing and was right to: *"if ur doing a device picker then remove the pc
 * microphone droid cam and instead do a picker that fits the ui"*. Neither
 * label named a microphone. "This device" then took whatever Windows called
 * the default — his Bluetooth headset, the one that keeps disconnecting,
 * rather than the Realtek beside it — so the picker looked like a setting
 * while actually being someone else's decision.
 *
 * It now lists what `enumerateDevices` reports and lets one be chosen. The
 * server-side listener the clap gesture uses is deliberately NOT here: that is
 * an always-on background thing configured by `OPERATOR_LISTEN`, and putting
 * it in a menu about what the open page hears conflated two unrelated ideas.
 *
 * ## Labels only exist after permission
 *
 * Browsers withhold device names until the microphone has been granted once —
 * the list of your inputs is itself identifying. So the menu offers a single
 * "turn it on" until then, and the list appears afterwards. Blank rows first
 * would read as broken rather than locked.
 */

export default function MicSource({
  mic,
  autoSend,
  onAutoSend,
  className = "",
}: {
  mic: MicLevel;
  /** Heard sentences go straight to Operator instead of filling the box. */
  autoSend: boolean;
  onAutoSend: (next: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  /*
    Device names are long and mostly punctuation — "Microphone (Realtek USB
    Audio)". The bracketed part is the distinguishing bit.
  */
  const shortName = (label: string) => {
    const inner = label.match(/\(([^)]+)\)/)?.[1];
    return (inner ?? label).replace(/\s*\(.*$/, "").trim();
  };

  const current = mic.deviceLabel ? shortName(mic.deviceLabel) : null;

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 font-mono text-[11px] text-ink-500 hover:text-ink-100 transition-colors min-h-[44px] max-w-[220px]"
        aria-label="Choose a microphone"
        aria-expanded={open}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-150"
          style={{
            background: mic.active ? "#E8B04D" : "#3A4152",
            boxShadow: mic.active ? "0 0 8px rgba(232,176,77,0.8)" : "none",
          }}
        />
        <span className="truncate uppercase">
          {mic.connecting ? "connecting" : mic.active ? (current ?? "listening") : "mic off"}
        </span>
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-64 card-base p-1 animate-fade-up">
          {!mic.supported ? (
            <p className="px-3 py-2.5 text-[11px] text-ink-600 leading-relaxed">
              The microphone needs a secure page — open Operator at its https://…ts.net address
              rather than a bare IP.
            </p>
          ) : mic.devices.length === 0 ? (
            /*
              Before permission there is nothing to list, so offer the one
              action that produces a list.
            */
            <Row
              icon={mic.connecting ? "busy" : "mic"}
              label={mic.active ? "Microphone on" : "Turn on the microphone"}
              onClick={() => {
                void mic.enable();
                setOpen(false);
              }}
            />
          ) : (
            <>
              {mic.devices.map((d) => (
                <Row
                  key={d.deviceId}
                  icon={mic.active && mic.deviceLabel === d.label ? "check" : "mic"}
                  label={d.label ? shortName(d.label) : "Unnamed input"}
                  onClick={() => {
                    void mic.enable(d.deviceId);
                    setOpen(false);
                  }}
                />
              ))}
              {mic.active && (
                <Row
                  icon="off"
                  label="Turn off"
                  onClick={() => {
                    mic.disable();
                    setOpen(false);
                  }}
                />
              )}
            </>
          )}

          {/*
            Auto-send, as a switch rather than a decision made for him. A
            toggle and not the silent default because it spends money: a
            misheard sentence becomes a job with nothing in between.
          */}
          <button
            onClick={() => onAutoSend(!autoSend)}
            className="w-full text-left px-3 py-2.5 rounded-badge hover:bg-base-700/60 transition-colors min-h-[44px] border-t border-base-600 mt-1"
          >
            <span className="flex items-center gap-2.5">
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

function Row({
  icon,
  label,
  onClick,
}: {
  icon: "check" | "mic" | "busy" | "off";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2.5 rounded-badge hover:bg-base-700/60 transition-colors min-h-[44px]"
    >
      <span className="flex items-center gap-2.5">
        {icon === "busy" ? (
          <Loader2 size={13} className="animate-spin text-ink-600 shrink-0" />
        ) : icon === "check" ? (
          <Check size={13} className="text-xp shrink-0" />
        ) : icon === "off" ? (
          <span className="w-[13px] shrink-0" />
        ) : (
          <Mic size={13} className="text-ink-600 shrink-0" />
        )}
        <span
          className={`text-sm truncate ${
            icon === "check" ? "text-ink-100" : icon === "off" ? "text-ink-600" : "text-ink-300"
          }`}
        >
          {label}
        </span>
      </span>
    </button>
  );
}
