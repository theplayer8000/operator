import { Link } from "react-router-dom";
import { Server, ExternalLink } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { useHomelab, serviceUrl } from "@/hooks/useHomelab";

/**
 * The Dashboard's read-only window onto the Homelab feature — the "front door
 * to the box" the homepage is meant to be. Same relationship the Activity Log
 * has to the features it reads: it renders another namespace's data and
 * mutates none of it. Tile management lives on /homelab.
 */
export default function HomelabStatus() {
  const { services, statuses, online } = useHomelab();

  return (
    <Card
      title="Homelab"
      icon={<Server size={15} />}
      span={3}
      action={
        <Link to="/homelab" className="text-xs text-ink-500 hover:text-ink-300 transition-colors">
          {online}/{services.length} online →
        </Link>
      }
    >
      {services.length === 0 ? (
        <EmptyState message="No services yet — add one on the Homelab page." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
          {services.map((s) => {
            const status = statuses[s.id];
            const dot = !status
              ? "bg-ink-700"
              : status.online
                ? "bg-vital-up ring-2 ring-vital-up/20"
                : "bg-vital-down";

            return (
              <a
                key={s.id}
                href={serviceUrl(s)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2.5 min-h-[44px] px-3 rounded-badge border border-base-600 bg-base-700/30 hover:border-base-500 hover:bg-base-700/60 transition-colors group"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-ink-300 truncate">{s.name}</span>
                  <span className="block font-mono text-[11px] text-ink-700">:{s.port}</span>
                </span>
                <ExternalLink
                  size={13}
                  className="shrink-0 text-ink-700 group-hover:text-ink-500 transition-colors"
                />
              </a>
            );
          })}
        </div>
      )}
    </Card>
  );
}
