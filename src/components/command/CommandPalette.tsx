import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";

const DESTINATIONS = [
  { to: "/", label: "Dashboard" },
  { to: "/routine", label: "Daily Routine" },
  { to: "/projects", label: "Projects" },
  { to: "/learning", label: "Learning" },
  { to: "/gym", label: "Gym" },
  { to: "/forex", label: "Forex Journal" },
  { to: "/work", label: "Work" },
  { to: "/journey", label: "Journey" },
  { to: "/statistics", label: "Statistics" },
  { to: "/settings", label: "Settings" },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();

  const results = useMemo(
    () =>
      DESTINATIONS.filter((d) => d.label.toLowerCase().includes(query.toLowerCase())),
    [query]
  );

  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActiveIndex(0);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/60 backdrop-blur-sm animate-fade-up"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg card-base overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-base-600">
          <Search size={16} className="text-ink-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              if (e.key === "ArrowUp") setActiveIndex((i) => Math.max(i - 1, 0));
              if (e.key === "Enter" && results[activeIndex]) go(results[activeIndex].to);
            }}
            placeholder="Jump to a mission board..."
            className="flex-1 bg-transparent outline-none text-sm text-ink-100 placeholder:text-ink-700"
          />
          <kbd className="text-[10px] font-mono text-ink-700 border border-base-600 rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>
        <div className="max-h-72 overflow-y-auto py-1.5 scrollbar-none">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-ink-700">No matches.</p>
          )}
          {results.map((d, i) => (
            <button
              key={d.to}
              onClick={() => go(d.to)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
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
