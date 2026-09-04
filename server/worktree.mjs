// Keep the worktree jobs run in from silently falling behind main.
//
// ## What went wrong
//
// `OPERATOR_JOB_CWD` sends every job's process into a separate git worktree, so
// an agent's half-finished edits are invisible to the running server until the
// branch is merged. That isolation is deliberate and good — `CLAUDE.md` has the
// argument, and it exists because `main` twice ended up unable to restart.
//
// Nothing kept it in sync. On 2026-09-03 it was **183 commits behind**, which
// meant every job ran against a copy of Operator from two weeks earlier: no
// work log, no vault actions, no delegate. Operator worked it out itself and
// said so — "The agent worktree is way behind main — the capability layer lives
// there. Running from main." — after spending turns and permission prompts
// discovering it.
//
// The same drift caused the semantic-verification bug fixed earlier the same
// day: every job was reviewed against that worktree's stale uncommitted diff.
// One cause, two symptoms, days apart.
//
// ## What this does
//
// Fast-forwards the worktree to main when that is SAFE, and says so loudly when
// it is not. Never merges, never rebases, never discards: `--ff-only` on a
// clean tree either works or refuses, and a refusal is reported rather than
// escalated. Losing an agent's uncommitted work to an automatic sync would be a
// far worse failure than the drift it was fixing.
//
// No dependencies.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const git = async (cwd, args) => {
  const { stdout } = await run("git", args, { cwd, timeout: 15_000 });
  return stdout.trim();
};

/**
 * Where the worktree stands relative to main.
 *
 * @returns {Promise<{ok: boolean, cwd: string, branch?: string, behind?: number,
 *                    ahead?: number, unlanded?: string[], dirty?: string[],
 *                    reason?: string}>}
 */
export async function state(cwd) {
  if (!cwd) return { ok: false, cwd, reason: "no job worktree configured" };
  try {
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const behind = Number(await git(cwd, ["rev-list", "--count", "HEAD..main"])) || 0;
    /*
      AHEAD is the half this file was missing, and it cost a day.

      `behind` answers "is the agent running old code". It says nothing about
      the opposite and more expensive failure: work FINISHED in here that never
      reached main. On 2026-09-04 the chat-uploads fix was built twice, marked
      done, and sat here across four full restarts — each one loading a build
      that had never contained it, so the fix looked broken rather than absent.
      Nothing was lost and nothing was stale; it simply had not landed, and no
      check asked that question.
    */
    const ahead = Number(await git(cwd, ["rev-list", "--count", "main..HEAD"])) || 0;
    /** Subjects, so a card or a check can say WHAT is stranded rather than a count. */
    const unlanded = ahead
      ? (await git(cwd, ["log", "--format=%h %s", "main..HEAD"])).split("\n").filter(Boolean)
      : [];
    /*
      Untracked files count as dirty here, and that is not pedantry.

      A fast-forward refuses when an untracked file would be overwritten by a
      tracked one arriving from main — which is exactly what blocked the first
      attempt at this, on a worktree that `git status` otherwise called clean.
    */
    const dirty = (await git(cwd, ["status", "--porcelain"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: true, cwd, branch, behind, ahead, unlanded, dirty };
  } catch (err) {
    return { ok: false, cwd, reason: String(err?.message ?? err) };
  }
}

/**
 * Bring the worktree up to main, if that can be done without losing anything.
 *
 * @param {string} cwd
 * @param {boolean} busy  true when a job is running in there — never touch it
 */
export async function sync(cwd, busy = false) {
  const s = await state(cwd);
  if (!s.ok) return { ...s, synced: false };
  if (s.behind === 0) return { ...s, synced: false, reason: "already up to date" };

  if (busy) {
    return { ...s, synced: false, reason: "a job is running in the worktree" };
  }
  if (s.dirty.length > 0) {
    /*
      Refused, and the files are named.

      An automatic sync that stashed or discarded would eventually eat
      something an agent was halfway through, and the drift this prevents is
      recoverable while that is not.
    */
    return { ...s, synced: false, reason: `uncommitted changes: ${s.dirty.join(", ")}` };
  }

  try {
    await git(cwd, ["merge", "--ff-only", "main"]);
    const after = await state(cwd);
    return { ...after, synced: true };
  } catch (err) {
    return { ...s, synced: false, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

/**
 * Put the worktree's uncommitted work somewhere it can be got back.
 *
 * ## Stash, never discard — and that is not a softer version of the request
 *
 * "Clear the dirty tree" means `checkout -- .` plus `clean -fd` to most people,
 * and both are UNRECOVERABLE: uncommitted work is not in git, so there is no
 * reflog, no revert, nothing. This project has no undo (OPS-020) and CLAUDE.md
 * is explicit that a dirty file you did not write is someone else's work rather
 * than noise to sweep up.
 *
 * `git stash push -u` achieves the only thing the caller actually needs — a
 * clean tree, so a sync or a land stops being refused — and the work survives.
 * The repo already uses stash exactly this way: `stash@{0}` in the worktree
 * holds an AGENTS.md from 2026-09-03. The ref is returned so it can be quoted
 * back, because a recovery nobody knows how to perform is not much better than
 * a deletion.
 *
 * @param {string} cwd
 * @param {string} why  goes into the stash message, so the list is readable later
 */
export async function stash(cwd, why = "cleared to unblock a sync") {
  const s = await state(cwd);
  if (!s.ok) return { ...s, stashed: false };
  if (!s.dirty.length) return { ...s, stashed: false, reason: "nothing to stash — the tree is clean" };

  try {
    const message = `operator: ${String(why).slice(0, 80)}`;
    await git(cwd, ["stash", "push", "--include-untracked", "-m", message]);
    const after = await state(cwd);
    const list = (await git(cwd, ["stash", "list"])).split(String.fromCharCode(10)).filter(Boolean);
    return {
      ...after,
      stashed: true,
      stashedFiles: s.dirty,
      ref: list[0] ? list[0].split(":")[0] : "stash@{0}",
      restore: `git -C ${cwd} stash pop`,
    };
  } catch (err) {
    return { ...s, stashed: false, reason: String(err?.message ?? err).split(String.fromCharCode(10))[0] };
  }
}

/**
 * Put the worktree's FINISHED work onto main — the step nothing automated.
 *
 * ## What this is allowed to do, and what it deliberately is not
 *
 * It fast-forwards main to the worktree's branch. It does NOT commit: only work
 * already committed in there can land, and that is the load-bearing constraint
 * rather than an implementation detail. An auto-lander that staged everything
 * would have swept `server/roblox-studio.mjs` in half-finished on 2026-09-04,
 * alongside an `actions.mjs` that imports it at the top level — a server that
 * does not boot, landed automatically, on main.
 *
 * So: the agent decides what is finished by committing it, by name. This moves
 * what it already stood behind.
 *
 * Fast-forward only, and main must be clean — both for the reason `land.mjs`
 * gives: two sessions write to this repo, and a dirty main is someone else's
 * work in progress.
 *
 * @param {string} cwd       the worktree
 * @param {string} mainCwd   the main checkout
 * @param {boolean} busy     true when a job is running in there
 */
export async function land(cwd, mainCwd, busy = false) {
  const s = await state(cwd);
  if (!s.ok) return { ...s, landed: false };
  if (busy) return { ...s, landed: false, reason: "a job is running in the worktree" };
  if (!s.ahead) {
    return { ...s, landed: false, reason: "nothing to land — main already has every commit from here" };
  }

  const mainDirty = (await git(mainCwd, ["status", "--porcelain"]))
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter(Boolean);
  if (mainDirty.length) {
    return {
      ...s,
      landed: false,
      reason: `main has uncommitted changes (${mainDirty.join(", ")}) — that is someone else's work, not noise to merge over`,
    };
  }

  try {
    // Refuses unless main is an ancestor. A merge commit made by an agent onto
    // main, unreviewed, is the thing this whole worktree arrangement prevents.
    await git(mainCwd, ["merge", "--ff-only", s.branch]);
  } catch (err) {
    return { ...s, landed: false, reason: `not a fast-forward: ${String(err?.message ?? err).split(String.fromCharCode(10))[0]}` };
  }

  /*
    Which command makes it real, decided from the DIFF rather than guessed.

    CLAUDE.md's table: `src/` needs a build, `server/` needs a restart, and
    getting this wrong is the failure that looks like the fix not working —
    which is exactly what the landed commit was fixing.
  */
  const files = (await git(mainCwd, ["show", "--name-only", "--format=", "HEAD"]))
    .split(String.fromCharCode(10))
    .filter(Boolean);
  const touchedSrc = files.some((f) => f.startsWith("src/"));
  const touchedServer = files.some((f) => f.startsWith("server/"));

  return {
    ...(await state(cwd)),
    landed: true,
    commits: s.unlanded,
    takesEffect: touchedServer
      ? "a FULL restart — server/ is loaded at boot, so nothing here is live until then"
      : touchedSrc
        ? "npm --prefix <main> run build — dist/ is read per request, no restart needed"
        : "nothing to run — no src/ or server/ files changed",
    needsRestart: touchedServer,
    needsBuild: touchedSrc && !touchedServer,
  };
}

/**
 * One line for the worker's system prompt, or "" when there is nothing to say.
 *
 * This is the part that would have saved the turns: Operator worked out that
 * its own capability layer was missing by trying to use it and failing. Being
 * told up front is cheaper than discovering it, and far cheaper than the wrong
 * conclusion — that the action does not exist.
 */
export function warningFor(s) {
  if (!s?.ok || !s.behind) return "";
  return (
    `WARNING: the worktree you are running in is ${s.behind} commit(s) behind main` +
    (s.dirty?.length ? ` and has uncommitted changes (${s.dirty.slice(0, 5).join(", ")})` : "") +
    `. Capability actions, scripts and server code added recently may be MISSING here. ` +
    `If an action or script does not exist, that is why — say so and ask for the worktree ` +
    `to be synced rather than working around it or concluding the feature is absent.`
  );
}
