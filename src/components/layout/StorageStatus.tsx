import { useSyncExternalStore } from "react";
import { Database, CloudOff, RefreshCw, Loader2 } from "lucide-react";
import { getStatus, hasPendingWrites, retry, subscribeStatus } from "@/lib/remoteStore";

/**
 * Where the data currently lives, always visible.
 *
 * Deliberately not error-only: the point of moving off localStorage was
 * knowing your data is on disk and reachable, so the healthy state is worth
 * showing too. Reads as chrome, not as a feature widget — this sits in the
 * Topbar alongside search, not inside any feature's tonal register.
 */
export default function StorageStatus() {
  const status = useSyncExternalStore(subscribeStatus, getStatus, () => "loading" as const);
  const queued = hasPendingWrites();

  if (status === "loading") {
    return (
      <span
        title="Connecting to the storage server"
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-badge border border-base-600 text-ink-700 text-xs"
      >
        <Loader2 size={13} className="animate-spin" />
        <span className="hidden sm:inline">Connecting</span>
      </span>
    );
  }

  if (status === "offline") {
    return (
      <button
        onClick={() => void retry()}
        title="Storage server unreachable. Changes are held locally and sent when it's back. Click to retry."
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-badge border border-vital-down/40 bg-vital-down/10 text-vital-down text-xs hover:bg-vital-down/20 transition-colors"
      >
        <CloudOff size={13} />
        <span className="hidden sm:inline">{queued ? "Offline — queued" : "Offline"}</span>
        <RefreshCw size={12} />
      </button>
    );
  }

  return (
    <span
      title="Connected to the storage server — data is on disk, not in this browser"
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-badge border border-vital-up/30 bg-vital-up/10 text-vital-up text-xs"
    >
      <Database size={13} />
      <span className="hidden sm:inline font-mono">Local store</span>
    </span>
  );
}
