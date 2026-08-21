import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tells you when a worker wants you, anywhere in the app.
 *
 * A job outlives the page you started it on — that is the whole point of the
 * job model — so the two moments that matter both happen while you are looking
 * at something else: a turn **stopping to ask a permission**, and a turn
 * **finishing**. Before this, both were silent unless the Orchestrator page
 * happened to be open, which meant a question could sit unanswered for twenty
 * minutes while the turn held the runner.
 *
 * Two signals, deliberately different in kind:
 *
 * - **`asking`** is server truth and persists. It is a count of outstanding
 *   questions, so a badge driven by it is correct after a reload, on a second
 *   device, and after the tab has been closed and reopened. No read-receipt
 *   bookkeeping is invented to support it.
 * - **`toast`** is a transition, seen once. It fires when a job finishes while
 *   you were not on that page — a fact about this session, so it lives in
 *   memory and is not persisted.
 *
 * Polls the summary list only, never the event logs, so it is cheap enough to
 * run app-wide alongside the Orchestrator's own polling.
 */

export interface JobAlert {
  id: string;
  title: string;
  kind: "asking" | "complete" | "failed";
  detail?: string;
}

interface Summary {
  id: string;
  title: string;
  status: string;
  asking?: number;
  error: string | null;
}

/** Slow: these are minute-scale events, and the Orchestrator polls properly. */
const IDLE_MS = 12_000;
const BUSY_MS = 4_000;

export function useJobAlerts(onOrchestrator: boolean) {
  const [asking, setAsking] = useState(0);
  const [toast, setToast] = useState<JobAlert | null>(null);
  const [canAsk, setCanAsk] = useState(false);

  /** Last seen status per job, so a transition can be told from a state. */
  const seen = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);
  const inFlight = useRef(false);
  const onPage = useRef(onOrchestrator);
  onPage.current = onOrchestrator;

  useEffect(() => {
    // `Notification` is absent entirely on an insecure origin — Operator over
    // a bare tailnet IP is exactly that (OPS-001's underlying constraint), so
    // this is a feature check rather than a permission check.
    setCanAsk(typeof window !== "undefined" && "Notification" in window);
  }, []);

  const notify = useCallback((alert: JobAlert) => {
    setToast(alert);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Tagged by job id so a second update replaces the first rather than
    // stacking three notifications for one conversation.
    try {
      new Notification(
        alert.kind === "asking" ? "Waiting on you" : alert.kind === "failed" ? "Job failed" : "Job finished",
        { body: alert.title, tag: `operator-${alert.id}`, icon: "/icon-192.png" }
      );
    } catch {
      /* some browsers refuse construction outside a service worker; the
         in-app toast has already been shown, so this is not worth reporting */
    }
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/jobs", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const body = (await res.json()) as { jobs?: Summary[] };
      const jobs = body.jobs ?? [];

      setAsking(jobs.reduce((n, j) => n + (j.asking ?? 0), 0));

      const next = new Map<string, string>();
      for (const job of jobs) {
        const key = `${job.status}:${job.asking ?? 0}`;
        next.set(job.id, key);
        const before = seen.current.get(job.id);

        /*
          The first poll only records. Without this, opening the app would
          announce every job that had finished at any point in the past as if
          it had just happened.
        */
        if (!primed.current || before === undefined || before === key) continue;

        // A question is worth interrupting for wherever you are — it is
        // holding a turn open. A finish is only news if you were not watching.
        if ((job.asking ?? 0) > 0) {
          notify({ id: job.id, title: job.title, kind: "asking" });
        } else if (!onPage.current && (job.status === "complete" || job.status === "failed")) {
          notify({
            id: job.id,
            title: job.title,
            kind: job.status === "failed" ? "failed" : "complete",
            ...(job.error ? { detail: job.error } : {}),
          });
        }
      }
      seen.current = next;
      primed.current = true;
    } catch {
      /* offline or restarting — the next tick retries, and a missed alert is
         better than an error banner for something the user did not ask for */
    } finally {
      inFlight.current = false;
    }
  }, [notify]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), asking > 0 ? BUSY_MS : IDLE_MS);
    // The same three events the rest of the app uses. `pageshow` is the one
    // iOS actually fires when a backgrounded tab comes back.
    const onResume = () => {
      if (document.visibilityState === "visible") void poll();
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
  }, [poll, asking]);

  /** Ask for OS notification permission. Must be called from a real tap. */
  const enableNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") return "unsupported";
    const result = await Notification.requestPermission();
    setCanAsk(true);
    return result;
  }, []);

  return {
    /** Outstanding questions across every job. Server truth; survives reload. */
    asking,
    /** The most recent transition worth surfacing, or null. */
    toast,
    dismiss: useCallback(() => setToast(null), []),
    /** Whether the OS-notification offer is worth showing at all. */
    canAsk:
      canAsk && typeof Notification !== "undefined" && Notification.permission === "default",
    enableNotifications,
  };
}
