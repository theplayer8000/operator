// Land the agent branch on main — merge, then build or restart, whichever the
// diff actually calls for.
//
// ## Why this exists
//
// The sequence is four steps, three of them conditional, and getting one wrong
// fails silently in the worst direction. From `CLAUDE.md`:
//
//   - `npm run build` in the WRONG checkout writes a `dist/` nothing serves.
//     The command succeeds, the output looks right, and the live app is
//     unchanged — so the next move is hunting a bug in code that never shipped.
//   - Building before merging rebuilds the old code, for the same reason.
//   - `src/` needs a build and no restart; `server/` needs a restart and no
//     build. Doing the other one looks like the change did nothing.
//
// So the decision is mechanical, which makes it a script's job rather than
// something to re-derive at 10pm. It reads the diff and picks.
//
// ## What it will not do
//
// **It never pushes.** Not a missing feature — `git push` is denied to the
// agent session by design (publishing is public and permanent), and a script
// that pushed on its behalf would be a way around that rather than a
// convenience. It prints the command for a person to run.
//
// **It never merges anything but a fast-forward.** `--ff-only` on a clean tree
// either works or refuses, and a refusal is reported rather than escalated —
// same bargain `server/worktree.mjs` strikes going the other way. A real merge
// with conflicts is a judgement call, and this has none.
//
// **It never touches a dirty main.** Two sessions write to this repo. An
// unexpected modified file in the main checkout is someone else's work in
// flight, not noise to sweep up — that is the `git add -A` failure that cost a
// revert, wearing a different hat.
//
// No dependencies. Node built-ins only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const DRY = has("--check") || has("--dry-run");
const SKIP_BUILD = has("--no-build");
const RESTART = has("--restart");

/** The branch being landed. Defaults to whichever one this checkout is on. */
const BRANCH = argv.find((a) => !a.startsWith("-")) ?? null;

const say = (line = "") => console.log(line);
const step = (line) => console.log(`[land] ${line}`);

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, timeout: 20_000 });
  return stdout.trim();
}

function fail(message, hint = null) {
  console.error(`[land] ${message}`);
  if (hint) console.error(`       ${hint}`);
  process.exit(1);
}

/**
 * Find the checkout that has `main` out.
 *
 * Asked of git rather than hardcoded to `D:\Projects\Operator`. This machine is
 * not the only place this will ever run — the whole project moves to the EPYC
 * box eventually — and a path baked into a script is the kind of thing that is
 * still there, wrong, two years later. `OPERATOR_MAIN_CWD` overrides.
 */
async function findMainCheckout(here) {
  if (process.env.OPERATOR_MAIN_CWD) return process.env.OPERATOR_MAIN_CWD;
  const listing = await git(here, ["worktree", "list", "--porcelain"]);
  let path = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    if (line.trim() === "branch refs/heads/main" && path) return path;
  }
  return null;
}

/**
 * Split a checkout's dirt into the two kinds, because they mean different
 * things when merging INTO it.
 *
 * `tracked` — modified or staged files under version control. Someone's work in
 * flight; landing on top of it is the `git add -A` failure in another costume.
 *
 * `untracked` — scratch files, a stray folder, `.agents/`. Harmless unless an
 * incoming commit adds a tracked file at the same path, in which case git's own
 * `--ff-only` refuses and says so. Treating every untracked file as a blocker
 * (which `worktree.mjs` does, correctly, for the other direction) would mean
 * one long-lived scratch folder disables this tool permanently — and a tool that
 * cries wolf on day one is one nobody runs on day two.
 */
async function dirtyFiles(cwd) {
  const lines = (await git(cwd, ["status", "--porcelain"]))
    .split("\n")
    .filter((l) => l.trim());
  return {
    tracked: lines.filter((l) => !l.startsWith("??")).map((l) => l.trim()),
    untracked: lines.filter((l) => l.startsWith("??")).map((l) => l.trim()),
    all: lines.map((l) => l.trim()),
  };
}

/**
 * What a set of changed paths means for the running app.
 *
 * The table in CLAUDE.md, in code. `src/` is read from `dist/` off disk per
 * request, so a build is enough and a restart is pointless; `server/` is loaded
 * into memory at boot, so a restart is required and a build does nothing.
 */
function consequences(files) {
  return {
    needsBuild: files.some((f) => f.startsWith("src/") || f === "index.html"),
    /*
      `server/` only. `scripts/` is deliberately NOT here — those are spawned
      fresh each time they run, so a change to one is live immediately, and a
      restart prompt that fires when nothing needs restarting is how a warning
      becomes something you click past without reading.

      The one exception is `scripts/supervise.mjs`, which IS the running
      process. Rare enough to leave to a person who is already thinking about it.
    */
    needsRestart: files.some((f) => f.startsWith("server/")),
  };
}

const here = process.cwd();

const branch = BRANCH ?? (await git(here, ["rev-parse", "--abbrev-ref", "HEAD"]));
if (branch === "main") {
  fail("already on main — there is nothing to land.", "Run this from the agent worktree.");
}

const mainCwd = await findMainCheckout(here);
if (!mainCwd) {
  fail(
    "could not find a checkout with main out.",
    "Set OPERATOR_MAIN_CWD to it, or run `git worktree list` to see what git thinks exists.",
  );
}

step(`landing ${branch} → main (${mainCwd})`);

// --- what is actually there to land ---------------------------------------

const ahead = Number(await git(here, ["rev-list", "--count", `main..${branch}`])) || 0;
const behind = Number(await git(here, ["rev-list", "--count", `${branch}..main`])) || 0;

if (ahead === 0) {
  step("nothing to land — main already has everything on this branch.");
  process.exit(0);
}

/*
  Behind means this is not a fast-forward, and the fix is on the agent's side.
  Rebasing here would be this script making a history decision on its own; it
  says what to run instead.
*/
if (behind > 0) {
  fail(
    `${branch} is ${behind} commit(s) behind main, so this cannot fast-forward.`,
    `Run \`git rebase main\` here first, then try again.`,
  );
}

const files = (await git(here, ["diff", "--name-only", `main..${branch}`]))
  .split("\n")
  .filter(Boolean);
const { needsBuild, needsRestart } = consequences(files);

say();
step(`${ahead} commit(s), ${files.length} file(s):`);
for (const line of (await git(here, ["log", "--oneline", `main..${branch}`])).split("\n")) {
  say(`       ${line}`);
}
say();

// --- refuse rather than sweep ---------------------------------------------

const mine = await dirtyFiles(here);
if (mine.all.length) {
  /*
    Warned, not blocked. The commits are what land; uncommitted files stay
    exactly where they are. But "I ran the thing and my change is not live" has
    one obvious cause and this is it, so it gets said out loud.
  */
  step(`note: ${mine.all.length} uncommitted file(s) here will NOT land:`);
  for (const f of mine.all) say(`       ${f}`);
  say();
}

const theirs = await dirtyFiles(mainCwd);
if (theirs.tracked.length) {
  console.error(`[land] main's checkout has uncommitted changes — refusing to merge into it.`);
  for (const f of theirs.tracked) console.error(`       ${f}`);
  console.error(
    `       Two sessions write to this repo. Look at those before landing on top of them.`,
  );
  process.exit(1);
}
if (theirs.untracked.length) {
  // Not a blocker, but worth one line: if the merge is going to trip over one
  // of these, this is the context that makes git's refusal make sense.
  step(`main has ${theirs.untracked.length} untracked path(s), left alone: ${theirs.untracked.join(", ")}`);
}

if (DRY) {
  step("check only — nothing changed.");
  step(`would merge, then ${needsBuild ? "build" : "not build"}, ${needsRestart ? "restart needed" : "no restart needed"}.`);
  process.exit(0);
}

// --- land it ---------------------------------------------------------------

try {
  await git(mainCwd, ["merge", "--ff-only", branch]);
} catch (err) {
  fail(
    `merge refused: ${String(err?.message ?? err).split("\n").find((l) => l.trim()) ?? "unknown"}`,
    "Nothing was changed. Resolve it by hand in the main checkout.",
  );
}
step(`merged — main is now at ${await git(mainCwd, ["rev-parse", "--short", "HEAD"])}`);

// --- build, only if and only where it matters ------------------------------

if (needsBuild && !SKIP_BUILD) {
  step("src/ changed — building in the main checkout (this takes a moment)…");
  try {
    /*
      The build, run WITHOUT npm — measured, not preferred.

      `execFile("npm.cmd", …)` throws `spawn EINVAL` on Node 24: since the 2024
      argument-injection fix, a `.bat`/`.cmd` cannot be spawned without a shell.
      That is the same EINVAL CLAUDE.md warns about for the terminal, and the
      answer is the same — not `shell: true`, but calling the real executable.

      It mattered more here than usual because of WHERE it failed: after the
      merge. `git merge --ff-only` had already run, so main was advanced and
      then the script died on the step that keeps `dist/` in step with it,
      leaving exactly the stale-build state the whole script exists to prevent.

      `npm run build` is `tsc -b && vite build`, so this runs those two through
      `process.execPath` — the node actually running this script, never the
      broken shim on PATH — against the MAIN checkout's own node_modules. The
      `--prefix` trap the old comment describes is handled by `cwd` instead.
    */
    const steps = [
      ["type check", ["node_modules/typescript/bin/tsc", "-b"]],
      ["build", ["node_modules/vite/bin/vite.js", "build"]],
    ];
    let stdout = "";
    let stderr = "";
    for (const [what, argv] of steps) {
      step(`  ${what}…`);
      const res = await run(process.execPath, argv, {
        cwd: mainCwd,
        timeout: 10 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout += res.stdout ?? "";
      stderr += res.stderr ?? "";
    }
    const tail = `${stdout}${stderr}`.trim().split("\n").slice(-3).join("\n");
    step("build clean.");
    if (tail) say(`       ${tail.replace(/\n/g, "\n       ")}`);
  } catch (err) {
    /*
      The merge already happened and is not unwound. A broken build on main is
      visible and fixable; a script that silently reverted a merge to protect
      the owner from his own code would be much harder to reason about.
    */
    console.error(`[land] BUILD FAILED — main has the merge but dist/ is stale.`);
    console.error(String(err?.stdout ?? "").trim().split("\n").slice(-20).join("\n"));
    console.error(String(err?.stderr ?? "").trim().split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
} else if (needsBuild) {
  step("src/ changed but --no-build was passed — dist/ is stale until you build.");
} else {
  step("no src/ change — no build needed.");
}

// --- what is left for a person --------------------------------------------

say();
if (needsRestart) {
  if (RESTART) {
    step("server/ changed — restarting…");
    try {
      /*
        Loopback, which auth.mjs trusts, and the supervisor's exit-75 relaunch
        is what actually brings it back. Opt-in with --restart: a restart drops
        every job's event log, so it is a deliberate act rather than a step a
        script takes on someone's behalf.
      */
      const res = await fetch("http://127.0.0.1:5174/api/restart", { method: "POST" });
      step(res.ok ? "restart requested — it comes back in a second or two." : `restart returned ${res.status}; use the Dev page button.`);
    } catch {
      step("could not reach the API — use the Restart button on the Dev page.");
    }
  } else {
    step("server/ changed — RESTART needed before this is live.");
    say("       The Dev page's Restart button, or re-run with --restart.");
    say("       Note: a restart wipes every job's event log. CURRENT.md survives it.");
  }
} else {
  step("no server/ change — nothing to restart.");
}

say();
step("left for you, because the agent session is never allowed to run it:");
say();
say("    git push origin main");
say();
