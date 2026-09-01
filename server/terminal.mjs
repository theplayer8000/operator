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
//   - Unrestricted by default. `OPERATOR_TERMINAL_ALLOW` can narrow it, but a
//     command list was never the boundary — see the note on ALLOWED below.
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

/*
  A pending auto-disarm, when the terminal was armed by something that should
  not leave it armed forever.
*/
let disarmTimer = null;

/**
 * Arm or disarm.
 *
 * `forMs` disarms again automatically after that long. It exists for the clap
 * gesture and the reasoning is specific: arming is arbitrary code execution,
 * and the clap detector demonstrably false-fires — it logged fifteen claps in
 * an evening that nobody made. Permanent arming from an accidental sound means
 * the terminal can sit armed for days unnoticed, and "disarmed by default" is
 * exactly what stops a stray job or a lost phone running commands.
 *
 * A person at the desk arming it from the Dev page passes no window, because
 * that is a deliberate act by a named device and revoking it behind his back
 * would be its own kind of wrong.
 */
export function setEnabled(next, identity, forMs = 0, busy = null) {
  enabled = next === true;

  // Any change cancels a pending auto-disarm. Disarming by hand and then being
  // disarmed again later is harmless; re-arming by hand and THEN being disarmed
  // by a timer he has forgotten about is not.
  if (disarmTimer) {
    clearTimeout(disarmTimer);
    disarmTimer = null;
  }

  console.log(
    `[operator] terminal ${enabled ? "ARMED" : "disarmed"} by ${identity?.device ?? "unknown"}${
      identity?.user ? ` (${identity.user})` : ""
    }${enabled && forMs ? ` — auto-disarms in ${Math.round(forMs / 60000)}m` : ""}`
  );

  if (enabled && forMs > 0) {
    /*
      The window must never strand work already in flight.

      Every route under /api/jobs is gated on the terminal being armed —
      including ANSWERING a permission question. So a naive timer produces
      exactly the failure the notifications exist to prevent: a long turn
      starts, twenty minutes pass, the terminal disarms, the turn then suspends
      on a permission question, his phone buzzes, he taps it, and he gets a 403
      while the turn quietly dies at its thirty-minute timeout.

      So the timer ASKS before disarming. If something is running it waits and
      asks again rather than cutting the session off mid-thought. The clock
      still runs — this defers the disarm, it does not cancel it — so an idle
      machine still closes the window on its own.
    */
    const check = () => {
      if (typeof busy === "function") {
        let working = false;
        try {
          working = busy() === true;
        } catch {
          /* A broken predicate must not pin the terminal open forever. */
        }
        if (working) {
          disarmTimer = setTimeout(check, 60_000);
          disarmTimer.unref?.();
          return;
        }
      }
      disarmTimer = null;
      enabled = false;
      console.log("[operator] terminal disarmed automatically — the window expired");
    };
    disarmTimer = setTimeout(check, forMs);
    // Do not hold the process open for this alone.
    disarmTimer.unref?.();
  }

  return enabled;
}

/** Whether the current armed state will expire on its own. */
export function armedTemporarily() {
  return disarmTimer !== null;
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

/**
 * Optional restriction on what may be launched. **Unset means unrestricted.**
 *
 * It used to default to a fixed list, and that was friction pretending to be
 * security. ADR 0011 already said the boundary is authentication plus the device
 * list, because allowing `claude` allows arbitrary execution anyway — Claude Code
 * runs commands. A list that stops `curl` while permitting `claude` and `node`
 * protects nothing and blocks real work; the ADR named exactly this as the
 * trigger to drop it, so it is dropped rather than quietly kept.
 *
 * Set `OPERATOR_TERMINAL_ALLOW` to restrict again if a future setup wants a
 * narrow terminal — a shared machine, or a device you trust less. It is an
 * opt-in seatbelt now, not a load-bearing wall, and nothing should be relaxed
 * elsewhere on the grounds that it exists.
 */
const ALLOWED = new Set(
  (process.env.OPERATOR_TERMINAL_ALLOW ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
);
const RESTRICTED = ALLOWED.size > 0;

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

/**
 * Work out what a Windows `.cmd` shim actually launches.
 *
 * Two shapes exist and both matter:
 *
 *   claude.cmd → "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
 *   npm.cmd    → SET "NODE_EXE=%~dp0\node.exe"
 *                SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
 *
 * The first is a real binary. The second is a **script plus an interpreter** —
 * missing that is why `npm run build` failed with "couldn't find an executable
 * for npm" while npm was plainly installed and on PATH.
 *
 * Returns `{ exe, prefixArgs }`. For a script shim the interpreter is
 * `process.execPath` — the exact node already running this server, rather than
 * whichever one PATH happens to resolve to.
 */
function targetFromShim(shimPath) {
  try {
    const text = readFileSync(shimPath, "utf8");
    const dir = dirname(shimPath);

    const candidates = [...text.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      // npm writes paths as SET "NAME=path", so the quoted string is not the
      // path on its own — drop anything up to the first `=`.
      .map((q) => {
        const eq = q.indexOf("=");
        return eq === -1 ? q : q.slice(eq + 1);
      })
      .map((q) =>
        q.replace(/%~dp0\\?|%dp0%\\?/gi, dir + "\\").replace(/\\{2,}/g, "\\")
      )
      .filter((q) => /\.(exe|js)$/i.test(q));

    const exes = candidates.filter((c) => /\.exe$/i.test(c) && existsSync(c));
    const jss = candidates.filter((c) => /\.js$/i.test(c) && existsSync(c));

    /*
      A script wins over an exe when both are present, and this ordering is the
      whole fix.

      npm.cmd names *both* `node.exe` and `npm-cli.js`. Taking the exe first ran
      `node run build` — node treating "run" as a module path — and failed with
      `Cannot find module 'D:\Projects\Operator\run'`. In a script shim the exe
      is the *interpreter*, not the target.

      npm also names `npm-prefix.js` before `npm-cli.js`, so "first .js" is
      wrong too; prefer the CLI entry point by name.
    */
    if (jss.length > 0) {
      const js = jss.find((c) => /cli\.js$/i.test(c)) ?? jss[0];
      return { exe: exes[0] ?? process.execPath, prefixArgs: [js] };
    }

    if (exes.length > 0) return { exe: exes[0], prefixArgs: [] };

    return null;
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
export async function resolveExecutable(name) {
  const key = name.toLowerCase();
  if (resolvedCache.has(key)) return resolvedCache.get(key);

  const override = process.env[`OPERATOR_TERMINAL_BIN_${key.toUpperCase()}`];
  if (override && existsSync(override)) {
    const resolved = { exe: override, prefixArgs: [] };
    resolvedCache.set(key, resolved);
    return resolved;
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
    /* not on PATH — the extra directories below are the remaining chance */
  }

  /*
    Git for Windows ships the POSIX tools, but only puts some of them on PATH.

    `git` and `curl` live in mingw64\bin, which the installer adds; `ls`, `dir`,
    `grep`, `wc` and the rest live in usr\bin, which it does not. So whether a
    command resolves depended on which shell started the server — from Git Bash
    everything worked, from cmd.exe half of it didn't, and the failure said
    "couldn't find an executable" as though the tool weren't installed. It is
    installed. It was never findable from here.

    This is not a shell and does not become one: `shell: false` still holds, and
    these are just more directories to look in.
  */
  if (process.platform === "win32" && candidates.length === 0) {
    const extra = [
      process.env.OPERATOR_TERMINAL_PATH,
      "C:\\Program Files\\Git\\usr\\bin",
      "C:\\Program Files\\Git\\mingw64\\bin",
      "C:\\Program Files (x86)\\Git\\usr\\bin",
    ].filter(Boolean);
    for (const dir of extra) {
      for (const ext of [".exe", ".cmd", ".bat", ""]) {
        const path = join(dir, `${name}${ext}`);
        if (existsSync(path)) {
          candidates.push(path);
          break;
        }
      }
      if (candidates.length) break;
    }
  }

  /*
    On Windows, `bash` on PATH is `C:\Windows\System32\bash.exe` — the WSL
    launcher, not a shell. With no distribution installed it answers any command
    with "Linux has no installed distributions", which is a confusing reply to
    `bash -c "git log | head"` when Git's own bash is sitting right there.

    So a System32 WSL stub is demoted below anything else found. It stays as a
    last resort rather than being removed, because someone with a real WSL setup
    may well mean it.
  */
  if (process.platform === "win32" && candidates.length > 0) {
    const isWslStub = (p) => /\\(System32|WindowsApps)\\(bash|wsl)\.exe$/i.test(p);
    if (candidates.every(isWslStub)) {
      for (const dir of ["C:\\Program Files\\Git\\bin", "C:\\Program Files\\Git\\usr\\bin"]) {
        const path = join(dir, `${name}.exe`);
        if (existsSync(path)) {
          candidates.unshift(path);
          break;
        }
      }
    } else {
      candidates = [...candidates.filter((c) => !isWslStub(c)), ...candidates.filter(isWslStub)];
    }
  }

  if (candidates.length === 0) {
    resolvedCache.set(key, null);
    return null;
  }

  // A real binary is always preferable to a shim.
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) {
    const resolved = { exe, prefixArgs: [] };
    resolvedCache.set(key, resolved);
    return resolved;
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
    const resolved = { exe: candidates[0], prefixArgs: [] };
    resolvedCache.set(key, resolved);
    return resolved;
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
 * May this caller use the capability layer — the named, validated actions in
 * `actions.mjs` that change Operator's OWN data?
 *
 * **Yes, for anyone who got past authentication.** No device list, no arming.
 * This is the middle tier of three, added 2026-08-31 (ADR 0016) because the
 * previous two-tier model put this in the wrong one:
 *
 *   1. identity   — `auth.mjs`, in front of every `/api/` route
 *   2. capability — here: fixed names, fixed parameter shapes, Operator's data
 *   3. execution  — `deviceAuthorised` below: the terminal, and jobs
 *
 * The argument is not convenience, it is that the old arrangement was
 * backwards. `PUT /api/state/<key>` is generic, unvalidated, and can overwrite
 * or delete any slice of the store — and it is gated on identity alone,
 * because it is what the app itself writes through. A capability action can
 * only do what the owner could already do through the UI, and it was gated
 * behind `OPERATOR_TERMINAL_DEVICES` *and* an armed terminal. The safe path
 * was locked and the dangerous one was open, so a worker asked to tick off a
 * gym session had to be granted execution rights to do it.
 *
 * What this deliberately does NOT extend to, and must not:
 *
 * - **Jobs.** A job has tool access, so starting one is arbitrary execution
 *   wearing a friendlier name. It stays on tier 3.
 * - **The terminal, on loopback, always armed.** Tempting — someone at the
 *   desk already has PowerShell, so the gate looks pointless there. It is not:
 *   Claude Code jobs run ON this machine, so an always-armed loopback would
 *   let a running agent POST to `/api/terminal/run` and walk straight out of
 *   the permission envelope that denies it `git push` and deleting files. That
 *   envelope is the whole of ADR 0012.
 */
export function deviceMayUseCapabilities(identity) {
  if (identity) return { ok: true };
  // Unreachable in practice — auth.mjs rejects an unidentified caller before
  // the router sees it. Explicit anyway, so this never becomes the one place
  // that assumed someone else had checked.
  return { ok: false, reason: "no identity" };
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
  const isPath = name !== argv[0].toLowerCase();

  if (RESTRICTED) {
    // While a restriction is in force, a path would sidestep it — the name is
    // the thing being checked, so the name has to be what gets resolved.
    if (isPath) throw new Error(`run commands by name, not by path — got "${argv[0]}"`);
    if (!ALLOWED.has(name)) {
      throw new Error(
        `"${name}" is not in OPERATOR_TERMINAL_ALLOW. Permitted: ${[...ALLOWED].sort().join(", ")}`
      );
    }
  }

  // An explicit path is taken as given when unrestricted — running a script that
  // isn't on PATH is a normal thing to want, and there is no list left to evade.
  const resolved =
    !RESTRICTED && isPath && existsSync(argv[0])
      ? { exe: argv[0], prefixArgs: [] }
      : await resolveExecutable(name);
  if (!resolved) {
    // A leading dash means they typed a flag where the command goes — usually a
    // stray character, or a line copied from prose. Telling them to set
    // OPERATOR_TERMINAL_BIN_--LS is technically what the generic branch says and
    // is of no use to anyone.
    if (name.startsWith("-")) {
      throw new Error(
        `"${name}" is a flag, not a command — the first word has to be the program to run`
      );
    }
    /*
      A shell builtin is not a missing program, and must not be reported as
      one. `del`, `copy`, `dir` and friends live inside cmd.exe; there is no
      del.exe anywhere on the system, so the generic advice — "set
      OPERATOR_TERMINAL_BIN_DEL if it lives somewhere unusual" — sends someone
      looking for a file that has never existed. Observed 2026-08-22 with
      exactly that: `del <path>` answered with advice that could not work.

      There is deliberately no shell here (ADR 0011, argv only), so the honest
      answer is the equivalent that does work rather than a suggestion to
      relax that.
    */
    const BUILTIN = {
      del: 'cmd /c del "<path>"',
      erase: 'cmd /c del "<path>"',
      copy: 'cmd /c copy "<from>" "<to>"',
      move: 'cmd /c move "<from>" "<to>"',
      ren: 'cmd /c ren "<from>" "<to>"',
      rename: 'cmd /c ren "<from>" "<to>"',
      dir: "cmd /c dir",
      cls: "cmd /c cls",
      type: 'cmd /c type "<path>"',
      cd: "(there is no working directory to change — every run starts in the repo root)",
      set: "cmd /c set",
    };
    if (BUILTIN[name]) {
      throw new Error(
        `"${name}" is a cmd.exe builtin, not a program — there is no ${name}.exe to point at. ` +
          `This terminal runs argv only, with no shell (ADR 0011). Use: ${BUILTIN[name]}`
      );
    }
    throw new Error(
      `couldn't find an executable for "${name}" on this machine — set OPERATOR_TERMINAL_BIN_${name.toUpperCase()} if it lives somewhere unusual`
    );
  }

  const id = String(nextId++);
  const run = {
    id,
    argv,
    executable: resolved.exe,
    // A script shim (npm, npx) launches an interpreter plus a script; the
    // caller's own arguments come after those.
    prefixArgs: resolved.prefixArgs,
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

  const proc = spawn(resolved.exe, [...resolved.prefixArgs, ...argv.slice(1)], {
    cwd: ROOT,
    shell: false, // load-bearing — see the header
    windowsHide: true,
    /*
      stdin is closed, not piped.

      With the default (`pipe`) the child gets a pipe nobody ever writes to or
      closes, so anything that reads stdin blocks until the 15-minute timeout.
      It showed up as `claude -p` printing "no stdin data received in 3s" before
      doing anything, and a bare `cat` would have hung outright.

      There is no interactive input here — this is not a PTY — so the honest
      thing is EOF immediately.
    */
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  run.proc = proc;

  /*
    Read raw and decode per chunk, because not everything on Windows writes
    UTF-8. WSL's bash.exe writes UTF-16LE, and forcing utf8 on that keeps the
    null byte after every character — the output arrives looking like
    "W i n d o w s   S u b s y s t e m", one space per letter, which reads as a
    rendering bug rather than as the wrong encoding.

    Sniffed rather than configured: a BOM if there is one, otherwise a run of
    zero bytes in the odd positions of an otherwise plain-ASCII chunk, which
    UTF-8 text never produces.
  */
  /*
    Strip terminal control sequences. Colour is already suppressed with
    NO_COLOR and FORCE_COLOR, but that only covers programs that ask politely —
    `clear` emits ESC[H ESC[2J ESC[3J because wiping the screen *is* what it
    does, and progress bars and spinners rewrite lines the same way. A real
    terminal acts on these; this output is rendered into a <pre>, where they
    show up literally as "[H[2J[3J" and read as corruption.

    CSI and OSC only. Left alone: tabs, carriage returns and newlines, which are
    layout rather than control and which <pre> already handles.
  */
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // Built with fromCharCode rather than written literally: a raw ESC in the
  // source is invisible in every editor and diff, which is how it ends up
  // deleted by accident.
  const OSC = new RegExp(ESC + "\\][^" + BEL + "]*" + BEL, "g");
  const CSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
  const ANY_ESC = new RegExp(ESC + "[\\s\\S]?", "g");
  const C0 = new RegExp(
    "[" +
      String.fromCharCode(0) + "-" + String.fromCharCode(8) +
      String.fromCharCode(11) + String.fromCharCode(12) +
      String.fromCharCode(14) + "-" + String.fromCharCode(31) +
      String.fromCharCode(127) +
      "]",
    "g"
  );
  const stripAnsi = (text) =>
    text
      .replace(OSC, "") // window titles and the like
      .replace(CSI, "") // ESC[2J, ESC[H, colours, cursor moves
      .replace(ANY_ESC, "") // anything else an ESC introduces
      .replace(C0, ""); // stray controls; tab/newline/CR survive as layout

  const decode = (chunk) => {
    if (!Buffer.isBuffer(chunk)) return String(chunk);
    if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
      return chunk.subarray(2).toString("utf16le");
    }
    const sample = chunk.subarray(0, Math.min(chunk.length, 64));
    let odd = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) odd += 1;
    const pairs = Math.floor(sample.length / 2);
    if (pairs >= 4 && odd / pairs > 0.8) return chunk.toString("utf16le");
    return chunk.toString("utf8");
  };

  proc.stdout?.on("data", (d) => publish(run, stripAnsi(decode(d))));
  proc.stderr?.on("data", (d) => publish(run, stripAnsi(decode(d))));

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
    restricted: RESTRICTED,
    allowed: [...ALLOWED].sort(),
    authorisedDevices: [...ALLOWED_DEVICES].sort(),
    timeoutMs: TIMEOUT_MS,
    runs: [...runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => describeRun(r)),
  };
}
