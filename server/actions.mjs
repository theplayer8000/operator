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
import { notify, configured as notifyConfigured } from "./notify.mjs";
import { remember, forget, listFacts } from "./memory.mjs";
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

/**
 * Hear one thing, and return what was said.
 *
 * Takes audio from the listener that is ALREADY running rather than opening a
 * second capture — a second ffmpeg on the same dshow device records digital
 * silence, which on this machine looked convincingly like three broken
 * microphones. `server/listen.mjs` holds the stream and keeps a rolling
 * pre-roll, so the transcript also includes what was said just before this was
 * called.
 *
 * The import is lazy so `actions.mjs` does not pull the audio stack in for the
 * thirty-odd actions that have nothing to do with it.
 */
async function listenOnce({ seconds } = {}) {
  const secs = Math.min(30, Math.max(1, Number(seconds ?? 6) || 6));
  const { captureAndTranscribe } = await import("./listen.mjs");
  try {
    const result = await captureAndTranscribe(secs);
    return {
      heard: result.text,
      confidence: result.confidence,
      seconds: secs,
      // Diagnostics: an empty transcript with a flat peak is a microphone
      // problem; an empty one with real audio is whisper not making it out.
      peak: Number((result.peak ?? 0).toFixed(4)),
      voicedPercent: Number((result.voicedPct ?? 0).toFixed(1)),
    };
  } catch (err) {
    throw new ActionError(String(err?.message ?? err));
  }
}

async function focusOperator() {
  /*
    Summoning NEVER touches what is playing.

    The clap used to pause your music as a side effect, and the owner's verdict
    was blunt and correct: "remove the media play thing i'll just pause it
    myself." A gesture that does two things when you asked for one is
    surprising, and the surprising half was reaching into whatever held the
    media session.

    The `pause` parameter is gone rather than defaulted to false, because a
    default is something a future caller can switch back on by accident.
    `media_play_pause` still exists as its own named action, so "pause that"
    remains possible — it just has to be asked for.
  */
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
      // Trailing "0": never pause media. See focusOperator's header.
      ["summon", "Operator", String(target.x), String(target.y), String(target.width), String(target.height), "0"],
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

// --- Knowledge Vault --------------------------------------------------------
//
// The READ actions here matter more than the writes, and that is not the usual
// balance. This file's header says a new feature needs a read action because
// without one a worker greps source to answer a question - $0.92 and two
// minutes, the one time it happened. A vault is the extreme case of that: its
// entire purpose is to hold answers, and one nothing can query is a folder.
//
// `knowledge_search` deliberately mirrors `lib/search.ts` rather than doing its
// own thing. Same weights, same "every term must appear" rule, same confidence
// nudge - so a worker and the page rank the same notes the same way. Two
// implementations of one ranking is how they drift into disagreeing about what
// the best answer is, which is the one thing a vault must not do.

const KNOWLEDGE_KINDS = ["note", "command", "resource"];
const KNOWLEDGE_CONFIDENCE = ["unverified", "works", "verified"];

const normaliseText = (text) => String(text ?? "").toLowerCase().normalize("NFKD");

/** Same weights as lib/search.ts. Change both or neither. */
const SEARCH_WEIGHT = { title: 12, topic: 7, source: 3, body: 1 };

function rankNotes(notes, query, limit) {
  const terms = normaliseText(query)
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);

  if (terms.length === 0) return notes.slice(0, limit);

  const hits = [];
  for (const note of notes) {
    const title = normaliseText(note.title);
    const body = normaliseText(note.body);
    const source = normaliseText(note.source);
    const topics = (note.topics ?? []).map(normaliseText);

    let score = 0;
    let allPresent = true;
    for (const term of terms) {
      let points = 0;
      if (title.includes(term)) {
        points += SEARCH_WEIGHT.title * (new RegExp(String.raw`\b` + term, "u").test(title) ? 1 : 0.5);
      }
      if (topics.some((t) => t.includes(term))) points += SEARCH_WEIGHT.topic;
      if (source.includes(term)) points += SEARCH_WEIGHT.source;
      if (body.includes(term)) {
        const occurrences = body.split(term).length - 1;
        points += SEARCH_WEIGHT.body * (1 + Math.log2(occurrences));
      }
      if (points === 0) allPresent = false;
      score += points;
    }
    if (!allPresent || score === 0) continue;
    if (note.confidence === "verified") score *= 1.15;
    if (note.confidence === "unverified") score *= 0.9;
    hits.push({ note, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.note);
}

/**
 * Trim a note for a worker reading a LIST.
 *
 * The body is the expensive field and usually the point, so it is summarised
 * here and served whole by `knowledge_get`. Ten notes' full bodies in a search
 * result is most of a context window spent on nine answers to questions nobody
 * asked.
 */
const noteSummary = (note) => ({
  id: note.id,
  title: note.title,
  kind: note.kind,
  confidence: note.confidence,
  topics: note.topics ?? [],
  excerpt: String(note.body ?? "").slice(0, 240),
  hasMore: String(note.body ?? "").length > 240,
  links: (note.links ?? []).length,
  updatedAt: note.updatedAt,
});

async function knowledgeSearch({ query = "", topic, kind, limit = 8, includeArchived = false }) {
  oneOf(kind, KNOWLEDGE_KINDS, "kind");
  const all = (await readState("knowledge.notes")) ?? [];
  let notes = includeArchived ? all : all.filter((n) => !n.archived);
  if (topic) {
    const wanted = String(topic).trim().toLowerCase();
    notes = notes.filter((n) => (n.topics ?? []).includes(wanted));
  }
  if (kind) notes = notes.filter((n) => n.kind === kind);

  const capped = Math.max(1, Math.min(25, Number(limit) || 8));
  const ranked = rankNotes(notes, query, capped);
  return {
    count: ranked.length,
    of: notes.length,
    /*
      Said out loud, because the honesty is load-bearing. This ranks by WORDS.
      A worker told "no match" should try different vocabulary rather than
      concluding the vault has nothing on the subject - which is the wrong
      conclusion to act on, and the reason the Search Service boundary exists
      to become a vector lookup later.
    */
    matching: "words, not meaning - try other vocabulary before concluding it is not written down",
    notes: ranked.map(noteSummary),
  };
}

async function knowledgeGet({ id }) {
  required(id, "id");
  const all = (await readState("knowledge.notes")) ?? [];
  const note = all.find((n) => n.id === id);
  if (!note) throw new ActionError(`no note with id "${id}"`);
  return {
    ...note,
    // Derived, exactly as the page derives it - one edge, two views.
    linkedFrom: all
      .filter((n) => !n.archived && (n.links ?? []).includes(note.id))
      .map((n) => ({ id: n.id, title: n.title })),
    linksTo: (note.links ?? [])
      .map((linkId) => all.find((n) => n.id === linkId))
      .filter(Boolean)
      .map((n) => ({ id: n.id, title: n.title })),
  };
}

async function knowledgeTopics() {
  const all = (await readState("knowledge.notes")) ?? [];
  const counts = new Map();
  for (const note of all.filter((n) => !n.archived)) {
    for (const topic of note.topics ?? []) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return {
    topics: [...counts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)),
  };
}

/*
  Topics are lowercased here as well as in the hook.

  Not belt and braces - this is the path a MODEL writes through, and a model
  will capitalise a proper noun every time. "Docker" and "docker" as two topics
  is how the topic list becomes noise, and the hook's cleaning cannot help a
  write that never goes through it.
*/
const cleanNoteTopics = (raw) => [
  ...new Set(
    (Array.isArray(raw) ? raw : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
  ),
];

async function knowledgeAdd({ title, body = "", kind, confidence, topics, missions, source }) {
  required(title, "title");
  oneOf(kind, KNOWLEDGE_KINDS, "kind");
  oneOf(confidence, KNOWLEDGE_CONFIDENCE, "confidence");

  const now = new Date().toISOString();
  const note = {
    id: generateId(),
    title: String(title).trim(),
    body: String(body ?? ""),
    kind: kind ?? "note",
    // Unverified by default, and honest: something just written down has by
    // definition not been checked since. A model asserting otherwise about its
    // own output is exactly the claim this field exists to prevent.
    confidence: confidence ?? "unverified",
    topics: cleanNoteTopics(topics),
    links: [],
    missions: Array.isArray(missions) ? missions : [],
    ...(source ? { source: String(source) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await withState("knowledge.notes", (current) => [note, ...(current ?? [])]);
  return { id: note.id, title: note.title, confidence: note.confidence };
}

async function knowledgeUpdate({ id, title, body, kind, confidence, topics, source }) {
  required(id, "id");
  oneOf(kind, KNOWLEDGE_KINDS, "kind");
  oneOf(confidence, KNOWLEDGE_CONFIDENCE, "confidence");

  let found = false;
  await withState("knowledge.notes", (current) =>
    (current ?? []).map((n) => {
      if (n.id !== id) return n;
      found = true;
      return {
        ...n,
        ...(title !== undefined ? { title: String(title).trim() } : {}),
        ...(body !== undefined ? { body: String(body) } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(topics !== undefined ? { topics: cleanNoteTopics(topics) } : {}),
        ...(source !== undefined ? { source: String(source) } : {}),
        updatedAt: new Date().toISOString(),
      };
    }),
  );
  if (!found) throw new ActionError(`no note with id "${id}"`);
  return { id, updated: true };
}

/** Link or unlink two notes. Calling it again with the same pair removes it. */
async function knowledgeLink({ id, linkTo }) {
  required(id, "id");
  required(linkTo, "linkTo");
  if (id === linkTo) throw new ActionError("a note cannot link to itself");

  const all = (await readState("knowledge.notes")) ?? [];
  if (!all.some((n) => n.id === id)) throw new ActionError(`no note with id "${id}"`);
  if (!all.some((n) => n.id === linkTo)) throw new ActionError(`no note with id "${linkTo}"`);

  let linked = false;
  await withState("knowledge.notes", (current) =>
    (current ?? []).map((n) => {
      if (n.id !== id) return n;
      const has = (n.links ?? []).includes(linkTo);
      linked = !has;
      return {
        ...n,
        links: has ? n.links.filter((l) => l !== linkTo) : [...(n.links ?? []), linkTo],
        updatedAt: new Date().toISOString(),
      };
    }),
  );
  return { id, linkTo, linked };
}

/*
  Archive, never delete - the hook's bargain, mirrored.

  There is no undo anywhere in Operator (OPS-020), and a note is the least
  recoverable thing in the store: a mission can be described again from the
  work, a gym session from the programme, but something worked out once and
  written down is gone. So there is no knowledge_delete action at all, which is
  a deliberate absence rather than an oversight.
*/
async function knowledgeArchive({ id, archived = true }) {
  required(id, "id");
  let found = false;
  await withState("knowledge.notes", (current) =>
    (current ?? []).map((n) => {
      if (n.id !== id) return n;
      found = true;
      return { ...n, archived: Boolean(archived), updatedAt: new Date().toISOString() };
    }),
  );
  if (!found) throw new ActionError(`no note with id "${id}"`);
  return { id, archived: Boolean(archived) };
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
  /*
    Memory: what Operator knows about the OWNER, as opposed to his data.

    Exposed as actions so a worker can use them and, more importantly, so HE
    can correct them — a memory only the system can write is one he cannot
    argue with, and an assistant confidently repeating something it guessed
    wrong is worse than one that forgot.

    Reading is silent (it is in SILENT_ACTIONS); remembering and forgetting
    notify, because a change to what Operator believes about him is exactly the
    class of thing he should hear about while it happens.
  */
  memory_remember: {
    description:
      "Store one durable fact about the OWNER — a preference, a constraint, how he works. Not his data (missions, gym, calendar have their own actions) and not a note about this conversation. Say `source: \"stated\"` only if he actually said it; anything you worked out is inferred, and defaults to inferred if you omit it.",
    params: 'text, source? ("stated" | "inferred")',
    handler: async ({ text, source }) => {
      const fact = await remember(text, { source });
      return { id: fact.id, text: fact.text, source: fact.source };
    },
  },
  memory_forget: {
    description:
      "Remove a stored fact about the owner, by its id or by its exact text. Use when he corrects something or says to forget it.",
    params: "idOrText",
    handler: async ({ idOrText, id, text }) => ({
      forgot: await forget(idOrText ?? id ?? text),
    }),
  },
  memory_list: {
    description:
      "Everything Operator currently believes about the owner, with how each was learned. Read this before asserting something personal back to him.",
    params: "(none)",
    handler: async () => ({ facts: await listFacts() }),
  },

  now: {
    description:
      "The current date and time on the machine Operator runs on, in the owner's local timezone. Use this for anything about \"now\", \"today\" or what the time is — do NOT read the calendar to work it out.",
    params: "(none)",
    handler: currentTime,
  },
  listen_once: {
    description:
      "Record from Operator's microphone and transcribe it locally. Includes the couple of seconds BEFORE the call, so a sentence started before asking is not clipped. Needs OPERATOR_LISTEN set.",
    params: "seconds? (default 6, max 30)",
    handler: listenOnce,
  },
  focus_operator: {
    description:
      "Summon Operator: bring its window to the front on the configured screen and make it fullscreen. Windows only. Deliberately does NOT touch what is playing — use media_play_pause for that.",
    params: "none",
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
  knowledge_search: {
    description:
      "Search the Knowledge Vault - the owner's own notes, commands and resources. Use this BEFORE working something out from scratch or reading source: if he has solved it before, the answer is here with a confidence level attached. Ranks by words rather than meaning, so try different vocabulary before concluding nothing is written down.",
    params:
      "query? (words to look for), topic? (exact topic tag), kind? (note|command|resource), limit? (default 8, max 25), includeArchived? (default false)",
    handler: knowledgeSearch,
  },
  knowledge_get: {
    description:
      "One note in full, with what it links to and what links to it. Use after knowledge_search when the excerpt is not enough.",
    params: "id",
    handler: knowledgeGet,
  },
  knowledge_topics: {
    description:
      "Every topic in the vault with how many notes carry it. Use to see what is covered.",
    params: "none",
    handler: knowledgeTopics,
  },
  knowledge_add: {
    description:
      "Write a new note into the vault. Use when something was worked out that would cost time to work out again. Confidence defaults to unverified - do not claim verified for something you have not actually checked.",
    params:
      "title, body?, kind? (note|command|resource), confidence? (unverified|works|verified), topics? (array of strings), missions? (array of mission ids), source? (a URL)",
    handler: knowledgeAdd,
  },
  knowledge_update: {
    description:
      "Edit an existing note. Every field is optional; only what is passed changes. Raising confidence to verified means it was actually re-checked.",
    params: "id, title?, body?, kind?, confidence?, topics?, source?",
    handler: knowledgeUpdate,
  },
  knowledge_link: {
    description:
      "Link one note to another. Calling it again with the same pair removes the link. Backlinks are derived, so only the forward direction is stored.",
    params: "id (the note that points), linkTo (the note it points at)",
    handler: knowledgeLink,
  },
  knowledge_archive: {
    description:
      "Archive a note, or restore one. There is deliberately no delete - a note is the least recoverable thing in the store.",
    params: "id, archived? (default true)",
    handler: knowledgeArchive,
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

/**
 * Which feature each action belongs to.
 *
 * Kept as one map rather than a `group` field on all 39 entries, so the whole
 * grouping is reviewable at a glance — the failure this guards against is an
 * action silently landing in the wrong bucket, and that is far easier to spot
 * in a list than spread across a thousand lines.
 *
 * Explicit, NOT derived from the name prefix, because the prefixes lie:
 * `missions_list` belongs with `mission_*`, `jobs_list` with `job_*`, and the
 * four device actions share no prefix at all. A `split("_")[0]` would cut two
 * features in half.
 *
 * An action missing from this map is treated as ungrouped and is ALWAYS sent.
 * Forgetting to add one then costs tokens, which is visible; the alternative
 * default would make it invisible to every worker, which is a bug nobody would
 * find.
 */
const ACTION_GROUPS = {
  now: "device",
  listen_once: "device",
  focus_operator: "device",
  media_play_pause: "device",

  gym_day: "gym",
  gym_sessions_list: "gym",
  gym_session_create: "gym",
  gym_session_update: "gym",
  gym_session_delete: "gym",
  gym_add_exercise: "gym",
  gym_update_exercise: "gym",
  gym_remove_exercise: "gym",
  gym_toggle_exercise: "gym",
  gym_skip_day: "gym",
  gym_unskip_day: "gym",

  missions_list: "mission",
  mission_create: "mission",
  mission_set_status: "mission",
  mission_set_progress: "mission",
  mission_set_dependency: "mission",
  mission_update: "mission",
  mission_archive: "mission",
  mission_add_milestone: "mission",
  mission_update_milestone: "mission",
  mission_delete: "mission",

  calendar_range: "calendar",
  calendar_create_event: "calendar",
  calendar_create_recurring: "calendar",
  calendar_create_range: "calendar",
  calendar_update_event: "calendar",
  calendar_delete_event: "calendar",
  calendar_skip_occurrence: "calendar",
  calendar_unskip_occurrence: "calendar",

  routine_day: "routine",
  routine_toggle_task: "routine",
  routine_add_task: "routine",
  routine_delete_task: "routine",

  jobs_list: "jobs",
  job_events: "jobs",

  /*
    Ungrouped on purpose, so memory reaches EVERY worker on every turn rather
    than only when a keyword happens to mention it. Remembering something is
    never the subject of the sentence — it happens while talking about the gym,
    or a mission, or nothing in particular.
  */
};

/**
 * Words that mean a request is about a feature.
 *
 * Rules, not a model, for the same reason `server/routing.mjs` uses them: this
 * runs on every turn, it must work with no network and no quota, and a
 * classifier that is occasionally unavailable would make the tool list
 * occasionally wrong — which is a much worse failure than sending a few
 * extra declarations.
 *
 * Deliberately generous. A false positive costs a few hundred characters; a
 * false negative means a worker cannot see the action it needs, which reads to
 * the owner as Operator refusing to do something it can plainly do.
 */
const GROUP_WORDS = {
  gym: /\b(gym|workout|work ?out|train(ing|ed)?|exercise|lift(ing|ed)?|rep|reps|set|sets|push|pull|leg|chest|back|shoulder|arm|bicep|tricep|squat|deadlift|bench|cardio|rest day|muscle|session)\b/i,
  mission:
    /\b(mission|missions|goal|goals|objective|milestone|progress|blocked|depend(s|ency|encies)?|roadmap|project)\b/i,
  calendar:
    /\b(calendar|event|events|schedule|scheduled|appointment|meeting|shift|shifts|book(ed|ing)?|diary|recurring|occurrence|next week|this week|tomorrow|today)\b/i,
  routine: /\b(routine|daily|habit|habits|morning|evening|night|checklist|step|steps|tick|ticked)\b/i,
  jobs: /\b(job|jobs|turn|turns|conversation|thread|tab|tabs|event log|transcript)\b/i,
  /*
    Wider than the others, deliberately.

    Every other group answers "is this request ABOUT the gym / missions / the
    calendar". This one answers "might he already have written this down",
    which is worth asking about far more sentences than it strictly matches.
    The cost of offering the vault actions when they were not needed is a few
    hundred tokens of declarations; the cost of not offering them is a worker
    rediscovering something at Claude's rate that was already written down.
  */
  knowledge:
    /\b(note|notes|vault|knowledge|wiki|document(ed|ation)?|how do i|how to|remember|reference|command|snippet|look(ed)? up|worked out|figured out|topics?|tags?)\b/i,
  device: /\b(time|clock|date|what day|listen|hear|mic|microphone|speak|screen|focus|fullscreen|summon|music|play|pause|volume)\b/i,
};

/**
 * The feature groups a request plausibly touches.
 *
 * Returns `null` when nothing matches, meaning "no opinion" — the caller then
 * sends everything. That is the same shape as `routing.mjs`'s `fastPath()`
 * returning null, and for the same reason: silence is an honest answer and the
 * safe fallback is the expensive one, not the wrong one.
 */
export function groupsFor(prompt) {
  const text = String(prompt ?? "");
  if (!text.trim()) return null;

  const hits = new Set();
  for (const [group, re] of Object.entries(GROUP_WORDS)) {
    if (re.test(text)) hits.add(group);
  }
  if (!hits.size) return null;

  /*
    `device` rides along with everything.

    It holds `now`, and almost any question about a date resolves against
    today — "did I go to the gym this week" is a gym question that cannot be
    answered without knowing what day it is. Four small actions, 1,751
    characters, and leaving them out breaks more than it saves.
  */
  hits.add("device");
  return [...hits];
}

/**
 * For the tool layer to advertise, and for a human reading /api/actions.
 *
 * `groups` narrows the catalogue to the named features. Omit it — as
 * `/api/actions` and the CLI's `list` both do — and you get everything, which
 * is what makes the full set permanently discoverable however the filter
 * behaves.
 */
export function listActions({ groups } = {}) {
  const wanted = groups ? new Set(groups) : null;
  return Object.entries(ACTIONS)
    .filter(([name]) => {
      if (!wanted) return true;
      const group = ACTION_GROUPS[name];
      // Ungrouped actions are always sent — see ACTION_GROUPS above.
      return !group || wanted.has(group);
    })
    .map(([name, { description, params }]) => ({
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
/*
  Actions that change nothing the owner would want telling about.

  Everything NOT in here notifies when it succeeds, and the distinction is the
  point: the capability layer is how a WORKER changes his data. He does not
  need telling about edits he made himself through the UI — those go through
  `PUT /api/state` and never reach here — but he does need telling when
  something moved while he was not looking. That is his own framing: "i'll have
  you do it... and then of course Operator itself".

  Reads are silent for the obvious reason. The device actions are silent
  because "Operator brought its own window forward" is not news, and the clap
  gesture fires `focus_operator` every time — notifying on it would make the
  phone buzz at every clap.
*/
const SILENT_ACTIONS = new Set([
  "now",
  "listen_once",
  "focus_operator",
  "media_play_pause",
  "gym_day",
  "gym_sessions_list",
  "missions_list",
  "calendar_range",
  "routine_day",
  "jobs_list",
  "job_events",
  // Reading what Operator believes about him is not a change to it.
  "memory_list",
]);

/**
 * What to put on a lock screen, as `{title, message}`.
 *
 * The title says WHAT KIND of change and the message says WHICH THING and how
 * much it moved. The first version had them the other way round — title
 * "Operator changed something", message "Mission set progress" — which was
 * ambiguous twice over: it never named the mission, and one of his missions is
 * itself called "Operator", so the notification appeared to be about the app.
 *
 * Names, never ids. An earlier version fell back to `params.id` and produced
 * "3d3781cb-6ecc-4737-8d1a-870713af97ef". A UUID is not a notification.
 *
 * Before-and-after where there is one. "progress 56% -> 62%" tells you whether
 * to care; "progress 62%" makes you go and look.
 */
function summarise(name, params, result, before) {
  const verb = name.replace(/^(gym|missions|mission|calendar|routine)_/, "").replace(/_/g, " ");

  if (name.startsWith("mission")) {
    const label = before?.name ?? params?.name ?? "a mission";
    if (result?.progress !== undefined) {
      const was = before?.progress;
      const move = was !== undefined && was !== result.progress ? `${was}% → ${result.progress}%` : `${result.progress}%`;
      return { title: "Mission progress", message: `${label} — ${move}` };
    }
    if (result?.status) {
      const now = String(result.status).replace(/_/g, " ");
      const was = before?.status ? String(before.status).replace(/_/g, " ") : null;
      return { title: "Mission status", message: `${label} — ${was && was !== now ? `${was} → ${now}` : now}` };
    }
    if (name === "mission_create") return { title: "Mission created", message: params?.name ?? label };
    if (name === "mission_archive") return { title: "Mission archived", message: label };
    if (name === "mission_delete") return { title: "Mission deleted", message: label };
    return { title: `Mission ${verb}`, message: label };
  }

  if (name.startsWith("gym_")) {
    const when = params?.date ? ` on ${params.date}` : " today";
    const what = params?.name ?? params?.exercise ?? "";
    return { title: `Gym — ${verb}`, message: `${what ? `${what}` : "Session"}${when}` };
  }

  if (name.startsWith("calendar_")) {
    const what = params?.title ?? params?.name ?? "an event";
    const when = params?.date ? ` — ${params.date}` : "";
    return { title: `Calendar — ${verb}`, message: `${what}${when}` };
  }

  if (name.startsWith("routine_")) {
    const what = params?.label ?? params?.name ?? "a step";
    const when = params?.date ? ` on ${params.date}` : " today";
    return { title: `Routine — ${verb}`, message: `${what}${when}` };
  }

  return { title: "Operator", message: verb };
}

/** The record an action is about to change, so the notification can say "from". */
async function snapshot(name, params) {
  if (!name.startsWith("mission") || !params?.id) return null;
  const missions = await readState("missions.records");
  return Array.isArray(missions) ? (missions.find((m) => m?.id === params.id) ?? null) : null;
}

export async function runAction(name, params = {}) {
  const action = ACTIONS[name];
  if (!action) {
    throw new ActionError(`no such action "${name}". Known actions: ${Object.keys(ACTIONS).join(", ")}`);
  }
  /*
    Read the "before" BEFORE running the handler, or there is nothing to
    compare against — the whole point of "56% -> 62%" is that it happens in
    that order. Only for mission actions, and only when the notifier is even
    configured, so an unconfigured Operator does not pay for a store read on
    every single write.
  */
  const before = notifyConfigured && !SILENT_ACTIONS.has(name) ? await snapshot(name, params) : null;

  const result = await action.handler(params ?? {});

  /*
    Fire-and-forget, and only after the change actually succeeded — a
    notification about a write that threw would be a lie. `void` because
    notify() owns its own timeout and swallows its own failures, and an action
    must not get slower because a notification server is down.
  */
  if (!SILENT_ACTIONS.has(name)) {
    /*
      Wrapped, because building the sentence reads the store and a failure
      there must not fail the action that already succeeded. An action that
      throws AFTER doing its work is the worst possible outcome: the change
      landed and the caller is told it did not.
    */
    try {
      const { title, message } = summarise(name, params, result, before);
      void notify(title, message, { priority: "high", tags: ["pencil2"] });
    } catch (err) {
      /*
        Building the sentence must never fail the action that already
        succeeded. A throw AFTER the work landed is the worst outcome: the
        change happened and the caller is told it did not.
      */
      console.warn(`[operator] notify skipped: ${err?.message ?? err}`);
    }
  }

  return result;
}
