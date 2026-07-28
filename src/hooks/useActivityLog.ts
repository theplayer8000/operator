import { useMemo } from "react";
import { useDashboardData } from "./useDashboardData";
import { useMissionBoard } from "./useMissionBoard";
import type { LogEntry, LogSource } from "@/lib/types";

/**
 * The app's only cross-feature reader.
 *
 * It owns no namespace and writes nothing — it merges the Dashboard's activity
 * slice with every mission's embedded activity[] and sorts by time. This is the
 * read-only aggregation pattern that became safe in v5 once remoteStore gave
 * every hook one shared cache; before that, calling two feature hooks from one
 * page would have diverged their state.
 *
 * Rule for anything added here: read, never mutate. If a log view ever needs to
 * change another feature's data, it should call that feature's hook mutator —
 * not reach into the store.
 */
export function useActivityLog() {
  const { activity } = useDashboardData();
  const { missions } = useMissionBoard();

  const entries = useMemo<LogEntry[]>(() => {
    const dashboardEntries: LogEntry[] = activity.map((a) => ({
      id: `dash-${a.id}`,
      label: a.label,
      timestamp: a.timestamp,
      source: "dashboard",
      kind: a.kind,
    }));

    const missionEntries: LogEntry[] = missions.flatMap((m) =>
      m.activity.map((a) => ({
        id: `mission-${m.id}-${a.id}`,
        label: a.label,
        timestamp: a.timestamp,
        source: "mission" as const,
        missionId: m.id,
        missionName: m.name,
      }))
    );

    return [...dashboardEntries, ...missionEntries].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
    );
  }, [activity, missions]);

  /** Entries bucketed by local calendar day, newest day first. */
  const grouped = useMemo(() => {
    const buckets = new Map<string, LogEntry[]>();
    for (const entry of entries) {
      const day = dayKey(entry.timestamp);
      const bucket = buckets.get(day);
      if (bucket) bucket.push(entry);
      else buckets.set(day, [entry]);
    }
    return [...buckets.entries()];
  }, [entries]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      dashboard: entries.filter((e) => e.source === "dashboard").length,
      mission: entries.filter((e) => e.source === "mission").length,
    }),
    [entries]
  );

  function filterBy(source: LogSource | "all") {
    if (source === "all") return grouped;
    return grouped
      .map(([day, items]) => [day, items.filter((i) => i.source === source)] as const)
      .filter(([, items]) => items.length > 0);
  }

  return { entries, grouped, counts, filterBy };
}

/** Local calendar day, not UTC — a log read at 00:30 should say "Today". */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
