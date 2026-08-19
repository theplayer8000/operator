import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";

/**
 * "A newer version of this app exists — tap to load it."
 *
 * On a desktop a stale tab costs Ctrl+R. On a phone it costs swiping up, killing
 * the tab and reopening it, because iOS keeps serving a backgrounded tab's
 * JavaScript indefinitely — so the owner spent an evening reading a pre-merge
 * build and reporting bugs that were already fixed, twice.
 *
 * ## Hashes, not timestamps
 *
 * The obvious version compares a build stamp baked into the bundle against
 * `live.builtAt` from `/api/build`. It was written, and it was wrong: the stamp
 * is fixed when Vite *starts* and the mtime lands when it *finishes*, fifteen
 * seconds later, so a freshly loaded page immediately declared itself out of
 * date. Any tolerance wide enough to cover a build is also wide enough to miss
 * two builds in a row, which is exactly how this app is developed.
 *
 * So it compares what actually identifies a build: the content hash Vite puts
 * in the entry filename. `import.meta.url` is this bundle's own URL, and
 * `index.html` names the current one. Different hash, different code — no
 * clock, no tolerance, no false positive on a fresh load.
 *
 * **It never reloads on its own.** A reload mid-sentence in the Claude composer
 * would lose what you typed. It offers; you decide.
 */

/** Slow on purpose: a rebuild is a human action, minutes apart at best. */
const CHECK_MS = 120_000;

/** `…/assets/index-C8JfH9KF.js` → `index-C8JfH9KF.js` */
function entryName(url: string): string | null {
  const match = url.match(/assets\/([\w.-]+\.js)/);
  return match ? match[1] : null;
}

export default function UpdateBanner() {
  const [newer, setNewer] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    // In dev there are no hashed bundles — modules are served from src/ — so
    // there is nothing to compare and nothing to offer.
    if (import.meta.env.DEV) return;

    const mine = entryName(import.meta.url);
    if (!mine) return;

    try {
      // `no-store` rather than trusting the header: the whole point is that
      // this page is running on a cache we don't want to consult.
      const res = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
      if (!res.ok) return;
      const html = await res.text();
      // Containment, not equality: if this ever code-splits, `index.html` will
      // name several chunks and only one of them is the entry. "The page no
      // longer references the bundle I am running" is the honest test.
      if (entryName(html) && !html.includes(mine)) setNewer(true);
    } catch {
      /* offline or the server is down — the app keeps working, say nothing */
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    // The same three events the store and the jobs poll use. `pageshow` is the
    // one that matters here: returning to a backgrounded tab is exactly when
    // the running bundle is most likely to be out of date.
    const onResume = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, [check]);

  if (!newer || dismissed) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-1 rounded-badge border border-xp/40 bg-base-800/95 backdrop-blur-md shadow-card">
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-2 pl-4 pr-3 min-h-[44px] text-sm text-xp hover:text-xp-bright transition-colors"
        >
          <ArrowUpCircle size={15} className="shrink-0" />
          New version — tap to load it
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Not now"
          className="w-11 h-11 shrink-0 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
