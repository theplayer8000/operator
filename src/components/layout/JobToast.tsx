import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert, CheckCircle2, X, Bell } from "lucide-react";
import type { JobAlert } from "@/hooks/useJobAlerts";

/**
 * "A worker wants you" — shown wherever you are in the app.
 *
 * Sits above everything and outside the page, because the whole point is that
 * you are not on the Orchestrator when it fires. Tapping it takes you there.
 *
 * **A question does not auto-dismiss.** It is holding a turn open and the
 * runner with it, so it stays until acknowledged; a finished job is only news
 * and clears itself after a few seconds. Treating both the same would either
 * nag about completions or quietly drop the one that mattered.
 */
export default function JobToast({
  alert,
  onDismiss,
  canAsk,
  onEnableNotifications,
}: {
  alert: JobAlert;
  onDismiss: () => void;
  canAsk: boolean;
  onEnableNotifications: () => void;
}) {
  const asking = alert.kind === "asking";

  useEffect(() => {
    if (asking) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [asking, onDismiss, alert.id]);

  const tone = asking
    ? "border-xp/50 bg-base-800/95"
    : alert.kind === "failed"
      ? "border-vital-down/40 bg-base-800/95"
      : "border-base-600 bg-base-800/95";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 z-50 flex justify-center px-4 top-[calc(0.75rem+env(safe-area-inset-top))] pointer-events-none"
    >
      <div
        className={`pointer-events-auto w-full sm:max-w-md rounded-card border shadow-card backdrop-blur-md animate-fade-up ${tone}`}
      >
        <div className="flex items-start gap-2.5 p-3">
          {asking ? (
            <ShieldAlert size={16} className="shrink-0 mt-0.5 text-xp" />
          ) : (
            <CheckCircle2
              size={16}
              className={`shrink-0 mt-0.5 ${alert.kind === "failed" ? "text-vital-down" : "text-vital-up"}`}
            />
          )}

          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink-100">
              {asking
                ? "Waiting on you"
                : alert.kind === "failed"
                  ? "A job failed"
                  : "A job finished"}
            </p>
            <p className="text-xs text-ink-500 truncate">{alert.title}</p>
            {alert.detail && (
              <p className="text-[11px] text-vital-down mt-0.5 break-words">{alert.detail}</p>
            )}

            <div className="flex items-center gap-2 mt-2">
              <Link
                to="/orchestrator"
                onClick={onDismiss}
                className="inline-flex items-center min-h-[36px] px-3 rounded-badge border border-xp/40 bg-xp/10 text-xs text-xp hover:bg-xp/20 transition-colors"
              >
                {asking ? "Answer it" : "Open"}
              </Link>
              {/*
                Offered here rather than in Settings because this is the moment
                it makes sense: you have just seen the thing you would want to
                be told about next time. Browsers also require a real tap, and
                this is one.
              */}
              {canAsk && (
                <button
                  onClick={onEnableNotifications}
                  className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 rounded-badge border border-base-600 text-xs text-ink-500 hover:text-ink-100 transition-colors"
                >
                  <Bell size={12} />
                  Notify me
                </button>
              )}
            </div>
          </div>

          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="w-9 h-9 shrink-0 -mt-1 -mr-1 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
