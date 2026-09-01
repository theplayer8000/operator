import { useMemo } from "react";
import { useUpdates } from "./useUpdates";
import { useMissionBoard } from "./useMissionBoard";
import { useEvents } from "./useEvents";
import { useGym } from "./useGym";
import { useRoutineData } from "./useRoutineData";
import { toDateKey } from "@/lib/time";
import type { MissionStatus } from "@/lib/types";

/**
 * Everything Operator knows about itself, counted.
 *
 * The second read-only aggregator in the app, after the Activity Log, and it
 * follows the same rule: **it owns no storage and mutates nothing.** Every
 * number here is derived from a feature's own hook, so a statistic can never
 * disagree with the page it came from — which is the failure ADR 0008 fixed
 * when the Dashboard kept a second copy of the mission list.
 *
 * ## Built around the data that actually exists
 *
 * Measured before designing, rather than after: the changelog holds 123 dated
 * entries spanning five weeks, missions hold nine records with real progress,
 * and gym and routine hold two days each because the owner cleared the seed
 * data to use his own. So the changelog carries the page and the thin slices
 * say honestly that they are thin, instead of a chart drawing a confident line
 * through two points.
 */

export interface DayCount {
  date: string;
  count: number;
}

export interface Statistics {
  /** How many days of history there are to talk about at all. */
  spanDays: number;
  shipped: {
    total: number;
    pending: number;
    /** Every day in the range, zero-filled — a gap is information. */
    perDay: DayCount[];
    busiestDay: DayCount | null;
    last7: number;
    previous7: number;
  };
  missions: {
    total: number;
    byStatus: Record<MissionStatus, number>;
    averageProgress: number;
    /** Missions nothing else is waiting on, and which are blocking others. */
    blocking: { id: string; name: string; waiting: number }[];
  };
  gym: {
    daysTrained: number;
    daysSkipped: number;
    /** Consecutive days up to today with a session or a deliberate skip. */
    exercisesLogged: number;
  };
  routine: {
    daysLogged: number;
    stepsTicked: number;
  };
  calendar: {
    total: number;
    upcoming: number;
    byKind: { kind: string; count: number }[];
  };
}

/** Every date from `from` to `to` inclusive, so gaps render as gaps. */
function fillDays(from: string, to: string, counts: Map<string, number>): DayCount[] {
  const out: DayCount[] = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  // Midday, not midnight: stepping a date across a BST boundary at 00:00 can
  // land on the same day twice or skip one. `time.ts` makes the same point.
  while (cursor <= end) {
    const key = toDateKey(cursor);
    out.push({ date: key, count: counts.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function useStatistics(): Statistics {
  const { entries } = useUpdates();
  const { missions } = useMissionBoard();
  const { events } = useEvents();
  const { completions: gymDone, skipped } = useGym();
  const { completions: routineDone } = useRoutineData();

  return useMemo(() => {
    /* ---- shipped ---------------------------------------------------- */
    const done = entries.filter((e): e is typeof e & { date: string } => e.status === "done" && Boolean(e.date));
    const counts = new Map<string, number>();
    for (const e of done) counts.set(e.date, (counts.get(e.date) ?? 0) + 1);

    const dates = [...counts.keys()].sort();
    const today = toDateKey(new Date());
    const perDay = dates.length && dates[0] ? fillDays(dates[0], today, counts) : [];

    const busiestDay =
      perDay.length > 0 ? perDay.reduce((a, b) => (b.count > a.count ? b : a)) : null;

    const tail = (n: number, offset = 0) =>
      perDay.slice(Math.max(0, perDay.length - n - offset), perDay.length - offset)
        .reduce((sum, d) => sum + d.count, 0);

    /* ---- missions --------------------------------------------------- */
    const byStatus: Record<MissionStatus, number> = {
      not_started: 0,
      in_progress: 0,
      blocked: 0,
      complete: 0,
    };
    const live = missions.filter((m) => !m.archived);
    for (const m of live) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

    // How many missions are waiting on each one. The board has always held
    // this and nothing has ever counted it.
    const waitingOn = new Map<string, number>();
    for (const m of live) {
      for (const dep of m.dependsOn ?? []) waitingOn.set(dep, (waitingOn.get(dep) ?? 0) + 1);
    }
    const blocking = [...waitingOn.entries()]
      .map(([id, waiting]) => ({ id, name: live.find((m) => m.id === id)?.name ?? "unknown", waiting }))
      .filter((b) => b.name !== "unknown")
      .sort((a, b) => b.waiting - a.waiting)
      .slice(0, 4);

    /* ---- the rest --------------------------------------------------- */
    const gymDays = Object.keys(gymDone ?? {});
    const routineDays = Object.keys(routineDone ?? {});

    const kinds = new Map<string, number>();
    for (const e of events) kinds.set(e.kind ?? "other", (kinds.get(e.kind ?? "other") ?? 0) + 1);

    return {
      spanDays: perDay.length,
      shipped: {
        total: done.length,
        pending: entries.filter((e) => e.status !== "done").length,
        perDay,
        busiestDay,
        last7: tail(7),
        previous7: tail(7, 7),
      },
      missions: {
        total: live.length,
        byStatus,
        averageProgress: live.length
          ? Math.round(live.reduce((s, m) => s + (m.progress ?? 0), 0) / live.length)
          : 0,
        blocking,
      },
      gym: {
        daysTrained: gymDays.length,
        daysSkipped: (skipped ?? []).length,
        exercisesLogged: Object.values(gymDone ?? {}).reduce<number>(
          (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
          0,
        ),
      },
      routine: {
        daysLogged: routineDays.length,
        stepsTicked: Object.values(routineDone ?? {}).reduce<number>(
          (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
          0,
        ),
      },
      calendar: {
        total: events.length,
        upcoming: events.filter((e) => e.date >= today).length,
        byKind: [...kinds.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }, [entries, missions, events, gymDone, skipped, routineDone]);
}
