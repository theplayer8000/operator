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
// ## It has to be AWAITED, and the first version was not
//
// The first version did all of the above and then called `process.exit(0)`
// behind a 750ms `setTimeout`, awaiting none of it. That is not a graceful
// shutdown, it is a kill with a pause in front:
//
//   - `stopAll()` never called `persist()` at all, so the cancellations existed
//     only in memory and `data/jobs.json` kept the attempt recorded as
//     "running" — the exact state the call is here to prevent.
//   - `process.exit()` does not wait for pending I/O, so any write that WAS in
//     flight could be cut between `writeFile` and `rename`.
//   - The HTTP listener was never closed, so in-flight requests and event
//     streams were severed at the socket.
//
// The store survived all of it, because `store.mjs` is atomic per call. The job
// bookkeeping — the entire thing the soft stop was added for — did not.
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
 * The HTTP listener, handed over by whoever owns it.
 *
 * Registered rather than imported, and that is not style. This module is
 * reachable from `scripts/operator-action.mjs` (CLI → actions.mjs → here),
 * where `index.mjs` has never been loaded — so an `import("./index.mjs")` to
 * fetch its closer would not fetch anything, it would EXECUTE it, booting a
 * second server inside the CLI process and binding the port. Registration is
 * also the direction that avoids the cycle: index.mjs already depends on this
 * file, and nothing here depends on index.mjs.
 *
 * Null when nobody registered — a CLI-triggered restart has no listener of its
 * own to close, and the drain simply skips that step.
 */
let closeListener = null;

/** Called once by index.mjs at startup. */
export function onShutdown(close) {
  closeListener = typeof close === "function" ? close : null;
}

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

/**
 * How long the whole drain gets before it stops being graceful.
 *
 * Deliberately far shorter than the grace `restart-operator.mjs` allows: that
 * one is the backstop for a server that will not go, and it should never be the
 * thing we are relying on. If the drain cannot finish in this, going now and
 * being honest about it beats hanging.
 */
const DRAIN_MS = 8_000;

/** Bound a promise that has no timeout of its own. Resolves false if it wins. */
function within(promise, ms) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), Math.max(0, ms));
      t.unref();
    }),
  ]);
}

async function shutdown(reason) {
  const deadline = Date.now() + DRAIN_MS;
  const left = () => Math.max(0, deadline - Date.now());

  /*
    Order is the design here, and it is: stop listening, then cancel, then save.

    Listening first, because anything that arrives after this point would be
    work started by a server that is leaving — including a queued turn that
    `stopAll` has already walked past.
  */
  if (closeListener) {
    try {
      const clean = await closeListener({ timeoutMs: Math.min(left(), 5_000) });
      console.log(
        clean
          ? "[operator] restart: stopped listening"
          : "[operator] restart: listener did not close in time — continuing anyway",
      );
    } catch (err) {
      console.warn(`[operator] restart: could not close the listener: ${err?.message ?? err}`);
    }
  }

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

    /*
      And WAIT for that to reach disk. This is the line the first version was
      missing: `stopAll` schedules a save, `process.exit` does not wait for it,
      and the cancellation it just recorded never lands.
    */
    const saved = await within(jobs.flush(), left());
    console.log(
      saved
        ? "[operator] restart: job index saved"
        : "[operator] restart: job index did NOT save in time — a cancelled turn may read as running",
    );
  } catch (err) {
    // A restart must not be blocked by the tidy-up failing. Say so and go.
    console.warn(`[operator] restart: could not stop jobs cleanly: ${err?.message ?? err}`);
  }

  console.log("[operator] restarting fully — the launcher will start it again");
  /*
    A last beat purely so the lines above reach data/serve.log — stdout is a
    pipe to the supervisor and `process.exit` truncates it too. Everything that
    MATTERS has been awaited by now, which is the difference from the version
    where this timeout was the mechanism.
  */
  setTimeout(() => process.exit(0), 150);
}
