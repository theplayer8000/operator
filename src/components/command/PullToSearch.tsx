import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { openCommandPalette } from "./CommandPalette";

const DAMP = 0.5; // finger distance → visual distance, so the pull feels rubbery
const TRIGGER = 58; // visual px before releasing will open the palette
const MAX = 96; // visual px the indicator will travel, however far the finger goes

/**
 * Pull down at the top of a page to open the command palette.
 *
 * The palette has always been the fastest way around Operator, and on desktop
 * it is a keystroke away. On a phone it was buried behind a topbar button —
 * the one place a thumb has to stretch to reach. This is the same gesture iOS
 * uses for Spotlight, on the assumption that a phone user reaches for search by
 * pulling down before they reach for a button.
 *
 * Only engages at `scrollY === 0`, so it can never interrupt a scroll in
 * progress, and never while the nav drawer is open — that gesture belongs to
 * the drawer. `touchmove` is non-passive so the pull can `preventDefault` iOS's
 * rubber-band, which would otherwise drag the whole page down underneath the
 * indicator.
 */
export default function PullToSearch() {
  const { mobileNavOpen } = useTheme();
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ y: number; engaged: boolean } | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (mobileNavOpen) return;

    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };

    function onStart(e: TouchEvent) {
      // Desktop has Ctrl/Cmd+K and a visible button; it doesn't need this.
      if (window.innerWidth >= 1024) return;
      if (e.touches.length !== 1) return;
      if (window.scrollY > 0) return;
      from.current = { y: e.touches[0].clientY, engaged: false };
    }

    function onMove(e: TouchEvent) {
      const f = from.current;
      if (!f) return;
      const dy = e.touches[0].clientY - f.y;

      if (!f.engaged) {
        // Upward first means they're scrolling the page — let it go, for good.
        if (dy < -6) {
          from.current = null;
          return;
        }
        if (dy < 10) return;
        f.engaged = true;
        setDragging(true);
      }

      e.preventDefault();
      set(Math.min(MAX, dy * DAMP));
    }

    function onEnd() {
      const f = from.current;
      from.current = null;
      setDragging(false);
      if (f?.engaged && pullRef.current >= TRIGGER) openCommandPalette();
      set(0);
    }

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [mobileNavOpen]);

  const ready = pull >= TRIGGER;

  return (
    <div
      aria-hidden
      className="lg:hidden fixed top-0 inset-x-0 z-[55] flex justify-center pointer-events-none"
      style={{
        transform: `translateY(${pull}px)`,
        opacity: Math.min(1, pull / 34),
        // Animate only the snap back — during the drag the finger sets the
        // position directly and a transition would lag behind it.
        transition: dragging ? "none" : "transform 180ms ease-out, opacity 180ms ease-out",
      }}
    >
      <div
        className={`mt-2 flex items-center gap-2 h-9 px-3.5 rounded-badge border text-xs transition-colors ${
          ready
            ? "bg-xp text-base-950 border-xp font-medium"
            : "bg-base-800 text-ink-500 border-base-600"
        }`}
      >
        <Search size={14} />
        {ready ? "Release to search" : "Pull to search"}
      </div>
    </div>
  );
}
