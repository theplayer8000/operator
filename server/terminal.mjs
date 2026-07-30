// Run a command on this machine, from Operator.
//
// This is the execution half of the Embedded Claude Workspace. It exists so the
// owner can drive Claude Code from his phone — he is travelling and will not be
// at the keyboard, and ADR 0009 approved the terminal only once authentication
// existed. It does now (ADR 0010), so ADR 0011 lifts the local-only restriction
// for authorised devices.
//
// ## Be honest about what the security boundary is
//
// The boundary is **authentication plus device authorisation**, not command
// filtering. Allowing `claude` is allowing arbitrary code execution, because
// Claude Code runs commands — that is the entire point of the feature. Any
// "allowed commands" list here is a seatbelt against a fat-fingered paste, not
// a wall against someone holding an authorised device. Do not let a future
// session mistake the allowlist for containment and relax the auth because
// "commands are restricted anyway".
//
// What this file actually guarantees:
//
//   - Disarmed unless armed. Off on every start unless OPERATOR_TERMINAL=1, and
//     the armed state is in memory, so a restart disarms it again.
//   - Only devices named in OPERATOR_TERMINAL_DEVICES may run anything, or arm
//     it. That list comes from the environment and is not settable from the app,
//     so a device can never grant itself execution.
//   - **No shell.** argv array, `shell: false`. `&&`, `|`, `;`, backticks and
//     redirection are inert text, so one input field cannot chain commands and
//     the audit line is exactly what ran.
//   - Only allowlisted executables, resolved to real binaries up front.
//   - Every run is audited: device, user, argv, exit code, duration.
//   - Timeout and output cap, so a runaway can't fill memory or run forever.
//
// ## Why no PTY
//
// A real PTY means `node-pty`, a native module needing build tools — against the
// dependency rule in CLAUDE.md, and `server/` has no dependencies at all. So
// this is `spawn` without a TTY: fine for anything that runs and prints, wrong
// for interactive TUIs (vim, or Claude Code's interactive mode). That suits the
// actual use case — `claude -p "..."` prints and exits, and a full-screen TUI on
// a phone would be miserable anyway. A PTY is a separate decision if it is ever
// genuinely needed.
//
// ## Windows: the shim problem, and why `shell: true` was rejected
//
// npm-installed CLIs on Windows are `.cmd` shims. Node refuses to spawn
// `.cmd`/`.bat` without a shell (the CVE-2024-27980 mitigation), so:
//
//     spawn("claude",     …, {shell:false})  → ENOENT   (extensionless shim)
//     spawn("claude.cmd", …, {shell:false})  → EINVAL   (Node blocks it)
//
// The lazy fix is `shell: true`, which would hand back every metacharacter and
// make the audit log a lie. Instead `resolveExecutable` reads the shim and
// extracts the real binary it calls — for Claude Code that is a genuine
// `claude.exe`, verified spawning cleanly with `shell: false`.

import { spawn, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether the terminal is currently armed.
 *
 * Runtime state, not a constant, and **in memory only** — a restart returns it
 * to the environment default, which is off. `OPERATOR_TERMINAL=1` starts it
 * armed; otherwise an authorised device turns it on from the app.
 *
 * It became runtime state because the original design was self-defeating: the
 * feature exists for when the owner is *away* from the machine, but enabling it
 * required setting an environment variable *at* the machine. Requiring him to be
 * at the keyboard to switch on the thing built for not being at the keyboard is
 * not a security control, it is a bug.
 *
 * The trade this makes is deliberate and worth stating: the real gate is now
 * `OPERATOR_TERMINAL_DEVICES` alone. That list is **not** settable from the app —
 * only from the environment — so a device cannot grant itself execution. What a
 * listed device can do is arm and disarm. ADR 0011 already says the boundary is
 * authentication plus the device list rather than the command allowlist; this
 * makes that literally true instead of nearly true.
 */
let enabled = process.env.OPERATOR_TERMINAL === "1";

export function isEnabled() {
  return enabled;
}

/** Arm or disarm. Caller must already have passed `deviceMayManage`. */
export function setEnabled(next, identity) {
  enabled = next === true;
  console.log(
    `[operator] terminal ${enabled ? "ARMED" : "disarmed"} by ${identity?.device ?? "unknown"}${
      identity?.user ? ` (${identity.user})` : ""
    }`
  );
  return enabled;
}

/**
 * Tailscale device names allowed to run commands, comma separated. Empty means
 * nobody — enabling the feature is not the same as authorising a device, and
 * defaulting to "any authenticated device" would make a lost phone a shell.
 */
const ALLOWED_DEVICES = new Set(
  (process.env.OPERATOR_TERMINAL_DEVICES ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
);

/** Executables that may be launched. Names only — never paths from the client. */
const ALLOWED = new Set(
  (process.env.OPERATOR_TERMINAL_ALLOW ?? "claude,git,npm,npx,node,tsc,rg,ls,dir,cat,pwd")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
);

const TIMEOUT_MS = Number(process.env.OPERATOR_TERMINAL_TIMEOUT_MS ?? 15 * 60_000) || 15 * 60_000;
/** Per-run output ceiling. A build log is large; a runaway loop is unbounded. */
const MAX_OUTPUT_BYTES = Number(process.env.OPERATOR_TERMINAL_MAX_BYTES ?? 2_000_000) || 2_000_000;
/** How many finished runs to keep for the history panel. */
const MAX_RUNS = 40;

/** id → run record. In memory only: a live console, not an archive. */
const runs = new Map();
let nextId = 1;

// --- command parsing ------------------------------------------------------

/**
 * Split a command line into argv **without a shell**.
 *
 * Honours single and double quotes so a prompt with spaces survives
 * (`claude -p "explain this file"`), and nothing else. Metacharacters are
 * ordinary characters here — there is no shell to interpret them, which is the
 * property the whole design rests on.
 */
export function tokenise(line) {
  const argv = [];
  let current = "";
  let quote = null;
  let started = false;

  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current !== "") argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error("unbalanced quote in command");
  if (started || current !== "") argv.push(current);
  return argv;
}

// --- executable resolution ------------------------------------------------

const resolvedCache = new Map();

/** Pull the real binary out of an npm-style `.cmd` shim. See the header. */
function targetFromShim(shimPath) {
  try {
    const text = readFileSync(shimPath, "utf8");
    const match = text.match(/"([^"]*\.exe)"/i);
    if (!match) return null;
    const candidate = match[1].replace(/%dp0%\\?/i, dirname(shimPath) + "\\");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Turn an allowlisted *name* into an absolute path to a real executable.
 *
 * Never accepts a path from the client — the name is looked up here, so a
 * request cannot point at an arbitrary binary. An explicit override is available
 * per command (`OPERATOR_TERMINAL_BIN_CLAUDE=...`) for unusual installs.
 */
async function resolveExecutable(name) {
  const key = name.toLowerCase();
  if (resolvedCache.has(key)) return resolvedCache.get(key);

  const override = process.env[`OPERATOR_TERMINAL_BIN_${key.toUpperCase()}`];
  if (override && existsSync(override)) {
    resolvedCache.set(key, override);
    return override;
  }

  const finder = process.platform === "win32" ? "where" : "which";
  let candidates = [];
  try {
    const { stdout } = await execFileAsync(finder, [name], {
      timeout: 5_000,
      windowsHide: true,
    });
    candidates = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    resolvedCache.set(key, null);
    return null;
  }

  // A real binary is always preferable to a shim.
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) {
    resolvedCache.set(key, exe);
    return exe;
  }

  // Otherwise dig the real target out of the .cmd shim — Node will not spawn
  // the shim itself without a shell, and a shell is not on the table.
  const cmd = candidates.find((c) => /\.cmd$/i.test(c));
  if (cmd) {
    const target = targetFromShim(cmd);
    if (target) {
      resolvedCache.set(key, target);
      return target;
    }
  }

  // On POSIX an extensionless entry is a normal executable.
  if (process.platform !== "win32" && candidates.length > 0) {
    resolvedCache.set(key, candidates[0]);
    return candidates[0];
  }

  resolvedCache.set(key, null);
  return null;
}

// --- running --------------------------------------------------------------

function prune() {
  if (runs.size <= MAX_RUNS) return;
  const finished = [...runs.values()]
    .filter((r) => r.endedAt !== null)
    .sort((a, b) => a.endedAt - b.endedAt);
  for (const r of finished.slice(0, runs.size - MAX_RUNS)) runs.delete(r.id);
}

function publish(run, chunk) {
  if (run.bytes >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - run.bytes;
  let text = chunk;
  if (Buffer.byteLength(chunk, "utf8") > remaining) {
    text = chunk.slice(0, remaining) + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]\n`;
    run.truncated = true;
  }
  run.bytes += Buffer.byteLength(text, "utf8");
  run.text += text;
  for (const fn of run.subscribers) {
    try {
      fn(text);
    } catch {
      /* a dead subscriber must not kill the run */
    }
  }
}

/**
 * Whether a device may run commands. Separate from *authentication*: being a
 * known tailnet device gets you the app, not a shell.
 */
export function deviceMayManage(identity) {
  // `local` is the machine itself; it is already able to open a real terminal,
  // so gating it would protect nothing.
  if (identity?.method === "local") return { ok: true };
  const device = String(identity?.device ?? "").toLowerCase();
  if (device && ALLOWED_DEVICES.has(device)) return { ok: true };
  return {
    ok: false,
    reason: device
      ? `device "${identity.device}" is not in OPERATOR_TERMINAL_DEVICES`
      : "no device identity — the terminal needs a named tailnet device",
  };
}

/**
 * May this device *run* something? Being listed is necessary but not sufficient
 * — the terminal also has to be armed. Kept separate from `deviceMayManage` so
 * arming is possible while disarmed, which is the whole point of the toggle.
 */
export function deviceAuthorised(identity) {
  const listed = deviceMayManage(identity);
  if (!listed.ok) return listed;
  if (!enabled) {
    return { ok: false, reason: "the terminal is disarmed — switch it on first" };
  }
  return { ok: true };
}

/** Start a command. Returns the run record, or throws with a usable message. */
export async function startRun(line, identity) {
  const argv = tokenise(line);
  if (argv.length === 0) throw new Error("nothing to run");

  const name = basename(argv[0]).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (name !== argv[0].toLowerCase()) {
    // A bare name is looked up here; a path would let the client choose the
    // binary and sidestep the allowlist entirely.
    throw new Error(`run commands by name, not by path — got "${argv[0]}"`);
  }
  if (!ALLOWED.has(name)) {
    throw new Error(
      `"${name}" is not allowed. Permitted: ${[...ALLOWED].sort().join(", ")} (set OPERATOR_TERMINAL_ALLOW to change)`
    );
  }

  const executable = await resolveExecutable(name);
  if (!executable) {
    throw new Error(
      `couldn't find an executable for "${name}" on this machine — set OPERATOR_TERMINAL_BIN_${name.toUpperCase()}`
    );
  }

  const id = String(nextId++);
  const run = {
    id,
    argv,
    executable,
    cwd: ROOT,
    device: identity?.device ?? "unknown",
    user: identity?.user ?? null,
    method: identity?.method ?? "unknown",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    // One accumulating string rather than chunks: the poll endpoint serves
    // `text.slice(from)`, and an offset into an array of chunks would be a
    // second thing to keep consistent for no gain.
    text: "",
    bytes: 0,
    truncated: false,
    subscribers: new Set(),
    proc: null,
  };
  runs.set(id, run);
  prune();

  console.log(
    `[operator] terminal run ${id} by ${run.device}${run.user ? ` (${run.user})` : ""}: ${argv.join(" ")}`
  );

  const proc = spawn(executable, argv.slice(1), {
    cwd: ROOT,
    shell: false, // load-bearing — see the header
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  run.proc = proc;

  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (d) => publish(run, d));
  proc.stderr?.on("data", (d) => publish(run, d));

  const timer = setTimeout(() => {
    if (run.endedAt === null) {
      publish(run, `\n[timed out after ${Math.round(TIMEOUT_MS / 1000)}s — killed]\n`);
      proc.kill();
    }
  }, TIMEOUT_MS);
  timer.unref?.();

  const finish = (code, signal) => {
    if (run.endedAt !== null) return;
    clearTimeout(timer);
    run.endedAt = Date.now();
    run.exitCode = code;
    run.signal = signal ?? null;
    run.proc = null;
    console.log(
      `[operator] terminal run ${id} finished: exit=${code}${signal ? ` signal=${signal}` : ""} in ${run.endedAt - run.startedAt}ms`
    );
    for (const fn of run.subscribers) {
      try {
        fn(null); // null = end of stream
      } catch {
        /* ignore */
      }
    }
    run.subscribers.clear();
  };

  proc.on("error", (err) => {
    publish(run, `\n[failed to start: ${err.message}]\n`);
    finish(null, null);
  });
  proc.on("close", (code, signal) => finish(code, signal));

  return run;
}

export function getRun(id) {
  return runs.get(String(id)) ?? null;
}

export function stopRun(id) {
  const run = runs.get(String(id));
  if (!run) return { ok: false, reason: "no such run" };
  if (!run.proc) return { ok: false, reason: "already finished" };
  publish(run, "\n[stopped]\n");
  run.proc.kill();
  return { ok: true };
}

/** Subscribe to a run's output. Returns an unsubscribe function. */
export function subscribe(run, fn) {
  run.subscribers.add(fn);
  return () => run.subscribers.delete(fn);
}

/** Serialisable view — no process handles, no subscriber set. */
export function describeRun(run, { includeOutput = false } = {}) {
  return {
    id: run.id,
    command: run.argv.join(" "),
    device: run.device,
    user: run.user,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    running: run.proc !== null,
    truncated: run.truncated,
    ...(includeOutput ? { output: run.text } : {}),
  };
}

/**
 * Output from a character offset, for polling clients.
 *
 * Polling exists because streaming did not survive contact with the owner's
 * phone: `git status --short` ran from his iPhone and exited 0, but no text
 * ever appeared — the run was fine, the transport was not. A terminal whose
 * output silently never arrives is worse than no terminal, so the client polls
 * this instead of reading a stream. The stream endpoint stays for `curl`.
 */
export function readOutput(run, from = 0) {
  const start = Number.isFinite(from) && from > 0 ? Math.min(from, run.text.length) : 0;
  return {
    output: run.text.slice(start),
    offset: run.text.length,
    running: run.proc !== null,
    exitCode: run.exitCode,
    truncated: run.truncated,
  };
}

export function listRuns() {
  return {
    enabled,
    cwd: ROOT,
    allowed: [...ALLOWED].sort(),
    authorisedDevices: [...ALLOWED_DEVICES].sort(),
    timeoutMs: TIMEOUT_MS,
    runs: [...runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => describeRun(r)),
  };
}
