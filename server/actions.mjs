// The capability layer: named, validated actions an AI worker can call to
// change Operator's own data — tick a gym exercise, create a mission, drop a
// calendar event — without editing source code or touching the raw state API.
//
// Each action mirrors exactly what the matching frontend hook does
// (src/hooks/use*.ts) — same id generation, same date-key handling, same
// defaults, same invariants (deleting a mission sweeps it out of every other
// mission's dependsOn; an emptied gym day drops its key rather than storing
// an empty array). The write an action produces is meant to be
// indistinguishable from one a human made through that feature's own UI.
//
// **This is deliberately not a generic "write anything to any key" gateway.**
// `PUT /api/state/<key>` already exists and already does that, unvalidated —
// it is a maintenance backdoor (CLAUDE.md's own architecture note calls it
// exactly that), not a feature. Every action here has a fixed name and a
// fixed parameter shape, and can only do what a human could already do
// through that feature's page. Two features are deliberately absent:
// Homelab (service tiles describe infrastructure, not tasks) and Updates
// (already has its own mechanism — scripts/log-update.mjs / the API it
// wraps — and duplicating it here would be a second copy of the same thing).
//
// Runs in-process, through server/store.mjs's withState() — nothing here
// makes an HTTP call to itself. That is what makes two actions in the same
// turn (or from two devices) safe against clobbering each other; see the
// comment on withState().

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { withState, readState } from "./store.mjs";

export class ActionError extends Error {}

function required(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new ActionError(`${name} is required`);
  }
  return value;
}

function oneOf(value, choices, name) {
  if (value !== undefined && !choices.includes(value)) {
    throw new ActionError(`${name} must be one of: ${choices.join(", ")}`);
  }
  return value;
}

/**
 * Server-side id minting. Mirrors `src/lib/id.ts` in spirit rather than
 * byte-for-byte: that file's fallback branch exists only because a browser on
 * an insecure origin (Operator's own phone case) can't call
 * `crypto.randomUUID`. Nothing here is a browser, so there is no such
 * restriction — Node's `crypto.randomUUID` is always available. Nothing reads
 * an id's *format*, only its identity, so a real UUID from here and a
 * timestamp-based fallback id from a phone already coexist in the store today.
 */
function generateId() {
  return randomUUID();
}

/** Matches `src/lib/time.ts`'s `toDateKey()` — local calendar day, never UTC. */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * What time is it — the cheapest action here, and it exists because its
 * absence was expensive.
 *
 * Asked "what time is it" on 2026-08-31, Gemini called `calendar_range` and
 * then `jobs_list` before answering: two extra round trips, several seconds
 * each, to reach a fact the server knows for free. Nothing was wrong with the
 * model's reasoning — the calendar is genuinely the closest thing on offer when
 * nothing simply reports the clock.
 *
 * Same lesson as the gym read action, which cost $0.92 and two minutes for a
 * question the store could have answered directly: **a missing trivial action
 * does not cause a refusal, it causes expensive improvisation**, and that is
 * far harder to notice.
 *
 * Local time, deliberately. `toDateKey()` exists across this codebase because
 * UTC is wrong for a person's day (OPS-009), and a worker asked what today is
 * must get the same answer the Dashboard shows.
 */
async function currentTime() {
  const d = new Date();
  return {
    date: todayKey(),
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    weekday: d.toLocaleDateString("en-GB", { weekday: "long" }),
    // Spelled out, because a model reading "2026-08-31" often says the wrong
    // month aloud and this is now sometimes spoken rather than read.
    readable: d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    iso: d.toISOString(),
  };
}

/**
 * Press the media play/pause key on the machine Operator runs on.
 *
 * **Exactly the signal a Bluetooth headset's button sends.** The owner asked
 * why a web page cannot do what his headset does, and the answer is that they
 * are two different mechanisms: a phone pauses Netflix for Spotify through
 * *audio focus*, which mobile OSes enforce and Windows has no equivalent of,
 * while the headset button sends an AVRCP media key that the OS routes to
 * whatever holds the media session. A page can do neither. A process on the
 * machine can do the second, which is this.
 *
 * ## The first action that touches the OS rather than Operator's own data
 *
 * Worth naming as a widening rather than slipping in. Everything else in this
 * file reads or writes the store; this reaches outside it. It stays acceptable
 * only because it is shaped like every other capability: **a fixed name that
 * does exactly one fixed thing.** There is no parameter, so there is nothing a
 * caller can steer — the guarantee is not that the key is harmless, it is that
 * this is the only key that can ever be pressed.
 *
 * Do not generalise it. A `send_key` action taking a keycode would be a
 * keyboard for anything that can call an action, which is the generic-write-
 * gateway mistake this file's header exists to prevent.
 *
 * Toggles rather than pauses, because that is what the key does — pressing it
 * with nothing playing starts whatever last played. That is the honest
 * behaviour of the hardware button and pretending otherwise would make the
 * action lie about itself.
 */
async function mediaPlayPause() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  // VK_MEDIA_PLAY_PAUSE is 0xB3. SendKeys cannot express media keys, so this
  // goes through keybd_event, which is the documented way to synthesise one.
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);';",
    "$k = Add-Type -MemberDefinition $sig -Name Media -Namespace Win32 -PassThru;",
    "$k::keybd_event(0xB3, 0, 0, 0);",
    "$k::keybd_event(0xB3, 0, 2, 0);",
  ].join(" ");

  try {
    await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 5000,
      windowsHide: true,
    });
    return { pressed: "play/pause" };
  } catch (err) {
    throw new ActionError(
      `couldn't send the media key: ${String(err?.message ?? err)}. This works on Windows only.`
    );
  }
}

/**
 * Bring Operator's own window to the front.
 *
 * ## Why this exists when `requestFullscreen()` does not work
 *
 * A browser refuses `requestFullscreen()` outside a real user gesture, and a
 * clap is not one — the call is rejected silently. That was recorded as "the
 * part that cannot work", which was only true of the *page*. The owner spotted
 * the gap: the media key already proved Operator has a machine-side half, and
 * a window is no different. The browser cannot raise itself; a process on the
 * machine can raise it.
 *
 * ## Matched on title, never on a PID
 *
 * The owner offered a PID. It would work once: a browser gets a new one every
 * time it is closed and reopened, so a stored PID becomes a focus action that
 * silently does nothing, weeks later, for no visible reason. The window title
 * is what survives — every Operator page sets one, and the browser appends it.
 *
 * ## No parameter, deliberately
 *
 * Same shape as `media_play_pause`: a fixed name doing one fixed thing. A
 * general `focus_window` taking a title would let anything that can call an
 * action raise anything on the desktop, which is a step toward the generic
 * gateway this file's header exists to refuse. This can only ever raise
 * Operator.
 */
/*
  Screen geometry, cached.

  Loading System.Windows.Forms to ask where the monitors are costs about 270ms
  of the ~2.5s the summon originally took, and the answer almost never changes.
  Cached for five minutes, so unplugging a monitor is picked up within one
  gesture rather than needing a restart, and the common case pays nothing.
*/
let screenCache = { at: 0, screens: null };
const SCREEN_TTL_MS = 5 * 60_000;

async function screenBounds(run) {
  if (screenCache.screens && Date.now() - screenCache.at < SCREEN_TTL_MS) {
    return screenCache.screens;
  }
  const { stdout } = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; " +
        "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
        "'{0},{1},{2},{3}' -f $_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height }",
    ],
    { timeout: 6000, windowsHide: true }
  );
  const screens = String(stdout)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map(Number))
    .filter((p) => p.length === 4 && p.every(Number.isFinite))
    .map(([x, y, width, height]) => ({ x, y, width, height }));
  if (screens.length) screenCache = { at: Date.now(), screens };
  return screens;
}

/*
  The Win32 declarations the window actions need, as PowerShell.

  The here-string terminator `'@` is ALONE at column 0 with nothing after it,
  because PowerShell requires that — and getting it wrong does not throw, it
  WAITS for a terminator that never arrives. That is how an attempt at a
  persistent helper hung silently instead of failing, and it is why the script
  below is joined with newlines rather than spaces.

  Guarded by an `-as [type]` check: harmless in a fresh process, and the thing a
  long-lived host would rely on if this ever gets one.
*/
const OP_DECLARATIONS = [
  "$opSrc = @'",
  "using System;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "public class Op {",
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, int e);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);',
  '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  "  public struct RECT { public int Left, Top, Right, Bottom; }",
  "  delegate bool EnumProc(IntPtr h, IntPtr p);",
  "  static IntPtr found; static string want;",
  "  public static string TitleOf(IntPtr h) { var b = new StringBuilder(300); GetWindowText(h, b, 300); return b.ToString(); }",
  "  static bool Check(IntPtr h, IntPtr p) { if (!IsWindowVisible(h)) return true; var t = TitleOf(h); if (t.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; } return true; }",
  "  public static IntPtr ByTitle(string s) { want = s; found = IntPtr.Zero; EnumWindows(Check, IntPtr.Zero); return found; }",
  "}",
  "'@",
  "if (-not ('Op' -as [type])) { Add-Type -TypeDefinition $opSrc -ErrorAction SilentlyContinue }",
].join("\n");

/*
  The compiled helper, built once by scripts/build-win.mjs.

  Spawning PowerShell and compiling these declarations per call cost ~770ms
  before any Win32 call happened. This is ~100ms including process start, and
  it needs no lifecycle, no queue and no fallback — which is what made a
  long-lived PowerShell fragile enough to abandon.
*/
const WIN_EXE = resolve(dirname(fileURLToPath(import.meta.url)), "win", "OperatorWin.exe");

async function focusOperator({ pause } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  /*
    Which monitor to summon onto. Screen 2 by default — the owner's choice
    "for now, until I decide otherwise", which is exactly what an environment
    variable is for: changeable without a code change, and not editable by a
    worker. Clamped in the script, so unplugging that monitor falls back to the
    first rather than failing.
  */
  const screenIndex = Math.max(1, Number(process.env.OPERATOR_FOCUS_SCREEN ?? 2) || 2);

  const pauseMedia = pause === false ? "$false" : "$true";
  const screens = await screenBounds(run);
  if (!screens.length) throw new ActionError("couldn't read the display layout");
  // Clamped rather than erroring: unplugging the second monitor should fall
  // back to the first, not break the gesture.
  const target = screens[Math.min(screenIndex, screens.length) - 1];

  /*
    SetForegroundWindow is deliberately restricted by Windows: a process that
    does not own the foreground usually cannot steal it, and the call fails
    quietly rather than erroring. Pressing and releasing ALT first is the
    long-standing way to satisfy that rule — it makes this process briefly
    eligible — and ShowWindow(9) restores the window if it was minimised, which
    SetForegroundWindow alone will not do.
  */
  /*
    Fullscreen is F11, and F11 TOGGLES — so sending it blind would throw the
    owner out of fullscreen exactly when he claps while already there. There is
    no "make fullscreen" message to send a window; the browser owns that state.

    So: measure first. A window whose bounds already cover the whole screen is
    already fullscreen (or maximised without chrome, which looks the same and
    wants no change), and F11 is skipped. Anything smaller gets it.

    ShowWindow(9) is SW_RESTORE and only un-minimises — it restores the previous
    size, which is why the first version came back windowed.
  */
  if (!existsSync(WIN_EXE)) {
    throw new ActionError(
      `the window helper is not built. Run: node scripts/build-win.mjs`
    );
  }

  try {
    const { stdout } = await run(
      WIN_EXE,
      ["summon", "Operator", String(target.x), String(target.y), String(target.width), String(target.height), pause === false ? "0" : "1"],
      { timeout: 8000, windowsHide: true }
    );
    const out = String(stdout).trim();
    if (out === "NOWINDOW") {
      throw new ActionError(
        "no window with Operator in its title is open — nothing to bring to the front"
      );
    }
    const [title, fullscreen, moved, steps, rect] = out.split("|");
    const result = {
      focused: (title ?? "").slice(0, 120),
      fullscreen: fullscreen ?? "unknown",
      screen: `screen${Math.min(screenIndex, screens.length)}`,
      moved: moved ?? "unknown",
      steps: `${steps ?? ""} ${rect ?? ""}`.trim(),
    };
    // Logged as well as returned: the caller is usually a clap, and nobody is
    // reading a fetch response when this misbehaves.
    console.log(`[operator] summon — ${result.screen} ${result.fullscreen} ${result.moved} ${result.steps}`);
    return result;
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(
      `couldn't bring the window forward: ${String(err?.message ?? err)}. Windows only.`
    );
  }
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A date param, defaulting to today when omitted — every action that takes
    one accepts "today" as a bare word too, since that's how a task is phrased. */
function dateArg(value, name = "date") {
  if (value === undefined || value === "today") return todayKey();
  if (typeof value !== "string" || !DATE_KEY_RE.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new ActionError(`${name} must be "YYYY-MM-DD" or "today"`);
  }
  return value;
}

// --- Gym --------------------------------------------------------------------
// Mirrors src/hooks/useGym.ts. gym.sessions (the templates) is read-only here
// — sessions are fixed by weekday and there is no UI to create one, so there
// is nothing for an action to add.

async function gymToggleExercise({ date, exerciseId }) {
  required(exerciseId, "exerciseId");
  const key = dateArg(date);

  const sessions = (await readState("gym.sessions")) ?? [];
  const weekday = new Date(`${key}T00:00:00`).getDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  const session = sessions.find((s) => s.weekday === isoWeekday);
  if (session && !session.exercises.some((e) => e.id === exerciseId)) {
    throw new ActionError(
      `"${exerciseId}" is not in ${key}'s session (${session.name}). Exercise ids: ` +
        session.exercises.map((e) => e.id).join(", ")
    );
  }

  const next = await withState("gym.completions", (current) => {
    const prev = current ?? {};
    const day = prev[key] ?? [];
    const updated = day.includes(exerciseId)
      ? day.filter((id) => id !== exerciseId)
      : [...day, exerciseId];
    // Drop the key entirely when a day is emptied — same as the hook, so the
    // store doesn't accumulate a growing map of empty arrays over months.
    if (updated.length === 0) {
      const { [key]: _removed, ...rest } = prev;
      return rest;
    }
    return { ...prev, [key]: updated };
  });

  const done = next[key]?.includes(exerciseId) ?? false;
  return { date: key, exerciseId, done };
}

async function gymSkipDay({ date }) {
  const key = dateArg(date);
  await withState("gym.skipped", (current) => {
    const prev = current ?? [];
    return prev.includes(key) ? prev : [...prev, key];
  });
  // skipDay also clears that day's ticks in the hook — a half-ticked, also-
  // skipped day is two answers to one question.
  await withState("gym.completions", (current) => {
    const prev = current ?? {};
    if (!(key in prev)) return prev;
    const { [key]: _removed, ...rest } = prev;
    return rest;
  });
  return { date: key, skipped: true };
}

async function gymUnskipDay({ date }) {
  const key = dateArg(date);
  await withState("gym.skipped", (current) => (current ?? []).filter((d) => d !== key));
  return { date: key, skipped: false };
}

// --- Gym session templates ---------------------------------------------------
//
// `gym.sessions` is the programme itself — which exercises, on which weekday.
// Until now the capability layer could tick and skip a day but never change
// what a day *is*, so "propose a new gym routine and modify it" was a request
// no worker could carry out. The ticking half was built first because it is
// what a day needs; this is what a training block needs.
//
// The programme's own reasoning — phases, percentages, deloads — is owner
// content in `reference/gym-programme.md`, not something these actions know
// about. They change the checklist, not the plan behind it.

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function weekdayArg(value, name = "weekday") {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 7) {
    throw new ActionError(`${name} must be 1-7 (1 = Monday … 7 = Sunday)`);
  }
  return n;
}

async function gymSessionsList() {
  const sessions = (await readState("gym.sessions")) ?? [];
  return {
    count: sessions.length,
    sessions: [...sessions]
      .sort((a, b) => a.weekday - b.weekday)
      .map((s) => ({
        id: s.id,
        name: s.name,
        weekday: s.weekday,
        day: WEEKDAY_NAMES[s.weekday] ?? String(s.weekday),
        time: s.time,
        exercises: s.exercises.map((e) => ({ id: e.id, name: e.name, sets: e.sets, cue: e.cue ?? "" })),
      })),
    // Named so a worker proposing changes knows which days are free rather
    // than assuming a seven-day split.
    restDays: [1, 2, 3, 4, 5, 6, 7]
      .filter((d) => !sessions.some((s) => s.weekday === d))
      .map((d) => WEEKDAY_NAMES[d]),
  };
}

function findSession(sessions, weekday) {
  const session = sessions.find((s) => s.weekday === weekday);
  if (!session) {
    throw new ActionError(
      `no session on ${WEEKDAY_NAMES[weekday]} — it is a rest day. Use gym_session_create to add one.`
    );
  }
  return session;
}

async function gymSessionCreate({ weekday, name, time = "17:30" }) {
  const day = weekdayArg(weekday);
  required(name, "name");
  if (!/^\d{1,2}:\d{2}$/.test(time)) throw new ActionError('time must be "HH:MM"');

  const session = {
    id: generateId(),
    name: String(name).trim(),
    weekday: day,
    time,
    exercises: [],
  };
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    if (sessions.some((s) => s.weekday === day)) {
      throw new ActionError(
        `${WEEKDAY_NAMES[day]} already has a session ("${sessions.find((s) => s.weekday === day).name}"). Edit it, or delete it first.`
      );
    }
    return [...sessions, session];
  });
  return { id: session.id, weekday: day, day: WEEKDAY_NAMES[day], name: session.name };
}

async function gymSessionUpdate({ weekday, name, time }) {
  const day = weekdayArg(weekday);
  if (name === undefined && time === undefined) {
    throw new ActionError("nothing to update — pass name or time");
  }
  if (time !== undefined && !/^\d{1,2}:\d{2}$/.test(time)) {
    throw new ActionError('time must be "HH:MM"');
  }
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    findSession(sessions, day);
    return sessions.map((s) =>
      s.weekday !== day
        ? s
        : {
            ...s,
            ...(name !== undefined ? { name: String(name).trim() } : {}),
            ...(time !== undefined ? { time } : {}),
          }
    );
  });
  return { weekday: day, day: WEEKDAY_NAMES[day], updated: [name !== undefined && "name", time !== undefined && "time"].filter(Boolean) };
}

/**
 * Delete a whole training day.
 *
 * Its ticks are left alone deliberately. `gym.completions` is keyed by date and
 * exercise id, so past sessions stay readable as history — deleting the
 * template should not rewrite what was actually done in March.
 */
async function gymSessionDelete({ weekday }) {
  const day = weekdayArg(weekday);
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    findSession(sessions, day);
    return sessions.filter((s) => s.weekday !== day);
  });
  return { weekday: day, day: WEEKDAY_NAMES[day], deleted: true, note: "past ticks kept as history" };
}

async function gymAddExercise({ weekday, name, sets, cue, position }) {
  const day = weekdayArg(weekday);
  required(name, "name");
  required(sets, "sets");

  const exercise = {
    id: generateId(),
    name: String(name).trim(),
    sets: String(sets).trim(),
    ...(cue ? { cue: String(cue).trim() } : {}),
  };
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    const session = findSession(sessions, day);
    const list = [...session.exercises];
    // 1-based to match how the session reads on screen; out of range appends
    // rather than failing, since "put it at the end" is the common intent.
    const at = Number.isInteger(Number(position)) ? Number(position) - 1 : list.length;
    list.splice(Math.max(0, Math.min(at, list.length)), 0, exercise);
    return sessions.map((s) => (s.weekday === day ? { ...s, exercises: list } : s));
  });
  return { weekday: day, day: WEEKDAY_NAMES[day], exerciseId: exercise.id, name: exercise.name };
}

async function gymUpdateExercise({ weekday, exerciseId, name, sets, cue }) {
  const day = weekdayArg(weekday);
  required(exerciseId, "exerciseId");
  if (name === undefined && sets === undefined && cue === undefined) {
    throw new ActionError("nothing to update — pass name, sets, or cue");
  }
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    const session = findSession(sessions, day);
    if (!session.exercises.some((e) => e.id === exerciseId)) {
      throw new ActionError(
        `no exercise "${exerciseId}" on ${WEEKDAY_NAMES[day]}. Ids: ${session.exercises.map((e) => e.id).join(", ") || "none"}`
      );
    }
    return sessions.map((s) =>
      s.weekday !== day
        ? s
        : {
            ...s,
            exercises: s.exercises.map((e) =>
              e.id !== exerciseId
                ? e
                : {
                    ...e,
                    ...(name !== undefined ? { name: String(name).trim() } : {}),
                    ...(sets !== undefined ? { sets: String(sets).trim() } : {}),
                    ...(cue !== undefined ? { cue: String(cue).trim() } : {}),
                  }
            ),
          }
    );
  });
  return { weekday: day, exerciseId, updated: true };
}

async function gymRemoveExercise({ weekday, exerciseId }) {
  const day = weekdayArg(weekday);
  required(exerciseId, "exerciseId");
  await withState("gym.sessions", (current) => {
    const sessions = current ?? [];
    const session = findSession(sessions, day);
    if (!session.exercises.some((e) => e.id === exerciseId)) {
      throw new ActionError(`no exercise "${exerciseId}" on ${WEEKDAY_NAMES[day]}`);
    }
    return sessions.map((s) =>
      s.weekday !== day ? s : { ...s, exercises: s.exercises.filter((e) => e.id !== exerciseId) }
    );
  });
  return { weekday: day, exerciseId, removed: true };
}

// --- Mission Board ------------------------------------------------------------
// Mirrors src/hooks/useMissionBoard.ts.

const MISSION_CATEGORIES = [
  "server", "homelab", "darams", "ai", "learning", "career", "gym", "forex", "custom",
];
const MISSION_DIFFICULTIES = ["easy", "moderate", "hard", "epic"];
const MISSION_STATUSES = ["not_started", "in_progress", "blocked", "complete"];

function activityEntry(label) {
  return { id: generateId(), label, timestamp: new Date().toISOString() };
}

function withActivity(mission, label) {
  return { ...mission, activity: [activityEntry(label), ...mission.activity].slice(0, 30) };
}

async function missionCreate({ name, description = "", category, difficulty }) {
  required(name, "name");
  oneOf(category, MISSION_CATEGORIES, "category");
  oneOf(difficulty, MISSION_DIFFICULTIES, "difficulty");
  required(category, "category");
  required(difficulty, "difficulty");

  const record = {
    id: generateId(),
    name: String(name).trim(),
    description: String(description).trim(),
    category,
    difficulty,
    status: "not_started",
    progress: 0,
    timeInvestedHours: 0,
    nextObjective: "",
    objectivesNotes: "",
    notes: "",
    milestones: [],
    dependsOn: [],
    relatedLearning: "",
    relatedJourneyMilestone: "",
    whyItMatters: "",
    unlocks: "",
    knowledgeNeeded: "",
    activity: [activityEntry("Mission created")],
    archived: false,
    createdAt: new Date().toISOString(),
  };
  await withState("missions.records", (current) => [record, ...(current ?? [])]);
  return { id: record.id, name: record.name };
}

function findMission(missions, id) {
  const mission = missions.find((m) => m.id === id);
  if (!mission) throw new ActionError(`no mission with id "${id}"`);
  return mission;
}

async function missionSetStatus({ id, status }) {
  required(id, "id");
  oneOf(status, MISSION_STATUSES, "status");
  required(status, "status");
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    return missions.map((m) =>
      m.id === id ? withActivity({ ...m, status }, `Status changed to "${status.replace("_", " ")}"`) : m
    );
  });
  return { id, status };
}

async function missionSetProgress({ id, progress }) {
  required(id, "id");
  const pct = Number(progress);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ActionError("progress must be a number between 0 and 100");
  }
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    return missions.map((m) =>
      m.id === id ? withActivity({ ...m, progress: pct }, `Progress moved to ${pct}%`) : m
    );
  });
  return { id, progress: pct };
}

/**
 * Say that one mission must finish before another can start.
 *
 * Mirrors `useMissionBoard.toggleDependency`, including its toggle behaviour —
 * calling it twice with the same pair removes the link, exactly as tapping the
 * same row twice in `DependencyEditor` does.
 *
 * Added 2026-08-31 because there was no way for a worker to set one at all.
 * `dependsOn` is the oldest structural field on the board and the only one the
 * capability layer could not reach, which stopped mattering the moment the
 * mission map made those edges visible — the graph could be looked at and not
 * built.
 *
 * **Refuses a self-dependency and refuses to close a loop.** The UI cannot
 * easily produce either, a caller working from ids can produce both, and a
 * mission that waits on itself can never start. The map detects cycles and
 * warns, which is the right behaviour for data that already exists; refusing
 * to create one here is the cheaper place to stop it.
 */
async function missionSetDependency({ id, dependsOn }) {
  required(id, "id");
  required(dependsOn, "dependsOn");
  if (id === dependsOn) throw new ActionError("a mission cannot depend on itself");

  let result = null;
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    const mission = findMission(missions, id);
    const prerequisite = findMission(missions, dependsOn);
    const existing = mission.dependsOn ?? [];
    const removing = existing.includes(dependsOn);

    if (!removing) {
      // Walk the prerequisite's own chain: if it leads back here, this edge
      // would close a loop.
      const byId = new Map(missions.map((m) => [m.id, m]));
      const seen = new Set();
      const stack = [dependsOn];
      while (stack.length) {
        const next = stack.pop();
        if (next === id) {
          throw new ActionError(
            `that would make a loop — "${prerequisite.name}" already waits on "${mission.name}", ` +
              `directly or through another mission, so neither could ever start`
          );
        }
        if (seen.has(next)) continue;
        seen.add(next);
        for (const dep of byId.get(next)?.dependsOn ?? []) stack.push(dep);
      }
    }

    const nextDeps = removing
      ? existing.filter((d) => d !== dependsOn)
      : [...existing, dependsOn];
    result = { id, dependsOn: nextDeps, linked: !removing };

    return missions.map((m) =>
      m.id === id
        ? withActivity(
            { ...m, dependsOn: nextDeps },
            removing
              ? `No longer waiting on "${prerequisite.name}"`
              : `Now waits on "${prerequisite.name}"`
          )
        : m
    );
  });
  return result;
}

/** Everything else a mission can have edited on it in one go — the parts of
    updateMission() that make sense for a task rather than a UI form. */
async function missionUpdate({ id, ...patch }) {
  required(id, "id");
  const allowed = [
    "name", "description", "nextObjective", "objectivesNotes", "notes",
    "whyItMatters", "unlocks", "knowledgeNeeded", "relatedLearning",
    "relatedJourneyMilestone", "timeInvestedHours",
  ];
  const clean = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  if (Object.keys(clean).length === 0) {
    throw new ActionError(`nothing to update — pass one of: ${allowed.join(", ")}`);
  }
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    return missions.map((m) => (m.id === id ? { ...m, ...clean } : m));
  });
  return { id, updated: Object.keys(clean) };
}

async function missionArchive({ id, archived = true }) {
  required(id, "id");
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    return missions.map((m) =>
      m.id === id
        ? withActivity({ ...m, archived }, archived ? "Mission archived" : "Mission restored")
        : m
    );
  });
  return { id, archived };
}

async function missionAddMilestone({ id, title, dueDate }) {
  required(id, "id");
  required(title, "title");
  const milestone = {
    id: generateId(),
    title: String(title).trim(),
    status: "pending",
    ...(dueDate ? { dueDate: dateArg(dueDate, "dueDate") } : {}),
  };
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    return missions.map((m) =>
      m.id === id
        ? withActivity(
            { ...m, milestones: [...m.milestones, milestone] },
            `Milestone "${milestone.title}" added`
          )
        : m
    );
  });
  return { id, milestoneId: milestone.id };
}

async function missionUpdateMilestone({ id, milestoneId, status }) {
  required(id, "id");
  required(milestoneId, "milestoneId");
  oneOf(status, ["pending", "in_progress", "complete"], "status");
  required(status, "status");
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    const mission = findMission(missions, id);
    if (!mission.milestones.some((ms) => ms.id === milestoneId)) {
      throw new ActionError(`mission "${id}" has no milestone "${milestoneId}"`);
    }
    return missions.map((m) => {
      if (m.id !== id) return m;
      const updated = {
        ...m,
        milestones: m.milestones.map((ms) => (ms.id === milestoneId ? { ...ms, status } : ms)),
      };
      if (status === "complete") {
        const ms = m.milestones.find((x) => x.id === milestoneId);
        return withActivity(updated, `Milestone "${ms.title}" completed`);
      }
      return updated;
    });
  });
  return { id, milestoneId, status };
}

async function missionDelete({ id }) {
  required(id, "id");
  await withState("missions.records", (current) => {
    const missions = current ?? [];
    findMission(missions, id);
    // Deleting sweeps the id out of every other mission's dependsOn in the
    // same write — same invariant the hook keeps, and for the same reason:
    // a leftover id is not a broken link that shows up anywhere, it is an
    // invisible one that quietly means something different if the id is
    // ever reused.
    return missions
      .filter((m) => m.id !== id)
      .map((m) =>
        m.dependsOn.includes(id) ? { ...m, dependsOn: m.dependsOn.filter((d) => d !== id) } : m
      );
  });
  return { id, deleted: true };
}

// --- Calendar -----------------------------------------------------------------
// Mirrors src/hooks/useEvents.ts. Internally still events.records/CalendarEvent
// — only the user-facing label changed when Calendar was renamed from
// "Events". Recurrence is read-only here: a rule interacts with skip state and
// expansion in ways worth a deliberate second pass rather than guessing at
// today, in the first cut of an action an AI calls unsupervised.

const EVENT_KINDS = ["work", "personal", "admin", "health", "other"];

function resolveEventId(id) {
  return id.includes("@") ? id.slice(0, id.indexOf("@")) : id;
}

function findEvent(events, id) {
  const realId = resolveEventId(id);
  const event = events.find((e) => e.id === realId);
  if (!event) throw new ActionError(`no calendar event with id "${id}"`);
  return { realId, event };
}

async function eventCreate({ title, date, time, durationMinutes, kind, notes }) {
  required(title, "title");
  const key = dateArg(date, "date");
  oneOf(kind, EVENT_KINDS, "kind");
  if (time !== undefined && !/^\d{1,2}:\d{2}$/.test(time)) {
    throw new ActionError('time must be "HH:MM"');
  }

  const record = {
    id: generateId(),
    title: String(title).trim(),
    date: key,
    notes: notes ? String(notes).trim() : "",
    kind: kind ?? "other",
    ...(time ? { time } : {}),
    ...(time && Number(durationMinutes) > 0 ? { durationMinutes: Math.round(Number(durationMinutes)) } : {}),
  };
  await withState("events.records", (current) => [...(current ?? []), record]);
  return { id: record.id, title: record.title, date: record.date };
}

/**
 * A repeating event — one record, expanded at read time.
 *
 * The model stores a series as a single record with a rule, never as N copies
 * (`useEvents` expands it per render). So creating one here is one write, and
 * a single day can later be skipped without touching the rule.
 */
async function eventCreateRecurring({ title, from, weekdays, until, time, durationMinutes, kind, notes }) {
  required(title, "title");
  const start = dateArg(from, "from");
  const end = dateArg(until, "until");
  if (end < start) throw new ActionError("until must be on or after from");
  oneOf(kind, EVENT_KINDS, "kind");
  if (time !== undefined && !/^\d{1,2}:\d{2}$/.test(time)) {
    throw new ActionError('time must be "HH:MM"');
  }

  const days = Array.isArray(weekdays) ? weekdays.map(Number) : [];
  if (!days.length) throw new ActionError("weekdays is required — e.g. [1,3,5] for Mon/Wed/Fri");
  for (const d of days) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new ActionError("weekdays must be 1-7 (1 = Monday … 7 = Sunday)");
    }
  }

  const record = {
    id: generateId(),
    title: String(title).trim(),
    date: start,
    notes: notes ? String(notes).trim() : "",
    kind: kind ?? "other",
    ...(time ? { time } : {}),
    ...(time && Number(durationMinutes) > 0
      ? { durationMinutes: Math.round(Number(durationMinutes)) }
      : {}),
    recurrence: { type: "weekly", weekdays: [...new Set(days)].sort(), until: end },
  };
  await withState("events.records", (current) => [...(current ?? []), record]);
  return { id: record.id, title: record.title, from: start, until: end, weekdays: record.recurrence.weekdays };
}

/**
 * A block of consecutive days — annual leave, a holiday, a course.
 *
 * **No schema change needed for this, and that is the point.** A date range is
 * a daily recurrence: every weekday, from the first day to the last. Storing it
 * that way rather than as a new field means the calendar already renders it,
 * one day of it can already be skipped (a working day inside a holiday), and
 * deleting it already takes the whole block.
 */
async function eventCreateRange({ title, from, to, kind, notes }) {
  required(title, "title");
  const start = dateArg(from, "from");
  const end = dateArg(to, "to");
  if (end < start) throw new ActionError("to must be on or after from");
  oneOf(kind, EVENT_KINDS, "kind");

  const record = {
    id: generateId(),
    title: String(title).trim(),
    date: start,
    notes: notes ? String(notes).trim() : "",
    kind: kind ?? "personal",
    recurrence: { type: "weekly", weekdays: [1, 2, 3, 4, 5, 6, 7], until: end },
  };
  await withState("events.records", (current) => [...(current ?? []), record]);

  const days =
    Math.round(
      (new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86_400_000
    ) + 1;
  return { id: record.id, title: record.title, from: start, to: end, days };
}

async function eventUpdate({ id, ...patch }) {
  required(id, "id");
  const allowed = ["title", "notes", "kind", "time", "durationMinutes"];
  if (patch.kind !== undefined) oneOf(patch.kind, EVENT_KINDS, "kind");
  const clean = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  if (Object.keys(clean).length === 0) {
    throw new ActionError(`nothing to update — pass one of: ${allowed.join(", ")}`);
  }
  await withState("events.records", (current) => {
    const events = current ?? [];
    const { realId } = findEvent(events, id);
    return events.map((e) => (e.id === realId ? { ...e, ...clean } : e));
  });
  return { id, updated: Object.keys(clean) };
}

/** Whole record — for a series, every occurrence. Use skip for one day of one. */
async function eventDelete({ id }) {
  required(id, "id");
  await withState("events.records", (current) => {
    const events = current ?? [];
    const { realId } = findEvent(events, id);
    return events.filter((e) => e.id !== realId);
  });
  return { id, deleted: true };
}

async function eventSkipOccurrence({ id, date }) {
  required(id, "id");
  const key = dateArg(date, "date");
  await withState("events.records", (current) => {
    const events = current ?? [];
    const { realId, event } = findEvent(events, id);
    if (!event.recurrence) throw new ActionError(`"${id}" does not repeat — delete it instead`);
    return events.map((e) =>
      e.id === realId && !(e.skipDates ?? []).includes(key)
        ? { ...e, skipDates: [...(e.skipDates ?? []), key] }
        : e
    );
  });
  return { id, date: key, skipped: true };
}

async function eventUnskipOccurrence({ id, date }) {
  required(id, "id");
  const key = dateArg(date, "date");
  await withState("events.records", (current) => {
    const events = current ?? [];
    const { realId } = findEvent(events, id);
    return events.map((e) =>
      e.id === realId ? { ...e, skipDates: (e.skipDates ?? []).filter((d) => d !== key) } : e
    );
  });
  return { id, date: key, skipped: false };
}

// --- Daily Routine --------------------------------------------------------
// Mirrors src/hooks/useRoutineData.ts. Sections are fixed by the type (seven,
// no create/delete) — only their tasks are mutable here.

const ROUTINE_SECTIONS = ["morning", "work", "gym", "learning", "forex", "evening", "sleep"];

function findSectionAndTask(sections, sectionKey, taskId) {
  const section = sections.find((s) => s.key === sectionKey);
  if (!section) throw new ActionError(`no routine section "${sectionKey}"`);
  const task = section.tasks.find((t) => t.id === taskId);
  if (!task) throw new ActionError(`section "${sectionKey}" has no task "${taskId}"`);
  return { section, task };
}

/** Toggles a step, exactly as the hook's two-store split does: a repeating
    step is a fact about the date (routine.completions), a one-off step is a
    fact about the step itself (routine.sections). */
async function routineToggleTask({ sectionKey, taskId, date }) {
  oneOf(sectionKey, ROUTINE_SECTIONS, "sectionKey");
  required(sectionKey, "sectionKey");
  required(taskId, "taskId");

  const sections = (await readState("routine.sections")) ?? [];
  const { task } = findSectionAndTask(sections, sectionKey, taskId);

  if (!task.repeatDaily) {
    await withState("routine.sections", (current) =>
      (current ?? []).map((s) =>
        s.key !== sectionKey
          ? s
          : { ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)) }
      )
    );
    return { sectionKey, taskId, done: !task.done };
  }

  const key = dateArg(date);
  const next = await withState("routine.completions", (current) => {
    const prev = current ?? {};
    const day = prev[key] ?? [];
    const updated = day.includes(taskId) ? day.filter((id) => id !== taskId) : [...day, taskId];
    if (updated.length === 0) {
      const { [key]: _dropped, ...rest } = prev;
      return rest;
    }
    return { ...prev, [key]: updated };
  });
  return { sectionKey, taskId, date: key, done: next[key]?.includes(taskId) ?? false };
}

async function routineAddTask({ sectionKey, title, estimatedMinutes = 10 }) {
  oneOf(sectionKey, ROUTINE_SECTIONS, "sectionKey");
  required(sectionKey, "sectionKey");
  required(title, "title");
  const minutes = Number(estimatedMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new ActionError("estimatedMinutes must be a non-negative number");
  }

  const task = {
    id: generateId(),
    title: String(title).trim(),
    done: false,
    estimatedMinutes: minutes,
    repeatDaily: true,
  };
  await withState("routine.sections", (current) => {
    const sections = current ?? [];
    if (!sections.some((s) => s.key === sectionKey)) {
      throw new ActionError(`no routine section "${sectionKey}"`);
    }
    return sections.map((s) => (s.key === sectionKey ? { ...s, tasks: [...s.tasks, task] } : s));
  });
  return { sectionKey, taskId: task.id, title: task.title };
}

async function routineDeleteTask({ sectionKey, taskId }) {
  oneOf(sectionKey, ROUTINE_SECTIONS, "sectionKey");
  required(sectionKey, "sectionKey");
  required(taskId, "taskId");
  await withState("routine.sections", (current) => {
    const sections = current ?? [];
    findSectionAndTask(sections, sectionKey, taskId);
    return sections.map((s) =>
      s.key !== sectionKey ? s : { ...s, tasks: s.tasks.filter((t) => t.id !== taskId) }
    );
  });
  return { sectionKey, taskId, deleted: true };
}

// --- reads ------------------------------------------------------------------
//
// Added 2026-08-20, after watching a worker spend 129 seconds and $0.92
// answering "what's my gym session today". Every action above is a *write*, so
// there was no way to simply ask — it grepped source, read seed files, curled
// the raw state API and computed an ISO weekday by hand, tripping the shadowed
// `node` on the way. Its own transcript said it plainly: "No read action in
// the capability layer, so I'll read the gym data directly."
//
// A worker with no filesystem (Gemini) could not have answered at all. A
// capability layer that can change everything and report nothing is half a
// layer, and the missing half is the one a question needs.
//
// These mirror the *derived* views their hooks expose, not the raw slices —
// `sessionOn`, `byDay`, the recurrence expansion — because those derivations
// are where the real logic lives. Returning raw state would just move the
// spelunking into the model.

/** Mirrors `isoWeekday()` in src/lib/time.ts: 1 = Monday … 7 = Sunday. */
function isoWeekdayOf(dateKey) {
  const day = new Date(`${dateKey}T00:00:00`).getDay();
  return day === 0 ? 7 : day;
}

async function gymDay({ date }) {
  const key = dateArg(date);
  const [sessions, completions, skipped] = await Promise.all([
    readState("gym.sessions"),
    readState("gym.completions"),
    readState("gym.skipped"),
  ]);

  const weekday = isoWeekdayOf(key);
  const session = (sessions ?? []).find((s) => s.weekday === weekday) ?? null;
  const done = (completions ?? {})[key] ?? [];
  const isSkipped = (skipped ?? []).includes(key);

  // A rest day is a real answer, not an absence — say so rather than
  // returning an empty session and letting the model infer it.
  if (!session) {
    return { date: key, weekday, restDay: true, skipped: isSkipped, session: null };
  }
  return {
    date: key,
    weekday,
    restDay: false,
    skipped: isSkipped,
    session: {
      name: session.name,
      exercises: session.exercises.map((e) => ({
        id: e.id,
        name: e.name,
        detail: e.detail ?? e.target ?? "",
        done: done.includes(e.id),
      })),
      doneCount: session.exercises.filter((e) => done.includes(e.id)).length,
      total: session.exercises.length,
    },
  };
}

/**
 * Calendar occurrences on a day, or across a window.
 *
 * Expands recurring series the same way `useEvents` does — one record per
 * series, materialised per day, honouring `skipDates`. Without this a worker
 * reading `events.records` raw would report the rule ("every Tuesday") and
 * miss both the skips and what actually lands on the date asked about.
 */
function occurrencesBetween(events, fromKey, toKey) {
  const out = [];
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);

  for (const event of events) {
    if (!event.recurrence) {
      if (event.date >= fromKey && event.date <= toKey) {
        out.push({ ...event, seriesId: event.id });
      }
      continue;
    }
    const skip = new Set(event.skipDates ?? []);
    const wanted = new Set(event.recurrence.weekdays ?? []);
    const cursor = new Date(Math.max(from, new Date(`${event.date}T00:00:00`)));
    const end = new Date(
      Math.min(to, new Date(`${event.recurrence.until ?? toKey}T00:00:00`))
    );
    // setDate rather than adding 86_400_000ms — the millisecond walk drifts
    // across a DST boundary, twice a year, which is exactly the class of bug
    // OPS-009 already cost this project once.
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
        cursor.getDate()
      ).padStart(2, "0")}`;
      if (wanted.has(isoWeekdayOf(key)) && !skip.has(key)) {
        out.push({ ...event, date: key, seriesId: event.id, recurring: true });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return out
    .map((e) => ({
      id: e.seriesId,
      title: e.title,
      date: e.date,
      time: e.time ?? null,
      durationMinutes: e.durationMinutes ?? null,
      kind: e.kind,
      notes: e.occurrenceNotes?.[e.date] || e.notes || "",
      recurring: e.recurring === true,
    }))
    .sort((a, b) => (a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date.localeCompare(b.date)));
}

async function calendarRange({ from, days = 7 }) {
  const start = dateArg(from, "from");
  const count = Math.min(Math.max(Number(days) || 7, 1), 90);
  const end = new Date(`${start}T00:00:00`);
  end.setDate(end.getDate() + count - 1);
  const endKey = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(
    end.getDate()
  ).padStart(2, "0")}`;

  const events = (await readState("events.records")) ?? [];
  const occurrences = occurrencesBetween(events, start, endKey);
  return { from: start, to: endKey, count: occurrences.length, events: occurrences };
}

async function missionsList({ status, includeArchived = false }) {
  oneOf(status, MISSION_STATUSES, "status");
  const missions = (await readState("missions.records")) ?? [];
  const filtered = missions
    .filter((m) => (includeArchived ? true : !m.archived))
    .filter((m) => (status ? m.status === status : true));
  return {
    count: filtered.length,
    missions: filtered.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      difficulty: m.difficulty,
      status: m.status,
      progress: m.progress,
      nextObjective: m.nextObjective || "",
      archived: m.archived === true,
      milestones: `${m.milestones.filter((ms) => ms.status === "complete").length}/${m.milestones.length}`,
    })),
  };
}

async function routineDay({ date }) {
  const key = dateArg(date);
  const [sections, completions] = await Promise.all([
    readState("routine.sections"),
    readState("routine.completions"),
  ]);
  const doneToday = (completions ?? {})[key] ?? [];

  // Mirrors `isDoneOn`: a repeating step is a fact about the date, a one-off
  // is a fact about the step. Reading `done` for everything would report
  // yesterday's repeating ticks as today's.
  const out = (sections ?? []).map((s) => ({
    key: s.key,
    label: s.label,
    startTime: s.startTime ?? null,
    notes: s.notes || "",
    tasks: s.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      estimatedMinutes: t.estimatedMinutes,
      repeatDaily: t.repeatDaily !== false,
      done: t.repeatDaily === false ? t.done === true : doneToday.includes(t.id),
    })),
  }));

  const all = out.flatMap((s) => s.tasks);
  return {
    date: key,
    doneCount: all.filter((t) => t.done).length,
    total: all.length,
    sections: out,
  };
}

// --- jobs -------------------------------------------------------------------
//
// Reading a job's own transcript, added 2026-08-22 after recovering one took
// roughly fifteen raw shell calls — the wrong `node` on PATH twice, the wrong
// checkout once, and three directories searched before the one that had it.
// Every other job-adjacent read goes through a pre-approved action; this was
// the one path that still cost a round of permission taps and guesswork.
//
// The case it exists for is specific and recurring: a job stops mid-plan —
// quota spent, a limit hit, a turn cancelled — and what it had already worked
// out is sitting in an event log nobody can reach without a file hunt.

/** Event types that carry the substance, when the caller wants the gist. */
const SUBSTANTIVE = new Set(["prompt", "text", "permission_request", "routed"]);

async function jobEvents({ id, since = 0, textOnly = false, limit = 200 }) {
  required(id, "id");

  // Imported lazily. `jobs.mjs` imports this file for the capability layer, so
  // a top-level import here would be a cycle — and the one direction that
  // matters (jobs owns the queue, actions owns the data) stays intact this way.
  const jobs = await import("./jobs.mjs");
  const detail = jobs.detail(String(id), Number(since) || 0);
  if (!detail) {
    throw new ActionError(
      `no job "${id}". Note that event logs do not survive a server restart, even though the tab does.`
    );
  }

  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  let events = detail.events;
  if (textOnly) events = events.filter((e) => SUBSTANTIVE.has(e.type));

  // Newest kept when truncating: recovering a stalled job means wanting what it
  // said last, not what it said first.
  const truncated = events.length > cap;
  if (truncated) events = events.slice(-cap);

  return {
    id: detail.id,
    title: detail.title,
    status: detail.status,
    provider: detail.provider,
    model: detail.model,
    turns: detail.turns,
    error: detail.error,
    truncated,
    latest: detail.latest,
    events: events.map((e) => ({
      seq: e.seq,
      at: e.at,
      type: e.type,
      ...(e.text ? { text: e.text } : {}),
      ...(e.tool ? { tool: e.tool } : {}),
      ...(e.subject ? { subject: e.subject } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.why ? { why: e.why } : {}),
    })),
  };
}

async function jobsList() {
  const jobs = await import("./jobs.mjs");
  const { jobs: list, running } = jobs.list();
  return {
    running: running ?? null,
    count: list.length,
    jobs: list.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      provider: j.provider,
      model: j.model,
      turns: j.turns,
      asking: j.asking ?? 0,
      error: j.error,
      createdAt: j.createdAt,
    })),
  };
}

// --- registry ---------------------------------------------------------------

/**
 * name → { description, params, handler }.
 *
 * `params` is documentation, not a schema library: a short line per parameter,
 * good enough to hand to `runner.mjs` as a tool description and to a human
 * reading this file. `CLAUDE.md` is explicit about not reaching for a generic
 * validator here — every action already validates its own inputs by hand,
 * above, which is also what keeps each error message specific to what was
 * actually wrong.
 */
const ACTIONS = {
  /*
    Reads first, deliberately — `listActions()` output is what a worker reads
    to decide what it can do, and a catalogue that opens with four ways to
    change the gym log and no way to look at it is what sent one spelunking
    through source for two minutes.
  */
  gym_day: {
    description:
      "What the gym session is on a date: its exercises, which are ticked, whether it's a rest day or was skipped. Use this to answer any question about training — never read the store directly.",
    params: "date? (YYYY-MM-DD or \"today\")",
    handler: gymDay,
  },
  now: {
    description:
      "The current date and time on the machine Operator runs on, in the owner's local timezone. Use this for anything about \"now\", \"today\" or what the time is — do NOT read the calendar to work it out.",
    params: "(none)",
    handler: currentTime,
  },
  focus_operator: {
    description:
      "Summon Operator: pause whatever is playing, bring its window to the front on the configured screen, and make it fullscreen. Windows only.",
    params: 'pause? (default true — set false to leave audio alone)',
    handler: focusOperator,
  },
  media_play_pause: {
    description:
      "Press the play/pause media key on the machine Operator runs on — the same signal a Bluetooth headset's button sends, so it pauses whatever is playing (Spotify, a video, anything holding the media session). Toggles: pressing it with nothing playing resumes the last thing.",
    params: "(none)",
    handler: mediaPlayPause,
  },
  calendar_range: {
    description:
      "Calendar events from a date onwards, with recurring series already expanded and skipped days removed. Use for \"what's on today/this week\".",
    params: "from? (YYYY-MM-DD or \"today\"), days? (default 7, max 90)",
    handler: calendarRange,
  },
  missions_list: {
    description: "The Mission Board: names, ids, status, progress, milestone counts.",
    params: "status? (not_started|in_progress|blocked|complete), includeArchived? (default false)",
    handler: missionsList,
  },
  routine_day: {
    description:
      "The Daily Routine for a date — every section, its steps, and which are done on that date.",
    params: "date? (YYYY-MM-DD or \"today\")",
    handler: routineDay,
  },
  jobs_list: {
    description:
      "Every Orchestrator conversation and its state — which is running, which is waiting on an answer, which failed and why.",
    params: "(none)",
    handler: jobsList,
  },
  job_events: {
    description:
      "Read a job's own transcript. Use this to recover what a stalled, failed or quota-exhausted job had already worked out, instead of hunting through files. Event logs do not survive a server restart.",
    params:
      "id (e.g. \"job-4\"), since? (sequence number, for just the new events), textOnly? (prompts and replies only, skipping tool noise), limit? (default 200, newest kept)",
    handler: jobEvents,
  },
  gym_sessions_list: {
    description:
      "The whole training week — every session, its exercises and ids, plus which days are rest days. Read this before proposing changes to the programme.",
    params: "(none)",
    handler: gymSessionsList,
  },
  gym_session_create: {
    description: "Add a training day to a weekday that currently has none.",
    params: "weekday (1-7, 1 = Monday), name, time? (HH:MM, default 17:30)",
    handler: gymSessionCreate,
  },
  gym_session_update: {
    description: "Rename a training day or change its start time.",
    params: "weekday (1-7), name?, time? (HH:MM)",
    handler: gymSessionUpdate,
  },
  gym_session_delete: {
    description:
      "Remove a training day, making it a rest day. Past ticks are kept — deleting the template does not rewrite history.",
    params: "weekday (1-7)",
    handler: gymSessionDelete,
  },
  gym_add_exercise: {
    description: "Add an exercise to a training day.",
    params: "weekday (1-7), name, sets (free text, e.g. \"4 × 8-10\"), cue?, position? (1-based, appends by default)",
    handler: gymAddExercise,
  },
  gym_update_exercise: {
    description: "Change an exercise's name, sets or cue.",
    params: "weekday (1-7), exerciseId, name?, sets?, cue?",
    handler: gymUpdateExercise,
  },
  gym_remove_exercise: {
    description: "Remove an exercise from a training day.",
    params: "weekday (1-7), exerciseId",
    handler: gymRemoveExercise,
  },
  gym_toggle_exercise: {
    description: "Tick or untick one exercise on a gym day. Untick by calling it again.",
    params: "date? (YYYY-MM-DD or \"today\"), exerciseId",
    handler: gymToggleExercise,
  },
  gym_skip_day: {
    description: "Mark a gym day as scheduled but not trained. Clears any ticks on it.",
    params: "date? (YYYY-MM-DD or \"today\")",
    handler: gymSkipDay,
  },
  gym_unskip_day: {
    description: "Undo gym_skip_day.",
    params: "date? (YYYY-MM-DD or \"today\")",
    handler: gymUnskipDay,
  },
  mission_create: {
    description: "Create a new mission on the Mission Board.",
    params:
      "name, description?, category (server|homelab|darams|ai|learning|career|gym|forex|custom), difficulty (easy|moderate|hard|epic)",
    handler: missionCreate,
  },
  mission_set_status: {
    description: "Change a mission's status.",
    params: "id, status (not_started|in_progress|blocked|complete)",
    handler: missionSetStatus,
  },
  mission_set_progress: {
    description: "Set a mission's progress percentage.",
    params: "id, progress (0-100)",
    handler: missionSetProgress,
  },
  mission_set_dependency: {
    description:
      "Say that one mission must finish before another can start. Calling it again with the same pair removes the link. Refuses a loop.",
    params: "id (the mission that waits), dependsOn (the mission it waits for)",
    handler: missionSetDependency,
  },
  mission_update: {
    description: "Edit a mission's text fields (name, description, notes, objectives, etc).",
    params: "id, plus any of: name, description, nextObjective, objectivesNotes, notes, whyItMatters, unlocks, knowledgeNeeded, relatedLearning, relatedJourneyMilestone, timeInvestedHours",
    handler: missionUpdate,
  },
  mission_archive: {
    description: "Archive or restore a mission. Non-destructive — archived missions stay findable.",
    params: "id, archived? (true to archive, false to restore — defaults to true)",
    handler: missionArchive,
  },
  mission_add_milestone: {
    description: "Add a milestone to a mission.",
    params: "id, title, dueDate? (YYYY-MM-DD)",
    handler: missionAddMilestone,
  },
  mission_update_milestone: {
    description: "Change a milestone's status.",
    params: "id, milestoneId, status (pending|in_progress|complete)",
    handler: missionUpdateMilestone,
  },
  mission_delete: {
    description: "Permanently delete a mission. Prefer mission_archive unless asked explicitly to delete.",
    params: "id",
    handler: missionDelete,
  },
  calendar_create_event: {
    description: "Add an event to the calendar. One-off only — recurring series are not created by this action.",
    params: "title, date (YYYY-MM-DD or \"today\"), time? (HH:MM), durationMinutes?, kind? (work|personal|admin|health|other), notes?",
    handler: eventCreate,
  },
  calendar_create_recurring: {
    description:
      "Add a repeating event — a shift pattern, a weekly class. Stored as one record with a rule, so a single day can be skipped later without touching the rest.",
    params:
      "title, from (YYYY-MM-DD or \"today\"), weekdays (array, 1-7 where 1 = Monday), until (YYYY-MM-DD), time? (HH:MM), durationMinutes?, kind? (work|personal|admin|health|other), notes?",
    handler: eventCreateRecurring,
  },
  calendar_create_range: {
    description:
      "Block out consecutive days — annual leave, a holiday, a course. Covers every day from first to last, and a single day inside it can still be skipped.",
    params:
      "title, from (YYYY-MM-DD or \"today\"), to (YYYY-MM-DD), kind? (defaults to personal), notes?",
    handler: eventCreateRange,
  },
  calendar_update_event: {
    description: "Edit an event's title, notes, kind, time, or duration.",
    params: "id, plus any of: title, notes, kind, time, durationMinutes",
    handler: eventUpdate,
  },
  calendar_delete_event: {
    description: "Delete a calendar event. For a recurring series this removes every occurrence — use calendar_skip_occurrence for one day of it.",
    params: "id",
    handler: eventDelete,
  },
  calendar_skip_occurrence: {
    description: "Drop a single day out of a recurring event without touching the series.",
    params: "id, date (YYYY-MM-DD or \"today\")",
    handler: eventSkipOccurrence,
  },
  calendar_unskip_occurrence: {
    description: "Undo calendar_skip_occurrence.",
    params: "id, date (YYYY-MM-DD or \"today\")",
    handler: eventUnskipOccurrence,
  },
  routine_toggle_task: {
    description: "Tick or untick a Daily Routine step.",
    params: "sectionKey (morning|work|gym|learning|forex|evening|sleep), taskId, date? (YYYY-MM-DD or \"today\" — ignored for one-off steps)",
    handler: routineToggleTask,
  },
  routine_add_task: {
    description: "Add a new step to a Daily Routine section.",
    params: "sectionKey (morning|work|gym|learning|forex|evening|sleep), title, estimatedMinutes? (default 10)",
    handler: routineAddTask,
  },
  routine_delete_task: {
    description: "Remove a step from a Daily Routine section.",
    params: "sectionKey (morning|work|gym|learning|forex|evening|sleep), taskId",
    handler: routineDeleteTask,
  },
};

/** For the tool layer to advertise, and for a human reading /api/actions. */
export function listActions() {
  return Object.entries(ACTIONS).map(([name, { description, params }]) => ({
    name,
    description,
    params,
  }));
}

/**
 * Run one action by name.
 *
 * Throws `ActionError` for anything the caller got wrong (bad params, unknown
 * id) — the caller's job is to decide how that surfaces, same as every other
 * handler in this codebase. An unknown action name is the same kind of error,
 * not a 500: nothing here should ever throw for a reason a caller could not
 * have avoided by reading `listActions()`.
 */
export async function runAction(name, params = {}) {
  const action = ACTIONS[name];
  if (!action) {
    throw new ActionError(`no such action "${name}". Known actions: ${Object.keys(ACTIONS).join(", ")}`);
  }
  return action.handler(params ?? {});
}
