import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";

const DESTINATIONS = [
  { to: "/contents", label: "Contents" },
  { to: "/", label: "Dashboard" },
  { to: "/routine", label: "Daily Routine" },
  { to: "/missions", label: "Mission Board" },
  { to: "/calendar", label: "Calendar" },
  { to: "/homelab", label: "Homelab" },
  { to: "/learning", label: "Learning" },
  { to: "/gym", label: "Gym" },
  { to: "/forex", label: "Forex Journal" },
  { to: "/work", label: "Work" },
  { to: "/journey", label: "Journey" },
  { to: "/statistics", label: "Statistics" },
  { to: "/log", label: "Activity Log" },
  { to: "/chat", label: "Claude" },
  { to: "/dev", label: "Dev" },
  { to: "/updates", label: "Updates" },
  { to: "/settings", label: "Settings" },
];

const OPEN_EVENT = "operator:open-palette";

/**
 * Opens the palette from anywhere. The Topbar button used to fake a
 * Ctrl/Cmd+K KeyboardEvent, which worked but coupled the button to the
 * palette's key handler — and meant nothing at all on a touch device.
 */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();

  const results = useMemo(
    () => DESTINATIONS.filter((d) => d.label.toLowerCase().includes(query.toLowerCase())),
    [query]
  );

  useEffect(() => {
    function show() {
      setOpen(true);
      setQuery("");
      setActiveIndex(0);
    }
    function onKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActiveIndex(0);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh] sm:pt-[14vh] px-4 bg-black/60 backdrop-blur-sm animate-fade-up"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg card-base overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-base-600">
          <Search size={16} className="text-ink-500 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              if (e.key === "ArrowUp") setActiveIndex((i) => Math.max(i - 1, 0));
              if (e.key === "Enter" && results[activeIndex]) go(results[activeIndex].to);
            }}
            placeholder="Jump to..."
            // 16px minimum, or iOS Safari zooms the whole page on focus.
            className="flex-1 min-w-0 bg-transparent outline-none text-base sm:text-sm text-ink-100 placeholder:text-ink-700"
          />
          <kbd className="hidden sm:inline text-[10px] font-mono text-ink-700 border border-base-600 rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>
        <div className="max-h-[50vh] sm:max-h-72 overflow-y-auto py-1.5 scrollbar-none">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-ink-700">No matches.</p>
          )}
          {results.map((d, i) => (
            <button
              key={d.to}
              onClick={() => go(d.to)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-4 min-h-[44px] flex items-center text-sm transition-colors ${
                i === activeIndex ? "bg-base-700 text-ink-100" : "text-ink-300"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
