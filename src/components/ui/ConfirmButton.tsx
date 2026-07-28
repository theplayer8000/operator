import { useEffect, useRef, useState } from "react";
import { Check, Trash2, X } from "lucide-react";

/**
 * Two-step delete. First tap arms it, second confirms; a cancel sits alongside
 * and it disarms itself after a few seconds of being ignored.
 *
 * Deliberately not a modal: rows here are dense and a portal + scroll lock is
 * a lot of machinery for "are you sure". Deliberately not window.confirm
 * either — it's unstyled, and on iOS it steals focus from the row you were
 * working in. Both buttons are real 44px targets and neither is hover-gated.
 */
export default function ConfirmButton({
  onConfirm,
  label = "Delete",
  compact = false,
}: {
  onConfirm: () => void;
  label?: string;
  compact?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer.current);
  }, [armed]);

  const box = compact
    ? "w-9 h-9"
    : "w-11 h-11";

  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        aria-label={label}
        title={label}
        className={`${box} shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-vital-down hover:bg-base-700/60 transition-colors`}
      >
        <Trash2 size={14} />
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 shrink-0">
      <button
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        aria-label={`Confirm ${label.toLowerCase()}`}
        title={`Confirm ${label.toLowerCase()}`}
        className={`${box} flex items-center justify-center rounded-badge bg-vital-down/15 border border-vital-down/40 text-vital-down transition-colors`}
      >
        <Check size={14} />
      </button>
      <button
        onClick={() => setArmed(false)}
        aria-label="Cancel"
        title="Cancel"
        className={`${box} flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors`}
      >
        <X size={14} />
      </button>
    </span>
  );
}
