import { ExternalLink, Pencil } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { serviceUrl } from "@/hooks/useHomelab";
import type { HomelabService, ServiceStatus } from "@/lib/types";

/**
 * Infra register, deliberately closer to Mission Board than the Dashboard: a
 * dot, a name, a port. No shields, no XP. A service being up is not an
 * achievement.
 *
 * `status` is undefined until the first probe lands, which is a third state
 * and reads as "unknown" — not "offline". Claiming a service is down because
 * we haven't asked yet is the one wrong answer here.
 */
export default function ServiceTile({
  service,
  status,
  onEdit,
  onDelete,
}: {
  service: HomelabService;
  status?: ServiceStatus;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const url = serviceUrl(service);

  const dot = !status
    ? "bg-ink-700"
    : status.online
      ? "bg-vital-up ring-2 ring-vital-up/20"
      : "bg-vital-down";
  const stateLabel = !status ? "Checking…" : status.online ? "Online" : "Offline";

  return (
    <div className="card-base p-4 flex flex-col min-w-0 animate-fade-up">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
          <h3 className="font-display text-sm font-medium text-ink-100 truncate">{service.name}</h3>
        </div>
        {(onEdit || onDelete) && (
          <div className="flex items-center shrink-0 -mr-1">
            {onEdit && (
              <button
                onClick={onEdit}
                aria-label={`Edit ${service.name}`}
                title="Edit"
                className="w-9 h-9 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
              >
                <Pencil size={13} />
              </button>
            )}
            {onDelete && (
              <ConfirmButton onConfirm={onDelete} label={`Remove ${service.name}`} compact />
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-ink-500 leading-relaxed mb-3 line-clamp-2">
        {service.description}
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3 border-t border-base-600">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-ink-500 truncate">
            {service.host}:{service.port}
          </p>
          <p className="text-[11px] text-ink-700 truncate">
            <span className="sr-only">Status: </span>
            {stateLabel}
            {status?.online && status.latencyMs !== null && (
              <span className="font-mono"> · {status.latencyMs}ms</span>
            )}
            {service.stack && ` · ${service.stack}`}
          </p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-3 min-h-[38px] shrink-0 rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          Open <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
