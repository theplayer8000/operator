import { Search } from "lucide-react";
import StorageStatus from "./StorageStatus";

const today = new Date().toLocaleDateString("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export default function Topbar() {
  return (
    <header className="h-16 border-b border-base-600 flex items-center justify-between px-6 sticky top-0 bg-base-900/80 backdrop-blur-md z-10">
      <div>
        <p className="text-sm text-ink-500">{today}</p>
      </div>
      <div className="flex items-center gap-2">
        <StorageStatus />
        <button
          onClick={() =>
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))
          }
          className="flex items-center gap-2 px-3 py-1.5 rounded-badge border border-base-600 text-ink-500 hover:text-ink-300 hover:border-base-500 transition-colors text-sm"
        >
          <Search size={14} />
          <span>Search</span>
          <kbd className="text-[10px] font-mono text-ink-700 border border-base-600 rounded px-1.5 py-0.5 ml-1">
            ⌘K
          </kbd>
        </button>
      </div>
    </header>
  );
}
