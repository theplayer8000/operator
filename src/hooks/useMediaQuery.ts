import { useEffect, useState } from "react";

/**
 * Whether a CSS media query currently matches, as React state.
 *
 * Exists so a component can be **not mounted** rather than hidden. A Tailwind
 * `hidden lg:block` still renders the subtree: an SVG graph would build every
 * node, hold them in memory and run any animation on it, on a phone, for
 * something nobody can see. `docs/dashboard-graph-design.md` makes that a rule
 * for the mission map, and this is what enforces it.
 *
 * Not a general-purpose responsive layer, and it should not become one —
 * breakpoint styling belongs in Tailwind classes. Reach for this only when the
 * answer changes what gets *built*, not how it looks.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    // Guard for a non-browser render; there is no SSR here today, and a
    // component that throws during one would be a confusing way to find out.
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Re-read on subscribe: the query may have changed between the initial
    // state and this effect, which is exactly what happens on a fast resize.
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
