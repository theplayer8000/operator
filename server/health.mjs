// The failures Operator has actually had, asked about on a timer.
//
// ## Why this is a feature and not a plugin
//
// The owner asked for "a plugin that enforces verification for everything
// against bugs and procedures that would normally go unnoticed". ADR 0014
// settles the shape: **a Claude Code plugin changes how the agent BUILDING
// Operator behaves and never becomes something Operator can do.** It reaches
// `claude-code` alone — `gemini`, `airouter` and `ollama` cannot load one, and
// neither can a person opening the app on a phone. Anything Operator itself
// needs lives in `server/`, reachable by every worker and every device. So this
// is a server module and a page.
//
// ## What it refuses to be
//
// **Not a reachability check.** `homelab.mjs` already does TCP probes and
// `status.mjs` already asks about Claude. "Is the process up" is worth almost
// nothing here: this server has been up and serving cheerfully through every
// failure listed below.
//
// **Not a second copy of the Builds card.** `build.mjs` already answers "is
// dist/ behind src/, is the process behind server/" and it is imported rather
// than reimplemented — same for `worktree.mjs` (drift), `handoff.mjs`
// (staleness) and `usage.mjs` (turn durations). This file is the place they are
// asked together and given a severity; it owns almost no measurement of its
// own. Where it does measure, that is stated at the check.
//
// ## The classes it encodes, and the failure behind each
//
//   syntax     `tsc` and `vite build` never open a .mjs file. A clean gate says
//              NOTHING about a server change, and `main` has twice ended up
//              unable to restart. This parses every one of them.
//   builds     dist/ behind src/, or the process behind server/ — the change is
//              there on the dev URL and simply is not on the real one.
//   worktree   183 commits behind for two weeks, so every job ran against a
//              copy of Operator from a fortnight earlier and concluded its own
//              capability layer did not exist.
//   handoff    a restart destroys the event log; the file on disk is what
//              survives, and a stale one reads as current.
//   backups    an hourly job that silently stopped is invisible until the day
//              it is needed.
//   env        a ceiling set with `setx` that `operator-serve.ps1` never
//              forwards is a setting that writes successfully and does nothing.
//   perf       $0.92 and 129 seconds to answer "what's my gym session today"
//              was invisible to a dollar meter and obvious in duration.
//
// ## Degrade to silence, in the strong sense
//
// **A check that cannot run reports "could not check" and the reason. It never
// reports a failure.** A health page that cries wolf gets ignored, and an
// ignored health page is worse than none — the next real failure is read as
// noise. Every probe here is individually wrapped; one throwing loses that row
// and nothing else.
//
// Nothing here runs on the request path. The whole report is computed on
// demand, cached, and concurrent callers share one computation.
//
// No dependencies — Node built-ins, like everything in `server/` outside
// `runner.mjs`.

import { execFile } from "node:child_process";
import { readdir, stat, readFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { buildStatus } from "./build.mjs";
import { state as worktreeState } from "./worktree.mjs";
import { readHandoff } from "./handoff.mjs";
import { usageSnapshot } from "./usage.mjs";
import { DATA_FILE } from "./store.mjs";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Severity, ordered so a group can take the worst of its rows.
 *
 * `unknown` sits BELOW `warn` deliberately. "I could not check this" is a
 * smaller claim than "this is wrong", and ranking it higher would make an
 * offline `git` louder than an actual stale build.
 */
const RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 };
const worstOf = (severities) =>
  severities.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

const check = (id, severity, label, detail, extra = {}) => ({
  id,
  severity,
  label,
  detail,
  ...extra,
});

/** A probe that throws loses its own row, never the report. */
async function attempt(id, label, fn) {
  try {
    return await fn();
  } catch (err) {
    return [check(id, "unknown", label, `Could not check: ${err?.message ?? err}`)];
  }
}

// --- 1. every .mjs parses --------------------------------------------------

/**
 * The gate neither `tsc` nor `vite build` provides.
 *
 * `npx tsc -b` and `npx vite build` never open a `.mjs` file, so a clean build
 * is silent about the entire server. The consequence is not subtle — a syntax
 * error in `server/` means the process will not start, and it is discovered at
 * the next restart rather than at the edit.
 *
 * **`process.execPath`, never `node`.** CLAUDE.md's loudest verification note
 * is that `D:\projects\node_modules\.bin\node` shadows the real binary and
 * exits 0 having run nothing, so a session that verifies with it has verified
 * nothing and is told everything is fine. `process.execPath` is the binary
 * currently interpreting this file — it cannot be the shim, because the shim
 * could not have got here.
 */
const SYNTAX_DIRS = ["server", "scripts"];
const SYNTAX_SKIP = new Set(["node_modules", ".git", "dist", "data", "__pycache__", "win"]);

/**
 * Parse results memoised on (path, mtime, size).
 *
 * A file's syntax is a pure function of its bytes, so a sweep only pays for
 * what changed. Without this the endpoint spawns fifty-odd processes per poll,
 * which is exactly the "must not slow anything down" line being crossed by the
 * thing that was supposed to be watching for it.
 */
const parseMemo = new Map();

async function listMjs(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SYNTAX_SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await listMjs(path, out);
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

async function parseOne(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { path, ok: true, vanished: true };
  }
  const cached = parseMemo.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

  let value;
  try {
    await run(process.execPath, ["--check", path], { timeout: 20_000, windowsHide: true });
    value = { path, ok: true };
  } catch (err) {
    /*
      Node's `--check` stderr is four parts, and two of them are worth keeping:

        <absolute path>:<line>     ← where
        <the source line>          ← echoed back, useless here
        <a caret>                  ← likewise
        SyntaxError: <what>        ← what

      Taking only the `SyntaxError:` line throws away the line number, which is
      the single most useful token in the whole message — the row already names
      the file, so "what and where" is the entire answer wanted. Matching the
      location on a trailing `:<digits>` rather than on the path, because the
      path is absolute, is Windows-shaped and contains its own colon.
    */
    const lines = String(err?.stderr ?? err?.message ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const at = lines[0]?.match(/:(\d+)$/)?.[1] ?? null;
    const what = lines.find((l) => /^\w*(Error|Warning)\b/.test(l));

    /*
      DID IT FAIL, OR DID IT NOT RUN? The two must not look alike, and the
      first version made them identical.

      A timeout or a failed spawn produces no stderr at all, so the extraction
      above fell through to "failed to parse" and the file shipped as a red
      row — under a headline saying the server cannot start. That inverts this
      module's own rule, stated in its header: a check that cannot run reports
      that it could not, never a failure.

      Worse, it was then MEMOISED on (mtime, size), so a single 20-second
      hiccup became a permanent red row that only an edit to the file could
      clear. Nothing is cached unless the check actually reached a verdict.
    */
    const ranAtAll = Boolean(what) || (lines.length > 0 && !err?.killed);
    if (!ranAtAll) {
      return {
        path,
        ok: null,
        error: err?.killed || err?.code === "ETIMEDOUT" ? "timed out" : `could not run: ${err?.code ?? err?.message ?? "unknown"}`,
      };
    }

    value = {
      path,
      ok: false,
      error: [at ? `line ${at}` : null, what ?? lines[0] ?? "failed to parse"].filter(Boolean).join(" — "),
    };
  }
  parseMemo.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

async function syntaxChecks() {
  const files = [];
  for (const dir of SYNTAX_DIRS) files.push(...(await listMjs(join(ROOT, dir))));
  if (files.length === 0) {
    return [
      check("syntax", "unknown", "Server modules parse", "Found no .mjs files to check — is this the repo root?"),
    ];
  }

  // Four at a time. Sequential is slow enough to be noticeable on a cold sweep;
  // fifty at once is a spawn storm on the machine also running the app.
  const results = [];
  for (let i = 0; i < files.length; i += 4) {
    results.push(...(await Promise.all(files.slice(i, i + 4).map(parseOne))));
  }

  /*
    Three outcomes, not two. `ok: null` means the probe never reached a
    verdict — a timeout, a failed spawn — and it must not be counted with the
    files that genuinely will not parse. `!r.ok` would have swept them
    together, which is the same conflation `parseOne` was just fixed for.
  */
  const broken = results.filter((r) => r.ok === false);
  const unchecked = results.filter((r) => r.ok === null);
  const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, "/");

  const uncheckedRows = unchecked.map((u) =>
    check(`syntax:${rel(u.path)}`, "unknown", rel(u.path), u.error),
  );

  if (broken.length === 0) {
    return [
      check(
        "syntax",
        unchecked.length ? "unknown" : "ok",
        "Server modules parse",
        unchecked.length
          ? `${results.length - unchecked.length} of ${results.length} parse; ${unchecked.length} could not be checked. Nothing is wrong with those files as far as anything here knows.`
          : `${results.length} files in server/ and scripts/. Neither tsc nor vite build opens a .mjs, so nothing else checks these.`,
      ),
      ...uncheckedRows,
    ];
  }

  return [
    check(
      "syntax",
      "fail",
      "Server modules parse",
      `${broken.length} of ${results.length} will not parse. The server cannot start with these on disk.`,
      { hint: `"${process.execPath}" --check ${rel(broken[0].path)}` },
    ),
    ...broken.map((b) =>
      check(`syntax:${rel(b.path)}`, "fail", rel(b.path), b.error),
    ),
    ...uncheckedRows,
  ];
}

// --- 2. builds and the running process ------------------------------------

async function buildChecks() {
  const b = await buildStatus(ROOT);
  const out = [];

  if (b.live.missing) {
    out.push(
      check("build:live", "fail", "Live app built", "There is no dist/ — the live URL serves nothing.", {
        hint: "npm --prefix D:\\Projects\\Operator run build",
      }),
    );
  } else if (b.live.stale) {
    out.push(
      check(
        "build:live",
        "warn",
        "Live app built",
        "src/ has changed since the last build. The dev URL shows the change and the live URL does not, which reads as the change not working.",
        { hint: "npm --prefix D:\\Projects\\Operator run build", at: b.live.builtAt, since: b.live.sourceChangedAt },
      ),
    );
  } else {
    out.push(check("build:live", "ok", "Live app built", "dist/ matches src/.", { at: b.live.builtAt }));
  }

  /*
    `stale` and `supervised` are null when buildStatus() was not called from
    inside the server — see its comment. Null is "could not check from here",
    never a pass.
  */
  out.push(
    b.server.stale === null
      ? check(
          "build:server",
          "unknown",
          "Server running current code",
          "Cannot tell from here — this was asked from a process that is not the server, and the answer would describe that process instead.",
        )
      : b.server.stale
      ? check(
          "build:server",
          "warn",
          "Server running current code",
          "server/ has changed since this process started. Server code is loaded at boot, so the edit is not live until a restart.",
          { hint: "Restart, from the Dev page", at: b.server.startedAt, since: b.server.codeChangedAt },
        )
      : check("build:server", "ok", "Server running current code", "No server/ file is newer than the process.", {
          at: b.server.startedAt,
        }),
  );

  out.push(
    b.server.supervised === null
      ? check(
          "build:supervised",
          "unknown",
          "Supervised",
          "Cannot tell from here — asked from outside the server process.",
        )
      : b.server.supervised
      ? check("build:supervised", "ok", "Supervised", "Restart relaunches it (scripts/supervise.mjs).")
      : check(
          "build:supervised",
          "warn",
          "Supervised",
          "Not under the supervisor, so Restart would stop the server rather than reload it.",
        ),
  );

  if (b.agent) {
    out.push(
      !b.agent.separate
        ? check(
            "build:agent",
            "warn",
            "Agent edits its own checkout",
            "OPERATOR_JOB_CWD is unset or points at this checkout, so a job editing server/ changes the tree this server is serving. That is how main twice ended up unable to restart.",
          )
        : check("build:agent", "ok", "Agent edits its own checkout", `Jobs run in ${b.agent.cwd}.`),
    );
  }

  return out;
}

// --- 3. git: drift, and work that only exists on this disk -----------------

const git = async (cwd, args) => {
  const { stdout } = await run("git", args, { cwd, timeout: 15_000, windowsHide: true });
  return stdout.trim();
};

async function gitChecks() {
  const out = [];

  /*
    The worktree, through `worktree.mjs` rather than a second implementation.

    Two grades of the same fact, because the difference matters: a few commits
    behind is an inconvenience, and the recorded failure was 183 — at which
    point the worktree is a different program and every job's conclusions about
    it are wrong.
  */
  const cwd = process.env.OPERATOR_JOB_CWD ?? null;
  const w = await worktreeState(cwd);
  if (!w.ok) {
    out.push(
      check("git:worktree", "unknown", "Agent worktree in step with main", `Could not check: ${w.reason}`),
    );
  } else if (w.behind === 0) {
    out.push(
      check("git:worktree", "ok", "Agent worktree in step with main", `${w.branch} is level with main.`, {
        dirty: w.dirty.length,
      }),
    );
  } else {
    out.push(
      check(
        "git:worktree",
        w.behind >= 25 ? "fail" : "warn",
        "Agent worktree in step with main",
        `${w.branch} is ${w.behind} commit(s) behind main, so every job runs against that older copy of Operator. ` +
          (w.dirty.length
            ? `A fast-forward will refuse — ${w.dirty.length} uncommitted change(s) in there.`
            : "It can be fast-forwarded safely."),
        { hint: "npm run land, or git -C <worktree> merge --ff-only main", behind: w.behind, dirty: w.dirty.length },
      ),
    );
  }

  /*
    Work FINISHED in the worktree that never reached main — the other direction,
    and the more expensive one.

    Every check above asks whether the agent is running old code. None asked the
    opposite question, and on 2026-09-04 that cost a day: the chat-uploads fix
    was built, committed, marked done, and sat here across four full restarts.
    Each restart loaded a build that had never contained it, so the fix did not
    look absent — it looked BROKEN, which sent the next session hunting for a
    bug in code that was never running.

    Graded by what is actually at risk. Committed-but-unlanded is the loud one:
    someone decided that work was finished and it is not live, and nothing else
    in this file would ever say so. Uncommitted-only is quieter — that is
    ordinary work in progress, and it is a warning solely because it blocks a
    sync, which the check above already explains.
  */
  if (w.ok) {
    const stranded = w.ahead ?? 0;
    if (stranded > 0) {
      out.push(
        check(
          "git:unlanded",
          stranded >= 3 ? "fail" : "warn",
          "Finished work reached main",
          `${stranded} commit(s) are committed in ${w.branch} and NOT on main, so nothing they change is live no matter how many times Operator is restarted: ` +
            (w.unlanded ?? []).slice(0, 4).join("; ") +
            ((w.unlanded?.length ?? 0) > 4 ? ` (+${w.unlanded.length - 4} more)` : ""),
          {
            hint: "the worktree_land action, or npm run land",
            ahead: stranded,
            commits: w.unlanded ?? [],
          },
        ),
      );
    } else if (w.dirty.length) {
      out.push(
        check(
          "git:unlanded",
          "ok",
          "Finished work reached main",
          `Nothing committed is waiting to land. ${w.dirty.length} file(s) uncommitted in ${w.branch} — work in progress, not stranded.`,
          { ahead: 0, dirty: w.dirty.length },
        ),
      );
    } else {
      out.push(
        check("git:unlanded", "ok", "Finished work reached main", `Everything committed in ${w.branch} is on main.`, {
          ahead: 0,
        }),
      );
    }
  }

  /*
    Unpushed work, measured against the last fetch and NOT a fresh one.

    Fetching here would be an outbound call to GitHub on a page poll — the
    external-approval rule aside, a health check that reaches the network is a
    health check that fails when the network does. So this compares against the
    local remote-tracking ref and says so, which is honest about being a lower
    bound.
  */
  try {
    const ahead = Number(await git(ROOT, ["rev-list", "--count", "origin/main..main"])) || 0;
    const dirty = (await git(ROOT, ["status", "--porcelain"])).split("\n").filter((l) => l.trim()).length;
    out.push(
      ahead === 0
        ? check("git:ahead", "ok", "main pushed", "Level with origin/main as of the last fetch.")
        : check(
            "git:ahead",
            "warn",
            "main pushed",
            `${ahead} commit(s) on main exist only on this disk. Measured against the last fetch — nothing here fetches.`,
            { ahead },
          ),
    );
    /*
      Reported, never flagged. The owner has named the permanently-dirty tree as
      his own recurring friction; a health page that colours it red every day is
      a health page he stops reading. `data/` is gitignored and is covered by
      the backup rows instead.
    */
    out.push(
      check("git:dirty", "ok", "Working tree", dirty === 0 ? "Clean." : `${dirty} uncommitted file(s) on main.`, {
        dirty,
      }),
    );
  } catch (err) {
    out.push(check("git:ahead", "unknown", "main pushed", `Could not ask git: ${err?.message ?? err}`));
  }

  return out;
}

// --- 4. the handoff --------------------------------------------------------

const HOUR = 3_600_000;

/*
  Idea 3 of the security sweep: credentials in work it is about to push.

  The git group says HOW MUCH is waiting to land; this group asks WHAT is in
  it. A key that reaches origin is gone — the copy on GitHub is the breach,
  and rotation is the recovery. Catching it on THIS disk, before push, is the
  only place the check has value.

  Three sources, each named in the detail:
    - uncommitted changes in the agent worktree, tracked AND untracked (git
      diff cannot see a `??` file, and untracked is where a stray .env lands)
    - commits on the agent branch not yet on main (`main...HEAD`)
    - commits on main not yet on origin (`origin/main..main`, same last-fetch
      honesty as the git:ahead row — nothing here fetches)

  Only lines being ADDED are scanned; a line that stops containing a secret
  is the opposite of a leak. The detail names the FILE and the PATTERN, never
  the value — a health page that echoed a credential would itself be the
  leak. High-confidence shapes (private keys, provider tokens) are failures;
  a generic `key = "..."` assignment is a warning, because it can be a
  test fixture. Individual sources degrade to "skipped" rather than failing
  the row, so one unreadable file cannot hide the rest.
*/
const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, name: "private key", severity: "fail" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, name: "sk- API key", severity: "fail" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: "AWS access key", severity: "fail" },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, name: "GitHub personal token", severity: "fail" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, name: "Slack token", severity: "fail" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, name: "JWT", severity: "fail" },
  {
    re: /\b(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{16,})["']?\b/,
    name: "possible key assignment",
    severity: "warn",
  },
];

/** One added line; returns the first pattern it trips, if any. */
function secretMatch(line) {
  const value = line[0] === "+" ? line.slice(1) : line;
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(value)) return p;
  }
  return null;
}

async function secretsChecks() {
  const out = [];
  const hits = [];

  const scanLines = (text, source, file) => {
    if (!text || text.length > 2_000_000) return;
    for (const line of text.split(/\r?\n/)) {
      // Diff context: only the added side. A `+` that is not the `+++` file
      // header. Raw file contents (untracked) have no `+` prefix at all.
      if (line.startsWith("+++ ")) continue;
      if (line.startsWith("+") || !text.includes("diff --git")) {
        const content = line.startsWith("+") ? line.slice(1) : line;
        const p = secretMatch(content);
        if (p) hits.push({ source, file, pattern: p.name, severity: p.severity });
      }
    }
  };

  const cwd = process.env.OPERATOR_JOB_CWD ?? null;

  // 1. Uncommitted worktree changes: tracked diffs, then untracked contents.
  if (cwd) {
    try {
      const diff = await git(cwd, ["diff"]);
      scanLines(diff, "worktree (uncommitted)", "tracked changes");
      const staged = await git(cwd, ["diff", "--cached"]);
      scanLines(staged, "worktree (staged)", "staged changes");
    } catch {
      /* git unavailable in the worktree — the git:worktree row already says so */
    }
    try {
      const untracked = (await git(cwd, ["status", "--porcelain", "--untracked-files=all"]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("?? "))
        .map((l) => l.slice(3));
      for (const rel of untracked.slice(0, 20)) {
        const path = join(cwd, rel);
        try {
          const body = await readFile(path, "utf8");
          if (body.includes("\u0000")) continue; // binary
          scanLines(body, "worktree (untracked)", rel);
        } catch {
          /* vanished between listing and read — skip, not fail */
        }
      }
    } catch {
      /* status failed — skip the untracked scan entirely */
    }
  }

  // 2. Agent commits not yet on main.
  if (cwd) {
    try {
      const diff = await git(cwd, ["diff", "main...HEAD"]);
      scanLines(diff, "agent branch", "main...HEAD");
    } catch {
      /* no main ref in the worktree */
    }
  }

  // 3. Main not yet pushed. Same local-ref honesty as git:ahead.
  try {
    const diff = await git(ROOT, ["diff", "origin/main..main"]);
    scanLines(diff, "main (unpushed)", "origin/main..main");
  } catch {
    /* no origin/main ref — nothing fetched yet, nothing to compare */
  }

  if (hits.length === 0) {
    out.push(
      check("git:secrets", "ok", "No credentials in pending work", "Added lines in the worktree and unpushed commits match no secret patterns."),
    );
    return out;
  }

  const worst = hits.some((h) => h.severity === "fail") ? "fail" : "warn";
  const byFile = {};
  for (const h of hits) {
    byFile[h.file] = byFile[h.file] ?? new Set();
    byFile[h.file].add(h.pattern);
  }
  const files = Object.entries(byFile)
    .map(([f, pats]) => `${f} (${[...pats].join(", ")})`)
    .slice(0, 4);
  const shown = files.join("; ") + (hits.length > 4 ? `; +${hits.length - 4} more` : "");
  out.push(
    check(
      "git:secrets",
      worst,
      "Credentials in pending work",
      `${hits.length} added line(s) match ${worst === "fail" ? "credential" : "possibly-credential"} patterns. Values are not echoed here — look at: ${shown}`,
      { hits: hits.length, sources: [...new Set(hits.map((h) => h.source))] },
    ),
  );
  return out;
}

async function handoffChecks() {
  const h = await readHandoff();
  const age = h.updatedAt ? Date.now() - new Date(h.updatedAt).getTime() : null;

  if (!h.text.trim()) {
    return [
      check(
        "handoff",
        "warn",
        "Handoff current",
        "CURRENT.md is empty. A session picking this up has the repository and nothing else — say the work is finished rather than leaving it blank.",
        { hint: 'node scripts/operator-action.mjs handoff_write \'{"body":"…"}\'' },
      ),
    ];
  }

  if (!h.inFlight) {
    return [
      check("handoff", "ok", "Handoff current", "Nothing claimed — the last milestone was folded.", {
        at: h.updatedAt,
      }),
    ];
  }

  /*
    In flight and untouched is the interesting state, and 12 hours is the line
    because that is roughly a working session plus a night. Restarting destroys
    the event log, so a note written before the work moved is the version a
    later session will trust — being confidently wrong about where the work
    stands is the failure this file exists to prevent.
  */
  const stale = age !== null && age > 12 * HOUR;
  return [
    check(
      "handoff",
      stale ? "warn" : "ok",
      "Handoff current",
      stale
        ? `Work is marked in flight but the note has not been touched in ${Math.round(age / HOUR)}h. Either it moved and the file did not, or it is finished and needs folding.`
        : "In flight, and recently written.",
      { at: h.updatedAt, hint: stale ? 'node scripts/operator-action.mjs handoff_fold \'{"slug":"…"}\'' : undefined },
    ),
  ];
}

// --- 5. the store and its backups -----------------------------------------

const BACKUP_DIR = process.env.OPERATOR_BACKUP_DIR ?? join(homedir(), "OperatorBackups");

/** Parsed store shape, memoised on mtime — it only changes when the file does. */
let shapeMemo = null;

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function storeChecks() {
  const out = [];

  /*
    The store's own row is wrapped separately from the backup rows below.

    A group-level catch would have been simpler and exactly wrong: the moment
    the store is missing or will not parse is the moment "is there a restore
    point, and where" is the most useful sentence on the page. Losing that row
    to the failure it exists for is the shape of unhelpfulness this whole file
    is arguing against.
  */
  let info = null;
  try {
    info = await stat(DATA_FILE);
    let shape = shapeMemo?.mtimeMs === info.mtimeMs ? shapeMemo.value : null;
    if (!shape) {
      // Read whole and parse. store.mjs writes tmp-then-rename, so a reader can
      // never see a half-written file — that guarantee is what makes this safe
      // to do without coordinating with the writer.
      const text = await readFile(DATA_FILE, "utf8");
      const parsed = JSON.parse(text);
      const slices = Object.entries(parsed.state ?? {})
        .map(([key, value]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(value ?? null), "utf8") }))
        .sort((a, b) => b.bytes - a.bytes);
      shape = { schemaVersion: parsed.schemaVersion ?? null, count: slices.length, largest: slices.slice(0, 5) };
      shapeMemo = { mtimeMs: info.mtimeMs, value: shape };
    }
    out.push(
      check(
        "store:size",
        "ok",
        "Store",
        `${kb(info.size)} across ${shape.count} slices, schema v${shape.schemaVersion}. Largest: ` +
          shape.largest
            .slice(0, 3)
            .map((s) => `${s.key} ${kb(s.bytes)}`)
            .join(", "),
        { bytes: info.size, slices: shape.count, largest: shape.largest, at: info.mtime.toISOString() },
      ),
    );
  } catch (err) {
    /*
      A store that will not parse IS a failure rather than an unchecked row —
      the one exception to this file's rule, and it earns it: the server holds
      the file in memory, so it can serve a broken store all day without
      complaining, and `runBackup()` refuses to snapshot it. Both symptoms are
      silent.
    */
    out.push(
      check(
        "store:size",
        err?.code === "ENOENT" ? "unknown" : "fail",
        "Store",
        err?.code === "ENOENT"
          ? `No store at ${DATA_FILE} — nothing has been written yet.`
          : `${DATA_FILE} could not be read or parsed: ${err?.message ?? err}. Backups are refused while it is in this state.`,
      ),
    );
  }

  // --- backups ---
  //
  // The check is deliberately NOT "was there a backup in the last hour".
  // `runBackup()` skips an unchanged store on purpose, so a quiet day producing
  // no restore point is correct behaviour and flagging it would train him to
  // ignore this row. What is genuinely wrong is the store having moved on
  // without a snapshot following it.
  let names = [];
  if (existsSync(BACKUP_DIR)) {
    names = (await readdir(BACKUP_DIR))
      .filter((n) => n.startsWith("operator-") && n.endsWith(".json"))
      .sort();
  }

  if (names.length === 0) {
    out.push(
      check(
        "store:backups",
        "warn",
        "Backups",
        `No restore points in ${BACKUP_DIR}. data/ is gitignored, so git is not a backup — there is currently no copy of this store anywhere.`,
        { hint: "npm run backup", dir: BACKUP_DIR },
      ),
    );
    return out;
  }

  const sizes = [];
  for (const name of names) {
    try {
      const s = await stat(join(BACKUP_DIR, name));
      sizes.push({ name, bytes: s.size, at: s.mtimeMs });
    } catch {
      /* pruned mid-read — it cannot be the newest, which is all that matters */
    }
  }
  if (sizes.length === 0) {
    // Named but unstattable — the directory was pruned out from under the walk.
    out.push(
      check("store:backups", "unknown", "Backups", `Could not stat anything in ${BACKUP_DIR}.`, { dir: BACKUP_DIR }),
    );
    return out;
  }

  const newest = sizes[sizes.length - 1];
  const oldest = sizes[0];
  // `info` is null when the store could not be read at all — in which case
  // "how far behind is the newest backup" has no answer, and claiming 0 would
  // read as "up to date" at the exact moment it is least true.
  const behind = info && info.mtimeMs > newest.at ? info.mtimeMs - newest.at : 0;

  out.push(
    behind > 3 * HOUR
      ? check(
          "store:backups",
          "warn",
          "Backups",
          `${sizes.length} restore points, but the store was written ${Math.round(behind / HOUR)}h after the newest one. The hourly job runs inside this server — if it had run, there would be a snapshot.`,
          { hint: "npm run backup", dir: BACKUP_DIR, at: new Date(newest.at).toISOString() },
        )
      : check(
          "store:backups",
          "ok",
          "Backups",
          `${sizes.length} restore points in ${BACKUP_DIR}. Still one machine — a bad write is covered, a lost disk is not.`,
          { dir: BACKUP_DIR, at: new Date(newest.at).toISOString(), count: sizes.length },
        ),
  );

  /*
    Growth, measured across the restore points rather than against a remembered
    number — nothing here has a history of its own, and 60 snapshots already are
    one. They span distinct STATES rather than a fixed window (an unchanged
    store is skipped), so the span is reported rather than assumed to be hours.
  */
  if (sizes.length >= 3 && info) {
    let jump = { bytes: 0, name: null };
    for (let i = 1; i < sizes.length; i += 1) {
      const delta = sizes[i].bytes - sizes[i - 1].bytes;
      if (delta > jump.bytes) jump = { bytes: delta, name: sizes[i].name };
    }
    const grown = oldest.bytes > 0 ? info.size / oldest.bytes : 1;
    const days = Math.max(1, Math.round((newest.at - oldest.at) / 86_400_000));
    out.push(
      /*
        Both halves matter. A ratio alone screams on a store that grew from 4 KB
        to 40 KB, which is a first week rather than a problem; a size alone
        never notices a doubling.

        The floor is 1 MB because of what `remoteStore.ts` does with the file:
        it polls `/api/health` for `updatedAt`, and every time that stamp moves
        it refetches the WHOLE of `/api/state` — during a voice turn, at its
        800ms active rate. So size here is not disk, it is what crosses the
        tailnet to a phone each time anything is written.

        It self-corrects rather than sticking: the ratio is measured against the
        OLDEST of 60 restore points, which rolls forward, so a legitimate
        one-off import stops being the baseline once 60 further states pass.
      */
      grown >= 3 && info.size > 1_000_000
        ? check(
            "store:growth",
            "warn",
            "Store growth",
            `${grown.toFixed(1)}x the oldest restore point across ${sizes.length} states (~${days}d). Largest single step +${kb(jump.bytes)} at ${jump.name}. remoteStore refetches all of /api/state whenever updatedAt moves, so the whole ${kb(info.size)} crosses the wire on every write.`,
            { ratio: grown, jumpBytes: jump.bytes },
          )
        : check(
            "store:growth",
            "ok",
            "Store growth",
            `${grown.toFixed(2)}x the oldest of ${sizes.length} restore points (~${days}d). Largest single step +${kb(jump.bytes)}.`,
            { ratio: grown, jumpBytes: jump.bytes },
          ),
    );
  }

  return out;
}

// --- 6. what the process is actually running with -------------------------

/**
 * Names only — the values never enter this process.
 *
 * `reg query` prints every value alongside its name, which would pull
 * `GEMINI_API_KEY` and `AIROUTER_API_KEY` into this process's memory to
 * immediately throw them away. `GetValueNames()` returns the names and nothing
 * else, so the secret is never read at all rather than read-and-discarded.
 * `operator-serve.ps1` already establishes PowerShell as the way to read
 * HKCU\Environment on this machine, and for the neighbouring reason: cmd's
 * `for /f` over `reg query` mangled a JSON value at 501 of 541 characters.
 *
 * Cached for five minutes. The registry changes when he runs `secret_set`, not
 * on a poll, and this is the one probe that spawns PowerShell.
 */
let registryCache = null;
const REGISTRY_TTL = 5 * 60_000;

async function registryNames() {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL) return registryCache.value;
  if (process.platform !== "win32") {
    const value = { ok: false, reason: "not Windows — there is no HKCU\\Environment to compare against" };
    registryCache = { at: Date.now(), value };
    return value;
  }
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item 'HKCU:\\Environment').GetValueNames()"],
      { timeout: 15_000, windowsHide: true },
    );
    const value = {
      ok: true,
      names: stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    };
    registryCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const value = { ok: false, reason: String(err?.message ?? err).split("\n")[0] };
    registryCache = { at: Date.now(), value };
    return value;
  }
}

/**
 * What this page will talk about at all.
 *
 * **Operator's own namespace plus the credentials that are actually approved,
 * and nothing else.** It used to end `|(_API_KEY|_TOKEN)$`, which swept in any
 * credential on the machine — and because the same list drives the drift
 * ADVICE, the page would have told him to add, say, `GITHUB_TOKEN` to the
 * launcher's `$credentials` and restart. That is Operator handing an unrelated
 * third-party key to a process that talks to third parties, recommended by its
 * own health check, and CLAUDE.md's per-host approval rule forbids exactly
 * that. Inert on this machine today; it fires the first time an unrelated key
 * is set.
 *
 * A provider approved by name goes in the launcher AND here, in that order.
 */
const APPROVED_CREDENTIALS = [
  "AIROUTER_API_KEY",
  "GEMINI_API_KEY",
  // Approved by name on 2026-09-04 (CLAUDE.md's table, server/websearch.mjs and
  // server/runway.mjs) and missing from this list until the day after, which is
  // exactly the gap the comment above warns about: he set both from his phone,
  // this check reported "nothing set in the registry is missing from the running
  // server", and it was blind to both names. It was not lying about what it
  // looked at; it was silent about what it did not, which reads the same.
  "BRAVE_SEARCH_API_KEY",
  "RUNWAY_API_KEY",
];
/*
  Anchored per alternative, not once at the end.

  `join("|")` inside `^(...|NAME$)` puts the `$` on the LAST alternative only, so
  every other credential was prefix-matched — `AIROUTER_API_KEY_OLD` counted as
  the real thing. Harmless so far and wrong in the direction that hides a
  mistake, which is the wrong direction for this file.
*/
const INTERESTING = new RegExp(
  `^(?:OPERATOR_|${APPROVED_CREDENTIALS.map((n) => `${n}$`).join("|")})`,
);

async function envChecks() {
  const inProcess = Object.keys(process.env).filter((n) => INTERESTING.test(n)).sort();
  const reg = await registryNames();

  /*
    Presence, never a value — for any of them, not only the ones that look like
    keys. CLAUDE.md's rule exists because a key reached the server log through
    an audit line nobody thought of as a disclosure, and "it is only a boolean
    for the non-secret ones" is how the exception gets written.
  */
  const vars = inProcess.map((name) => ({ name, process: true, registry: reg.ok ? reg.names.includes(name) : null }));

  const out = [
    check(
      "env:process",
      "ok",
      "Environment reaching the server",
      `${inProcess.length} OPERATOR_* / credential variables are set in this process. Values are never read here — presence only.`,
      { vars },
    ),
  ];

  if (!reg.ok) {
    out.push(
      check(
        "env:drift",
        "unknown",
        "Set in the registry but not in the process",
        `Could not read HKCU\\Environment: ${reg.reason}`,
      ),
    );
    return out;
  }

  /*
    The silent no-op, caught at last.

    Task Scheduler caches the user's environment block when the SERVICE starts,
    so a `setx` afterwards never reaches a task it launches — which is why
    `operator-serve.ps1` reads HKCU\Environment by hand rather than trusting
    what it inherited. A ceiling set from his phone with `secret_set` landed in
    the registry, was never forwarded, and did nothing at all while reporting
    success. That happened four times before the script stopped naming
    OPERATOR_* one at a time.

    Which is why the two halves get DIFFERENT advice, and getting that wrong
    would waste the evening this check exists to save:

      OPERATOR_*   forwarded wholesale by that script now, so one missing here
                   means the server started before it was set (restart) or the
                   registry value is empty (the script skips falsy values).
      credentials  still a deliberately NAMED list — matching *_API_KEY by
                   pattern would sweep unrelated keys off his account into a
                   process that talks to third parties, and CLAUDE.md's
                   approvals table is per-host on purpose. So a newly approved
                   provider's key needs adding to `$credentials`, and this row
                   is the only thing that will ever say so.
  */
  const missing = reg.names.filter((n) => INTERESTING.test(n) && !(n in process.env)).sort();
  const missingOperator = missing.filter((n) => n.startsWith("OPERATOR_"));
  const missingCredentials = missing.filter((n) => !n.startsWith("OPERATOR_"));

  out.push(
    missing.length === 0
      ? check(
          "env:drift",
          "ok",
          "Set in the registry but not in the process",
          "Nothing set in HKCU\\Environment is missing from the running server.",
        )
      : check(
          "env:drift",
          "warn",
          "Set in the registry but not in the process",
          `${missing.length} set in HKCU\\Environment and absent here, so they are doing nothing: ${missing.join(", ")}.` +
            (missingCredentials.length
              ? ` ${missingCredentials.join(", ")} — credentials are a named list in scripts/operator-serve.ps1, and an unnamed one never arrives.`
              : "") +
            (missingOperator.length
              ? ` ${missingOperator.join(", ")} — that script forwards every OPERATOR_* it finds, so these were set after this process started, or hold an empty value.`
              : ""),
          {
            missing,
            hint: missingCredentials.length
              ? `Add ${missingCredentials.join(", ")} to $credentials in scripts/operator-serve.ps1, then restart`
              : "Restart, from the Dev page",
          },
        ),
  );

  return out;
}

// --- 7. performance --------------------------------------------------------

/**
 * How long the last few hundred API requests took.
 *
 * Measured here rather than taken from anywhere else because nothing else
 * measures it — `usage.mjs` records turns, which is a different question. One
 * `push` into a fixed-length ring per request, from a `finish` listener, so the
 * response is long gone before this runs.
 */
const API_SAMPLES = 500;
const apiRing = [];
const apiByPath = new Map();
const PATH_LIMIT = 200;

/** Long enough that it is a stream or a hung call, not a request worth averaging. */
const LONG_MS = 20_000;
let apiLong = 0;

/**
 * `/api/jobs/<id>/input` and `/api/jobs/<other>/input` are one route.
 *
 * Grouping, not routing — a mistake here costs a slightly odd label and nothing
 * else, so the rule stays a regex rather than becoming a route table that has
 * to be kept in step with `index.mjs`.
 */
function bucket(pathname) {
  return pathname
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^\d{13}-[a-z0-9]{6,}$/i.test(seg) || /^[a-z0-9]{16,}$/i.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

export function noteApiRequest(pathname, ms, status) {
  if (!Number.isFinite(ms)) return;
  if (ms > LONG_MS) {
    // Streams (`/api/terminal/stream` holds a connection open for the life of a
    // run) would otherwise own p95 and make every real number meaningless.
    apiLong += 1;
    return;
  }
  apiRing.push({ ms, status });
  if (apiRing.length > API_SAMPLES) apiRing.shift();

  const key = bucket(pathname);
  let slot = apiByPath.get(key);
  if (!slot) {
    if (apiByPath.size >= PATH_LIMIT) return;
    slot = { n: 0, total: 0, max: 0 };
    apiByPath.set(key, slot);
  }
  slot.n += 1;
  slot.total += ms;
  if (ms > slot.max) slot.max = ms;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Read the tail of a file without loading a month of it. */
async function tailLines(file, maxBytes = 512 * 1024) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return { lines: [], truncated: false };
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // A partial first line when the window started mid-record.
    if (start > 0) lines.shift();
    return { lines: lines.filter((l) => l.trim()), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/*
  Mirrors `usage.mjs`'s own path, because that file exports no reader for its
  records — only the aggregate. Reaching for the file rather than adding an
  export keeps this change inside the health feature; if a reader is ever added
  there, delete this and import it.
*/
const USAGE_DIR = process.env.OPERATOR_USAGE_DIR ?? join(ROOT, "data");
const TURN_WINDOW = 200;

async function perfChecks() {
  const out = [];

  // --- API latency ---
  const sorted = apiRing.map((s) => s.ms).sort((a, b) => a - b);
  if (sorted.length === 0) {
    out.push(
      check(
        "perf:api",
        "unknown",
        "API latency",
        "No requests recorded yet — timings are kept in memory and start empty after a restart.",
      ),
    );
  } else {
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const errors = apiRing.filter((s) => s.status >= 500).length;
    const slowest = [...apiByPath.entries()]
      .map(([path, s]) => ({ path, n: s.n, mean: s.total / s.n, max: s.max }))
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 5);
    out.push(
      check(
        "perf:api",
        errors > 0 || p95 > 1500 ? "warn" : "ok",
        "API latency",
        `p50 ${p50.toFixed(0)}ms, p95 ${p95.toFixed(0)}ms over the last ${sorted.length} requests` +
          (errors ? `, ${errors} of them 5xx` : "") +
          (apiLong ? `. ${apiLong} long-lived connection(s) excluded — a stream is not a request.` : "."),
        { p50, p95, samples: sorted.length, errors, slowest },
      ),
    );
  }

  // --- turn duration, from usage.mjs's own records ---
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const file = join(USAGE_DIR, `usage-${month}.jsonl`);
  if (!existsSync(file)) {
    out.push(
      check("perf:turns", "unknown", "Turn duration", `No usage records this month (${file}). Nothing has run yet.`),
    );
  } else {
    const { lines } = await tailLines(file);
    const records = [];
    for (const line of lines.slice(-TURN_WINDOW * 2)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* a half-written append at a crash — one bad line must not lose the rest */
      }
    }
    const recent = records.slice(-TURN_WINDOW);
    const durations = recent.map((r) => Number(r.durationMs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    /*
      A cancelled turn is not a failed one, and counting it as one made this row
      alarm at him for restarting his own server.

      `stopAll` cancels every running turn on the way down, so each restart
      produced a "failure". On 2026-09-06 this read "26 of 200 ended in an
      error" — and most of the 26 were his six restarts that afternoon, which is
      exactly the noise a real failure then hides in.

      Records written before `outcome` existed carry only `error: true` and are
      genuinely unclassifiable, so they are counted separately and SAID rather
      than folded into either bucket. Guessing would put this row straight back
      to reporting a number it cannot support.
    */
    const failed = recent.filter((r) => r.outcome === "failed").length;
    const cancelled = recent.filter((r) => r.outcome === "cancelled").length;
    const unclassified = recent.filter((r) => !r.outcome && r.error).length;
    const errors = failed + unclassified;

    if (durations.length === 0) {
      out.push(check("perf:turns", "unknown", "Turn duration", `${recent.length} turn(s) recorded, none with a duration.`));
    } else {
      const p50 = percentile(durations, 50);
      const p95 = percentile(durations, 95);
      /*
        Slow is not the same as wrong, so this warns rather than fails. The
        reference point is the 2026-08-20 defect: 129 seconds and nine
        permission prompts to answer "what's my gym session today". A p95 past
        two minutes means that shape of turn is routine again.
      */
      out.push(
        check(
          "perf:turns",
          p95 > 120_000 ? "warn" : "ok",
          "Turn duration",
          `p50 ${(p50 / 1000).toFixed(1)}s, p95 ${(p95 / 1000).toFixed(1)}s over the last ${durations.length} turns` +
            (failed ? `. ${failed} genuinely failed` : ".") +
            (cancelled ? `, ${cancelled} cancelled (a restart cancels every running turn — not a failure)` : "") +
            (unclassified
              ? `, ${unclassified} recorded before cancellations were told apart from failures, so those are unclassified`
              : "") +
            (failed || cancelled || unclassified ? "." : ""),
          { p50, p95, samples: durations.length, errors, failed, cancelled, unclassified, window: recent.length },
        ),
      );
    }
  }

  // --- quota and ceilings, from usage.mjs ---
  const usage = usageSnapshot();
  const exhausted = Object.entries(usage.quota ?? {})
    .filter(([, q]) => q?.exhausted)
    .map(([id]) => id);
  out.push(
    exhausted.length
      ? check(
          "perf:quota",
          "warn",
          "Provider quota",
          `Out of daily quota: ${exhausted.join(", ")}. Quota is a separate ledger from cost — a provider can be unusable while reporting $0.00.`,
          { exhausted },
        )
      : check("perf:quota", "ok", "Provider quota", "No provider has reported itself out for the day."),
  );

  /*
    The ceiling check is conditional on concurrency, which is the whole argument
    from CLAUDE.md's open decision 3 in one row: one turn at a time bounded
    spend by wall-clock, N turns multiply it by N, and nothing else stops a
    mistyped loop.
  */
  const concurrent = Number(process.env.OPERATOR_MAX_CONCURRENT ?? 1) || 1;
  const anyCeiling = Boolean(
    usage.ceilings?.jobUsd || usage.ceilings?.dailyUsd || usage.ceilings?.providerUsd || usage.ceilings?.quotaRequests,
  );
  out.push(
    anyCeiling
      ? check("perf:ceiling", "ok", "Spend ceiling", `Configured. Today is ${usage.usageDay}, priced with table ${usage.priceTableVersion}.`)
      : check(
          "perf:ceiling",
          concurrent > 1 ? "warn" : "ok",
          "Spend ceiling",
          concurrent > 1
            ? `No ceiling set while OPERATOR_MAX_CONCURRENT is ${concurrent}. Wall-clock is no longer the brake once turns run in parallel.`
            : "None set. One turn at a time bounds spend by wall-clock, so this is a defensible default.",
          { hint: concurrent > 1 ? "OPERATOR_CEILING_DAILY_USD, and forward it in scripts/operator-serve.ps1" : undefined },
        ),
  );

  return out;
}

// --- the report ------------------------------------------------------------

const GROUPS = [
  {
    id: "syntax",
    title: "Server code",
    subtitle: "The gate tsc and vite build do not provide",
    build: () => attempt("syntax", "Server modules parse", syntaxChecks),
  },
  {
    id: "builds",
    title: "Builds",
    subtitle: "Is what is running what was written",
    build: () => attempt("build", "Builds", buildChecks),
  },
  {
    id: "git",
    title: "Git",
    subtitle: "Drift between the checkouts, and work only on this disk",
    build: () => attempt("git", "Git", gitChecks),
  },
  {
    id: "git-secrets",
    title: "Git security",
    subtitle: "Credentials in work it is about to push",
    build: () => attempt("git-secrets", "Git security", secretsChecks),
  },
  {
    id: "handoff",
    title: "Handoff",
    subtitle: "The note that survives a restart",
    build: () => attempt("handoff", "Handoff current", handoffChecks),
  },
  {
    id: "store",
    title: "Data",
    subtitle: "The store, its shape, and whether a copy exists",
    build: () => attempt("store", "Store", storeChecks),
  },
  {
    id: "env",
    title: "Environment",
    subtitle: "What the process is actually running with",
    build: () => attempt("env", "Environment reaching the server", envChecks),
  },
  {
    id: "perf",
    title: "Performance",
    subtitle: "Latency, turn duration, quota",
    build: () => attempt("perf", "Performance", perfChecks),
  },
];

/**
 * One computation shared by every concurrent caller, and cached briefly.
 *
 * Two pollers arriving together used to mean two full sweeps — dozens of
 * spawned processes for one answer. The in-flight promise is what makes this
 * safe to poll from more than one device, which it will be.
 */
const CACHE_MS = 15_000;
let cached = null;
let inFlight = null;

async function compute() {
  const startedAt = Date.now();
  const groups = [];
  for (const group of GROUPS) {
    const checks = await group.build();
    groups.push({
      id: group.id,
      title: group.title,
      subtitle: group.subtitle,
      worst: worstOf(checks.map((c) => c.severity)),
      checks,
    });
  }

  const all = groups.flatMap((g) => g.checks);
  const summary = {
    ok: all.filter((c) => c.severity === "ok").length,
    warn: all.filter((c) => c.severity === "warn").length,
    fail: all.filter((c) => c.severity === "fail").length,
    unknown: all.filter((c) => c.severity === "unknown").length,
  };
  summary.worst = worstOf(all.map((c) => c.severity));
  /*
    The headline states the count and never a grade. "Healthy" is a claim about
    everything, including what this file does not look at — and the checks it
    does run are a list of failures that have happened, not a proof that none
    can.
  */
  summary.headline =
    summary.fail > 0
      ? `${summary.fail} broken`
      : summary.warn > 0
        ? `${summary.warn} need${summary.warn === 1 ? "s" : ""} attention`
        : summary.unknown > 0
          ? `Nothing wrong found · ${summary.unknown} could not be checked`
          : "Nothing needs attention";

  return {
    checkedAt: new Date(startedAt).toISOString(),
    tookMs: Date.now() - startedAt,
    summary,
    groups,
  };
}

export async function health({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.value, ageMs: Date.now() - cached.at };
  }
  if (inFlight) return { ...(await inFlight), ageMs: 0 };
  inFlight = compute()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return { ...(await inFlight), ageMs: 0 };
}
