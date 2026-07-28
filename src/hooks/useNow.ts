import { useEffect, useState } from "react";

/**
 * A ticking clock as React state.
 *
 * Re-syncs on tab focus and on visibilitychange, because a backgrounded tab
 * throttles timers — a phone left in a pocket comes back with a stale clock
 * otherwise. That is the same class of bug as OPS-009: assuming a mounted tab
 * keeps up with the real world.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);

    function resync() {
      if (!document.hidden) setNow(new Date());
    }

    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, [intervalMs]);

  return now;
}
