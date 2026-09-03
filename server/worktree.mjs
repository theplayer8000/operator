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
 *                    dirty?: string[], reason?: string}>}
 */
export async function state(cwd) {
  if (!cwd) return { ok: false, cwd, reason: "no job worktree configured" };
  try {
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const behind = Number(await git(cwd, ["rev-list", "--count", "HEAD..main"])) || 0;
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
    return { ok: true, cwd, branch, behind, dirty };
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
