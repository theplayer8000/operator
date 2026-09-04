// A full restart, asked for from a phone.
//
// The in-server half of the pair; `scripts/restart-operator.mjs` is the half
// that outlives this process. Read that file's header for why the split exists
// at all — the short version is that the supervisor hands the child the
// environment IT was started with, so only the launcher re-reads a key set with
// `secret_set`.
//
// ## Soft, and what that actually buys
//
// There is no SIGINT handler anywhere in `server/`, so until now every full
// restart was a kill. The store survives that — `store.mjs` writes tmp-then-
// rename on every call, so nothing is buffered — but a RUNNING TURN does not.
// It is abandoned mid-flight, its job left recorded as running, its worker
// process orphaned.
//
// So the soft part is not a longer timeout. It is: stop taking new turns,
// cancel the live ones properly so they are recorded as cancelled and their
// workers are halted, persist, and only then exit.
//
// ## Why exit 0 and not 75
//
// 75 asks the supervisor to start the child again — that is the shallow restart
// this exists to replace. Any other code makes the supervisor exit too
// (`scripts/supervise.mjs`), which is what we want: both processes gone, and
// the launcher starts them fresh.
//
// No dependencies.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELPER = join(ROOT, "scripts", "restart-operator.mjs");

/** Once armed, further requests are refused rather than stacking. */
let pending = false;

/**
 * The phrase that has to be said as well as meant.
 *
 * A second check on top of the device gate, and it checks a DIFFERENT thing:
 * the gate answers "is this him", this answers "did he mean it". Those fail
 * separately — a mis-tap on a trusted phone passes the gate and should still
 * not take Operator down, and voice makes that likelier rather than less,
 * because a sentence about restarting and an instruction to restart sound
 * identical to a model.
 *
 * **Set `OPERATOR_RESTART_PHRASE` and it stops being a confirmation and
 * becomes a second factor** — something only he knows, which a worker cannot
 * read out of the repository and cannot guess from this file. Environment-only
 * for the reason `OPERATOR_TERMINAL_DEVICES` is: a worker has Write across the
 * tree, so a phrase stored on disk is a phrase the agent can grant itself.
 *
 * Unset, the default below is deliberately NOT a secret and is quoted back in
 * the refusal. That is the GitHub "type the repository name" model: it stops an
 * accident, and it is honest about stopping nothing else.
 */
const DEFAULT_PHRASE = "restart operator now";
const PHRASE = (process.env.OPERATOR_RESTART_PHRASE ?? "").trim() || DEFAULT_PHRASE;
const PHRASE_IS_SECRET = Boolean((process.env.OPERATOR_RESTART_PHRASE ?? "").trim());

export class RestartRefused extends Error {}

/**
 * Compare loosely enough to survive being spoken.
 *
 * Transcription gives back capitalisation and punctuation that were never in
 * the room, so a strict compare would fail on "Restart Operator now." — and a
 * confirmation that rejects the correct answer teaches him to route around it.
 * Case, punctuation and repeated spaces are ignored; the WORDS must match.
 */
function saidIt(given) {
  const flatten = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return flatten(given) === flatten(PHRASE);
}

/**
 * Stop everything gracefully and have the launcher start it again.
 *
 * Returns immediately with what it is about to do. The caller's HTTP response
 * has to be written and flushed before this process exits, so the actual work
 * is scheduled rather than awaited — the same reason `/api/restart` defers its
 * own exit.
 */
export async function fullRestart({ reason = "restart requested", graceMs = 20_000, confirm } = {}) {
  if (!saidIt(confirm)) {
    throw new RestartRefused(
      PHRASE_IS_SECRET
        ? "that is not the restart phrase. Say or pass the exact phrase in `confirm`. It is not written down anywhere Operator can read, which is the point."
        : `restarting needs confirming. Pass confirm: "${PHRASE}" — say it or type it. Set OPERATOR_RESTART_PHRASE to make this a phrase only you know instead of one printed here.`,
    );
  }
  if (pending) {
    return { restarting: true, alreadyRequested: true, note: "a restart is already in progress" };
  }
  pending = true;

  /*
    The helper is spawned FIRST, before anything is stopped.

    If it were spawned after the graceful shutdown began, a shutdown that hung
    would leave nothing to bring the server back — and the failure mode of a
    restart action is the one that matters most, because the owner is usually
    not at the machine when he uses it.

    `detached` + `stdio: "ignore"` + `unref()` are all three required: without
    detaching it dies with this process on Windows, and an inherited stdio
    handle keeps a pipe open to a parent that is about to disappear.
  */
  const child = spawn(process.execPath, [HELPER, String(graceMs)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: ROOT,
  });
  child.unref();

  // Scheduled, not awaited — see the doc comment.
  setTimeout(() => void shutdown(reason), 250);

  return {
    restarting: true,
    graceSeconds: graceMs / 1000,
    note: "Running turns are cancelled and saved first, then the launcher starts Operator again so it re-reads the environment. Event logs do not survive; job tabs do. Watch data/serve.log for [restart] lines.",
  };
}

async function shutdown(reason) {
  try {
    /*
      Cancel live work through the job runner rather than just exiting.

      `stopAll` marks each job cancelled, halts its worker, drops queued turns
      and clears parked permission questions. Skipping it is what leaves a job
      recorded as "running" forever after a restart, with nothing running.

      Imported lazily: jobs.mjs is a heavy module and a circular import here
      would be easy to create by accident.
    */
    const jobs = await import("./jobs.mjs");
    const stopped = jobs.stopAll(reason);
    if (stopped.stopped) console.log(`[operator] restart: cancelled ${stopped.stopped} job(s)`);
  } catch (err) {
    // A restart must not be blocked by the tidy-up failing. Say so and go.
    console.warn(`[operator] restart: could not stop jobs cleanly: ${err?.message ?? err}`);
  }

  console.log("[operator] restarting fully — the launcher will start it again");
  /*
    A moment for those writes to land and for the log to flush. The store is
    atomic per call so nothing is buffered, but `stopAll` persists as it goes
    and there is no value in racing it.
  */
  setTimeout(() => process.exit(0), 750);
}
