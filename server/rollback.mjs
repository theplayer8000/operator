// Undo a land that made things worse.
//
// ## Why this exists
//
// Landing is about to become something Operator can do to itself — the agent
// commits in its worktree, a card asks, main fast-forwards. That closes the gap
// where finished work sat stranded for a day. It also means main can now move
// without a person typing the command, and the honest response to that is a way
// back, not more confidence on the way forward.
//
// The failure being planned for is specific and has happened twice: a change to
// `server/` lands, the server is restarted, and it does not come back. At that
// moment the app is down, the phone is the only terminal, and the person is
// probably not at the desk. This is the action for that moment.
//
// ## Why reset and not revert
//
// Reverting is the polite answer and it is the wrong one here, because it moves
// FORWARD: a new commit, which still has to be landed, built or restarted before
// anything improves. When the server will not start, the goal is for the tree to
// be what it was ten minutes ago, and `reset --hard` is the only thing that says
// that directly.
//
// That is safe **only while the commit has not been published**, which is the
// first guard below. Once something is on the remote, rewriting is antisocial in
// a way no local convenience justifies, and `revert` genuinely is the right tool
// — so this refuses and says so rather than quietly doing the dangerous thing.
//
// ## The four guards
//
//   1. **Never rewrite pushed history.** If the commit being dropped is an
//      ancestor of `origin/main`, refuse and name `git revert` instead.
//   2. **Backwards only.** The target must be an ancestor of HEAD. This cannot
//      be steered onto an arbitrary commit, so it cannot be used to move main
//      somewhere it has never been.
//   3. **Stash before resetting.** `reset --hard` discards uncommitted work
//      unrecoverably. Anything dirty is stashed first and the ref is returned.
//   4. **Say how to undo the undo.** The pre-reset SHA is reported, because a
//      recovery tool whose own effect cannot be reversed is just a second way
//      to lose work.
//
// No dependencies.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const NL = String.fromCharCode(10);

const git = async (cwd, args) => {
  const { stdout } = await run("git", args, { cwd, timeout: 15_000 });
  return stdout.trim();
};

/** True when `sha` is already reachable from the remote branch. */
async function isPublished(cwd, sha) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", sha, "origin/main"]);
    return true;
  } catch {
    // Non-zero also means "no origin/main ref at all", which is the same answer
    // for our purposes: nothing has been published, so nothing can be rewritten.
    return false;
  }
}

/**
 * Move main back to a commit it has already been on.
 *
 * @param {string} cwd            the main checkout
 * @param {{steps?: number, to?: string}} opts
 *        `steps` walks back N commits (default 1). `to` names a commit instead.
 */
export async function rollback(cwd, { steps = 1, to } = {}) {
  let head, target;
  try {
    head = await git(cwd, ["rev-parse", "HEAD"]);
    const n = Math.max(1, Math.min(Number(steps) || 1, 20));
    target = await git(cwd, ["rev-parse", to ? String(to) : `HEAD~${n}`]);
  } catch (err) {
    return { rolledBack: false, reason: `could not resolve that commit: ${String(err?.message ?? err).split(NL)[0]}` };
  }

  if (target === head) {
    return { rolledBack: false, reason: "that is already where main is" };
  }

  // Guard 2 — backwards only.
  try {
    await git(cwd, ["merge-base", "--is-ancestor", target, head]);
  } catch {
    return {
      rolledBack: false,
      reason: "refusing: that commit is not an ancestor of main, so this would move main somewhere it has never been rather than undo something",
    };
  }

  // Guard 1 — never rewrite what has been published.
  const dropping = (await git(cwd, ["log", "--format=%h %s", `${target}..HEAD`])).split(NL).filter(Boolean);
  for (const line of dropping) {
    const sha = line.split(" ")[0];
    if (await isPublished(cwd, sha)) {
      return {
        rolledBack: false,
        published: sha,
        reason:
          `refusing: ${sha} is already on origin/main. Rewriting published history is not this action's to do — ` +
          `use \`git revert ${sha}\` instead, which undoes the change by moving forward.`,
        dropping,
      };
    }
  }

  // Guard 3 — nothing uncommitted is destroyed.
  const dirty = (await git(cwd, ["status", "--porcelain"])).split(NL).map((l) => l.trim()).filter(Boolean);
  let stashRef = null;
  if (dirty.length) {
    try {
      await git(cwd, ["stash", "push", "--include-untracked", "-m", `operator: before rollback from ${head.slice(0, 7)}`]);
      const list = (await git(cwd, ["stash", "list"])).split(NL).filter(Boolean);
      stashRef = list[0] ? list[0].split(":")[0] : "stash@{0}";
    } catch (err) {
      return { rolledBack: false, reason: `could not stash uncommitted work, so refusing to reset over it: ${String(err?.message ?? err).split(NL)[0]}` };
    }
  }

  try {
    await git(cwd, ["reset", "--hard", target]);
  } catch (err) {
    return { rolledBack: false, reason: String(err?.message ?? err).split(NL)[0], stashRef };
  }

  /*
    What has to happen for the rollback to be VISIBLE, from the diff.

    Same reasoning as land(): undoing a server/ change does nothing at all until
    the process is restarted, and a rollback that appears to have worked while
    the broken code is still in memory is the worst possible outcome for the one
    situation this exists for.
  */
  const files = (await git(cwd, ["diff", "--name-only", `${target}..${head}`])).split(NL).filter(Boolean);
  const touchedServer = files.some((f) => f.startsWith("server/"));
  const touchedSrc = files.some((f) => f.startsWith("src/"));

  return {
    rolledBack: true,
    from: head.slice(0, 7),
    to: target.slice(0, 7),
    dropped: dropping,
    stashRef,
    // Guard 4 — the pre-reset SHA, so this is itself reversible.
    undo: `git -C ${cwd} reset --hard ${head.slice(0, 7)}`,
    takesEffect: touchedServer
      ? "a FULL restart — the old server code is still in memory until then"
      : touchedSrc
        ? "npm run build in the main checkout"
        : "nothing to run",
    needsRestart: touchedServer,
    needsBuild: touchedSrc && !touchedServer,
  };
}
