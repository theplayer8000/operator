import { useSyncExternalStore } from "react";
import { Database, CloudOff, RefreshCw, Loader2, ShieldAlert } from "lucide-react";
import {
  getAuthReason,
  getStatus,
  hasPendingWrites,
  retry,
  subscribeStatus,
} from "@/lib/remoteStore";

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

  /*
    A refusal is not an outage, and showing it as one costs real time: the
    owner's phone was on the LAN address rather than the Tailscale one, every
    /api call 401'd, and the app said the datastore was inaccessible — so he
    went looking for a crashed server that was running perfectly and refusing
    him on purpose. Different cause, different fix, different badge.
  */
  if (status === "unauthorised") {
    const reason = getAuthReason();
    return (
      <button
        onClick={() => void retry()}
        title={`This device isn't authorised${reason ? ` — ${reason}` : ""}. Open Operator on the Tailscale address rather than a LAN one. Changes are held locally meanwhile. Click to retry.`}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-badge border border-xp/40 bg-xp/10 text-xp text-xs hover:bg-xp/20 transition-colors"
      >
        <ShieldAlert size={13} />
        <span className="hidden sm:inline">
          {queued ? "Not authorised — queued" : "Not authorised"}
        </span>
        <RefreshCw size={12} />
      </button>
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
