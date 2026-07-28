import { useEffect, useState } from "react";
import { Search, Menu } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { openCommandPalette } from "@/components/command/CommandPalette";
import StorageStatus from "./StorageStatus";

function formatToday() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function Topbar() {
  const { setMobileNavOpen } = useTheme();
  // Computed per render rather than at module load, so a tab left open
  // overnight doesn't keep yesterday's date on screen.
  const [today, setToday] = useState(formatToday);

  useEffect(() => {
    const id = setInterval(() => setToday(formatToday()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-16 border-b border-base-600 flex items-center justify-between gap-3 px-4 sm:px-6 sticky top-0 bg-base-900/80 backdrop-blur-md z-30">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          className="lg:hidden w-11 h-11 -ml-2 flex items-center justify-center rounded-badge text-ink-500 hover:text-ink-100 transition-colors shrink-0"
        >
          <Menu size={20} />
        </button>
        <p className="text-sm text-ink-500 truncate">{today}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <StorageStatus />
        <button
          onClick={openCommandPalette}
          aria-label="Search"
          className="flex items-center gap-2 px-3 min-h-[44px] sm:min-h-0 sm:py-1.5 rounded-badge border border-base-600 text-ink-500 hover:text-ink-300 hover:border-base-500 transition-colors text-sm"
        >
          <Search size={16} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline text-[10px] font-mono text-ink-700 border border-base-600 rounded px-1.5 py-0.5 ml-1">
            ⌘K
          </kbd>
        </button>
      </div>
    </header>
  );
}
