//
// server/reminders.mjs — the first live slice of the presence layer.
//
// docs/presence-layer-design.md describes the full trigger loop; this is the
// deliberately smallest safe version of it: a fixed interval that reads the
// calendar through the capability layer (calendar_range, which is a SILENT
// action, so the tick never notifies about its own read) and pushes a phone
// notification when a timed event comes due.
//
// What this is NOT, on purpose:
//   - It starts no jobs and calls no models — nothing here can spend money,
//     so the ceilings, namespace rules and overlap refusals the full loop
//     needs (design doc §2) do not apply to this slice yet.
//   - It only fires for events that carry a `time`. Untimed events are the
//     morning-digest problem, a different feature.
//   - OPERATOR_REMINDERS=0 disables it entirely.
//
// "Reminder" here means the raw slice: notify at the event time, once.
import { runAction } from "./actions.mjs";
import { notify } from "./notify.mjs";

/** Fire when the event time is within this window of "now" (2 minutes). */
const FIRED_WINDOW_MS = 2 * 60_000;
const TICK_MS = 60_000;

/** Local YYYY-MM-DD — mirrors src/lib/time.ts so a reminder never fires on the wrong day (OPS-009: local time, never UTC). */
function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Fire-once bookkeeping, per (event, day). In-memory only: after a restart an
// event is only re-fired if its time is still inside the window, which is rare
// and harmless — a duplicate nudge beats a lost one.
const fired = new Set();
let lastDay = "";

export async function tickReminders(now = new Date()) {
  if (process.env.OPERATOR_REMINDERS === "0") return;
  try {
    const today = todayKey(now);
    if (today !== lastDay) {
      fired.clear();
      lastDay = today;
    }

    const result = await runAction("calendar_range", { from: today, days: 1 });
    // runAction may hand back the handler's result directly or wrap it as
    // { result }; accept both rather than fail silently into "no reminders".
    const payload = result?.result ?? result;
    const events = Array.isArray(payload) ? payload : payload?.events ?? [];
    const nowMs = now.getTime();

    for (const ev of events) {
      if (!ev || typeof ev.time !== "string" || ev.time.length === 0) continue;
      const [h, m] = ev.time.split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const at = new Date(now);
      at.setHours(h, m, 0, 0);
      const diff = nowMs - at.getTime();
      if (diff < 0 || diff > FIRED_WINDOW_MS) continue;

      const key = `${ev.id}@${today}`;
      if (fired.has(key)) continue;
      fired.add(key);

      const extra = ev.notes ? ` — ${ev.notes}` : "";
      void notify(`⏰ ${ev.title}`, `${ev.time}${extra}`, {
        priority: "high",
        tags: ["alarm_clock"],
        click: "/",
      });
      console.log(`[presence] reminded at ${ev.time}: ${ev.title}`);
    }
  } catch (err) {
    // Never let a calendar hiccup take down the loop or the server.
    console.warn(`[presence] reminder tick failed: ${err?.message ?? err}`);
  }
}

/** Registered from index.mjs next to the backup timer. */
export function startReminders() {
  void tickReminders();
  const timer = setInterval(() => void tickReminders(), TICK_MS);
  timer.unref();
  console.log("[presence] calendar reminders every 60s (OPERATOR_REMINDERS=0 to disable)");
}
