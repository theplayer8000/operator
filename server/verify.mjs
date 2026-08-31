// Check the work, so "complete" means something.
//
// ## Why this exists
//
// Every job has recorded `verification: { status: "not-run" }` since the job
// model was written, and it has never once been anything else. The owner has
// been the verifier: he reads the result and decides whether it was right.
//
// That is fine while every job starts with him typing, and it is the thing
// standing between Operator and anything proactive. A presence layer that
// speaks first — or a trigger that fires hourly, or two workers running at once
// — is by definition acting unwatched, and unwatched work that nobody checks is
// how a confident wrong answer becomes a committed one.
//
// ## What it checks, and why only this
//
// The cheapest honest version, which is the one ADR 0014 already identified: a
// job that changed code is not complete until the project's own gates pass.
//
//   .ts / .tsx changed   ->  npx tsc -b   and   npx vite build
//   .mjs changed         ->  node --check on each file
//
// Deliberately NOT a model reviewing a diff. This layer is deterministic: it
// has no false positives, needs no tokens, and cannot hallucinate a problem. A
// semantic verifier — does this change match what was asked? — is the next
// layer and belongs to the local model, but a layer that can be wrong should
// sit on top of one that cannot.
//
// ## The `server/` gap, closed
//
// `CLAUDE.md` says it outright: **neither gate looks at `server/`**. `tsc` and
// `vite build` never read a `.mjs` file, so a clean build says nothing
// whatsoever about a server change. That has always been left to a human
// remembering. It is checked here.
//
// And it uses the REAL node binary, not the one on PATH — `D:\projects\
// node_modules\.bin\node` shadows it and fails SILENTLY, exiting 0 having run
// nothing. A verifier that can be silently satisfied is worse than none, which
// is why the path is resolved rather than assumed.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Longer than any of these take, short enough that a hang is not a hang forever. */
const CHECK_TIMEOUT_MS = 240_000;

/*
  The real node, because the one on PATH may not be.

  CLAUDE.md documents this as a landmine: a `node` one directory above the repo
  shadows the real binary and points at a POSIX path that does not exist on
  Windows. `node --check` then exits 0 having checked nothing at all, so a
  session that verifies with it has verified nothing and will be told
  everything is fine.
*/
const NODE_CANDIDATES = [
  process.env.OPERATOR_NODE,
  "C:\\Program Files\\nodejs\\node.exe",
  process.execPath,
].filter(Boolean);

function realNode() {
  return NODE_CANDIDATES.find((p) => p === process.execPath || existsSync(p)) ?? process.execPath;
}

/** What a job actually touched, from git rather than from what it claimed. */
async function changedFiles(cwd) {
  const { stdout } = await run("git", ["status", "--porcelain"], { cwd, timeout: 20_000 });
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    // A rename reads as "old -> new"; the new path is the one to check.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ")[1] : path))
    .map((path) => path.replace(/^"|"$/g, ""));
}

async function check(name, command, args, cwd) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(command, args, { cwd, timeout: CHECK_TIMEOUT_MS });
    return {
      name,
      passed: true,
      ms: Date.now() - started,
      output: `${stdout}${stderr}`.trim().slice(-400),
    };
  } catch (err) {
    /*
      The failure OUTPUT is the point, not the exit code. "tsc failed" tells
      nobody anything; the three lines naming the file and the type error are
      what makes a verdict actionable, and they arrive on stdout rather than in
      the error message.
    */
    const detail = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() || String(err?.message ?? err);
    return { name, passed: false, ms: Date.now() - started, output: detail.slice(-1200) };
  }
}

/**
 * Verify whatever a job left behind in `cwd`.
 *
 * @returns {Promise<{status: "passed"|"failed"|"skipped", checks: object[], changed: string[], note: string}>}
 *   `skipped` when nothing was changed — which is the common case and is not a
 *   failure. A job that answered a question has nothing to build.
 */
export async function verifyWorkspace(cwd) {
  if (!cwd || !existsSync(cwd)) {
    return { status: "skipped", checks: [], changed: [], note: `no workspace at ${cwd}` };
  }

  let changed = [];
  try {
    changed = await changedFiles(cwd);
  } catch (err) {
    return {
      status: "skipped",
      checks: [],
      changed: [],
      note: `could not read git status: ${String(err?.message ?? err).slice(0, 200)}`,
    };
  }

  if (changed.length === 0) {
    return {
      status: "skipped",
      checks: [],
      changed: [],
      note: "nothing was changed, so there is nothing to build",
    };
  }

  const frontend = changed.filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("server/"));
  const scripts = changed.filter((f) => /\.mjs$/.test(f));

  const checks = [];

  /*
    Syntax-check the server files FIRST, and one at a time.

    They are the fastest check and the one that catches the worst failure: a
    `server/*.mjs` that does not parse takes the whole storage server down at
    the next restart, and neither tsc nor vite would ever have looked at it.
    Running it first means a broken server is reported in a second rather than
    after four minutes of building a frontend that was fine.
  */
  for (const file of scripts) {
    if (!existsSync(`${cwd}/${file}`)) continue; // deleted, nothing to parse
    checks.push(await check(`node --check ${file}`, realNode(), ["--check", file], cwd));
  }

  if (frontend.length > 0) {
    checks.push(await check("npx tsc -b", "npx", ["tsc", "-b"], cwd));
    // Only build if the types are sound: vite would fail for the same reason
    // and take four minutes to say so.
    if (checks.at(-1)?.passed) {
      checks.push(await check("npx vite build", "npx", ["vite", "build"], cwd));
    }
  }

  if (checks.length === 0) {
    return {
      status: "skipped",
      checks: [],
      changed,
      note: `${changed.length} file(s) changed, none of them code the gates cover`,
    };
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    status: failed.length === 0 ? "passed" : "failed",
    checks,
    changed,
    note:
      failed.length === 0
        ? `${checks.length} check(s) passed over ${changed.length} changed file(s)`
        : `${failed.map((c) => c.name).join(", ")} failed`,
  };
}
