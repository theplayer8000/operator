// Work with Claude, modelled as a job rather than a request.
//
// This replaces `workspace.mjs`, which was a good one-shot implementation of the
// wrong shape. See docs/ai-workspace-design.md — this file is step 1 of it.
//
// ## The one structural change
//
// The old chat was `POST /api/chat/send` → spawn → await → reply. The HTTP
// request *was* the unit of work, so the work inherited every property of an
// HTTP request: a timeout, one response, no visibility until the end. Those were
// not four bugs, they were four symptoms of that one shape.
//
// A **job** outlives any request. The client creates one, then observes it:
//
//   POST /api/jobs              { prompt, model }  → { id }
//   GET  /api/jobs                                 → summaries only, no events
//   GET  /api/jobs/:id?since=N                     → that job's events after N
//   POST /api/jobs/:id/input    { type, text }     → another turn, or cancel
//
// ## A job is a conversation, not a turn
//
// It owns a Claude Code `session_id` and passes `--resume` on every turn after
// the first, so a tab in the UI is a thread you can keep talking to. That is the
// same trick the old chat used — it is the only thing that makes Claude Code
// remember between `-p` invocations — but scoped per job instead of one global.
//
// ## Why the output is streamed
//
// `--output-format stream-json --verbose` emits NDJSON as work happens, so the
// UI can show which file is being read and which command is running. The old
// `--output-format json` gave one envelope at the end, which is why the page
// could only ever say "Claude is working…".
//
// This is still `claude -p`. Streaming *output* is not the same as
// `--input-format stream-json`, which is step 2 and is what finally lets a
// permission be answered inside the same turn. Until then a denial still ends
// the turn, and `permissions.mjs` is how it stops being a dead end.
//
// ## Same security gate as the terminal, deliberately
//
// `claude -p` has tool access — it reads files and runs commands. This is
// therefore arbitrary execution by another route, so it sits behind the same
// armed-plus-listed-device gate rather than a softer one. A future session must
// not "relax it because it's only chat". It is not only chat.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./terminal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Models a job may use. Claude Code takes `--model`, verified returning
 * `modelUsage: ["claude-opus-5"]`, so this is a real switch rather than a label.
 * Opus 5 is the default because the owner asked for it; the cheaper option is
 * there for quick questions where the difference does not earn its latency.
 */
export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
];
const DEFAULT_MODEL = MODELS[0].id;

// --- policy ---------------------------------------------------------------
//
// The 10-minute cap is gone. It was never a considered limit — it was an HTTP
// timeout wearing a policy hat, and it killed real builds mid-flight.
//
// What replaces it is an **idle** timeout: silence, not duration. A working
// Claude emits events constantly under `stream-json`, so no output for this long
// means stuck, not busy. A two-hour build that keeps talking is fine.

const IDLE_TIMEOUT_MS = Number(process.env.OPERATOR_JOB_IDLE_MS ?? 10 * 60_000) || 10 * 60_000;
/*
  A longer window while a tool is still outstanding.

  Silence does not mean stuck if Claude is waiting on something. Under
  stream-json it emits `tool_use` when a tool starts and then says nothing at
  all until the result comes back — so a fifteen-minute `npm run build` is
  fifteen minutes of silence from a completely healthy turn, and the plain idle
  timeout would kill it at ten. That is the exact workflow this feature exists
  for, so the timeout has to know the difference.

  Still bounded: a tool that never returns is a hang, it just gets longer to
  prove otherwise.
*/
const TOOL_IDLE_TIMEOUT_MS =
  Number(process.env.OPERATOR_JOB_TOOL_IDLE_MS ?? 45 * 60_000) || 45 * 60_000;
/** stderr is kept for the failure message, not as a log. */
const MAX_STDERR_CHARS = 20_000;

/** Jobs remembered at once. Oldest finished ones are dropped first. */
const MAX_JOBS = 20;
/** Events kept per job. A long build emits thousands; the tail is what matters. */
const MAX_EVENTS = 2000;
/** A single tool result can be a whole file. Truncated for display only. */
const MAX_RESULT_CHARS = 600;
/** One reply can be long; a ceiling, not an expectation. */
const MAX_STDOUT_BYTES = 4_000_000;

/*
  The usage ceiling.

  Unset by default, and that is deliberate: a number picked here would be a guess
  at the owner's headroom, and limits are temporarily boosted (Claude Code +50%,
  Cowork +100%) so anything tuned to today is wrong next month.

  **Checking before a turn rather than during it was a proposed default**, not
  the owner's decision — an earlier session recorded it as his and he has since
  said it was a suggestion. It stands on its own reasoning: killing a turn
  mid-edit leaves the repo half-changed, which is worse than overshooting a
  self-imposed number by one turn.

  Read `OPERATOR_USAGE_BUDGET_USD` to arm it.

  **This counts Operator's own usage and nothing else.** There is no
  `claude usage` subcommand and `/usage` is interactive-only, so the plan
  percentage is not knowable from here. Every label says "Operator has used X".
  A number that looks like plan usage but only counts one client is worse than no
  number at all.
*/
/*
  The standing permission profile. The owner's decision, 2026-08-01.

  **Everything except `git push` and deleting files**, applied to every job
  rather than chosen per job. His reasoning was practical: a grant-per-command
  flow meant forty taps to make one change, and the exact-rule list had grown to
  69 entries of single-use rules that never expire — which is worse security
  than a considered standing profile, not better.

  Two exceptions, and they are the two that are hard to take back. Publishing to
  GitHub is public and permanent; deleting is unrecoverable, and this project has
  no undo (OPS-020). Everything else — reading, editing anywhere including
  `server/`, running builds, committing — is recoverable from git.

  **When Claude hits one of these it must not retry.** It writes the exact
  command down for the owner to run himself, which is what APPEND_PROMPT below
  instructs. That keeps the two irreversible actions as deliberate human ones
  without turning the other ninety-eight percent of the work into tapping.

  Per-job profiles remain possible — these are CLI flags, so they can vary per
  spawn — but he asked for one standing setting and that is what this is.
  Narrow it with OPERATOR_JOB_DENY if a setup ever wants less.
*/
/*
  The standing profile is **disabled** until the owner decides, because testing
  it found the deny list is not a boundary.

  Verified 2026-08-01, one attempt each, no adversarial effort:

    git push --dry-run                        -> DENIED   (1 denial)
    bash -c "git push --dry-run"              -> DENIED   (1 denial)
    git -C <path> push --dry-run              -> RAN      (0 denials)
    node -e "fs.unlinkSync(<file>)"           -> RAN, file deleted

  The rule matches the command string, so it stops the forms that begin
  `git push` and nothing else. The model was not evading — asked to delete a
  file it simply used node, and even declined an obfuscated version offered to
  it as unnecessary. **A helpful agent routes around a blacklist by accident**,
  which is the same lesson that retired the executable allowlist: a list of
  forbidden spellings is not containment.

  Set OPERATOR_JOB_PROFILE=1 to arm it anyway. Until then jobs run under Claude
  Code's own defaults, which stop and ask — the behaviour that existed before.
*/
const PROFILE_ARMED = process.env.OPERATOR_JOB_PROFILE === "1";

const DENIED_TOOLS = (
  process.env.OPERATOR_JOB_DENY ??
  [
    "Bash(git push:*)",
    "Bash(rm:*)",
    "Bash(rmdir:*)",
    "Bash(del:*)",
    "PowerShell(Remove-Item:*)",
  ].join(",")
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Told to the model, because a refusal it cannot act on is a dead end.
 *
 * Print mode cannot stop and ask, so hitting a denied tool ends the turn. The
 * owner asked that it leave him the command instead of retrying — he runs the
 * two irreversible ones by hand.
 */
/**
 * Whether a denial hit the standing profile, rather than being an ordinary
 * missing rule.
 *
 * **The two are answered completely differently and the UI must not merge
 * them.** An ordinary denial is one the owner can grant with a button. A
 * standing one cannot be granted at all: `--disallowedTools` is a deny, deny
 * beats allow, so writing the rule produces an entry that sits in
 * `settings.local.json` looking effective and is refused every single time it is
 * used. That is precisely the "grant that silently does nothing" failure the
 * Windows path-matching bug caused below — it cost three denied grants to find,
 * and must not be reintroduced from the other direction.
 *
 * It would be the wrong offer even if it worked. The owner's decision is that
 * publishing and deleting are the two he does himself.
 *
 * Matching is prefix-based because the two sides are written differently: the
 * profile holds patterns (`Bash(git push:*)`) while `describeDenial` generates
 * the exact command that was refused (`Bash(git push --dry-run)`).
 *
 * **A bare prefix, deliberately — no word boundary.** It over-matches: `git
 * pushup` reads as standing. That is the direction to be wrong in, because the
 * two mistakes are not equal. Over-matching tells the owner to run something
 * himself that he could have granted — confusing for one command. Under-matching
 * puts the grant button back on a refusal the deny list will keep refusing,
 * which is the inert-rule bug this whole function exists to prevent. Claude
 * Code's own matcher is the authority here and its exact `:*` semantics are not
 * documented, so lean toward "the profile covers this".
 */
function matchesStanding(tool, subject) {
  if (!tool) return false;
  return DENIED_TOOLS.some((entry) => {
    const parsed = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(entry.trim());
    if (!parsed) return false;
    const [, entryTool, pattern] = parsed;
    if (entryTool !== tool) return false;
    // No parentheses means the whole tool is denied, whatever the argument.
    if (pattern === undefined) return true;
    const prefix = pattern.replace(/:\*$/, "").trim();
    if (!prefix) return true;
    return String(subject ?? "")
      .trim()
      .startsWith(prefix);
  });
}

const APPEND_PROMPT = [
  "You are running inside Operator, headless. You cannot be asked for approval mid-turn.",
  `The following are denied and will never succeed: ${DENIED_TOOLS.join(", ")}.`,
  "If your work needs one of them, DO NOT retry it and do not try to reach it another way.",
  "Finish everything else, then write the exact command out for the owner to run in Operator's",
  "terminal himself, and note it in docs/handoffs/CURRENT.md so it survives a restart.",
].join(" ");

const BUDGET_USD = Number(process.env.OPERATOR_USAGE_BUDGET_USD ?? 0) || 0;
/** Assume a turn costs at least this, when nothing has run yet to measure. */
const MIN_RESERVE_USD = 0.5;

// --- state ----------------------------------------------------------------

/** @type {Map<string, object>} newest last, insertion-ordered. */
const jobs = new Map();
/** Ids waiting for the runner, oldest first. One job runs at a time. */
const waiting = [];
/** The id currently running, or null. */
let runningId = null;
let jobSeq = 0;
let spentUsd = 0;
/** The most expensive turn seen, used as the reserve. */
let maxTurnUsd = 0;

/*
  Only the tab index is on disk. Events are not.

  The owner asked for jobs in memory, "like a chat list — tabs, and don't load
  the full content until I click one". Taken literally that also drops the
  `session_id`, and losing that is not a cosmetic loss: it is the thing that
  makes Claude remember, and losing it is exactly the bug the previous milestone
  fixed and wrote up as "the chat was lying about remembering".

  It bites hardest in the one workflow this whole feature exists for. Editing
  `server/` requires a restart, so: ask Claude to change the server, watch it do
  it, press Restart — and the conversation you were having is gone, along with
  Claude's memory of it.

  So the index survives and the content does not, which is the same split the
  owner described for loading. After a restart the tabs are still there and still
  resumable; their event log is empty and the UI says so, because claiming
  otherwise would be the same lie in a new place.
*/
const JOBS_FILE = process.env.OPERATOR_JOBS_FILE ?? join(ROOT, "data", "jobs.json");

/** Fields worth surviving a restart — no events, no transcript. */
function indexOf(job) {
  return {
    id: job.id,
    title: job.title,
    sessionId: job.sessionId,
    model: job.model,
    device: job.device,
    turns: job.turns,
    costUsd: job.costUsd,
    createdAt: job.createdAt,
  };
}

let persistSeq = 0;

async function persist() {
  try {
    await mkdir(dirname(JOBS_FILE), { recursive: true });
    // Unique per write: two persists overlapping on one shared temp path can
    // interleave writes and rename a half-written file into place.
    const tmp = `${JOBS_FILE}.${process.pid}.${++persistSeq}.tmp`;
    // Only jobs with a session are worth restoring — one that never got that far
    // cannot be resumed, so a tab for it would be a dead tab.
    const index = [...jobs.values()].filter((j) => j.sessionId).map(indexOf);
    await writeFile(tmp, JSON.stringify({ jobs: index }, null, 2), "utf8");
    // Temp-file-then-rename, same as the store: a crash mid-write cannot leave a
    // truncated file that fails to parse on the way back up.
    await rename(tmp, JOBS_FILE);
  } catch (err) {
    // A job list that can't be saved is still a job list worth having.
    console.warn("[operator] could not save the job index:", err.message);
  }
}

async function restore() {
  try {
    if (!existsSync(JOBS_FILE)) return;
    const saved = JSON.parse(await readFile(JOBS_FILE, "utf8"));
    if (!Array.isArray(saved?.jobs)) return;
    for (const entry of saved.jobs) {
      if (!entry?.id || !entry?.sessionId) continue;
      const job = blankJob(entry.id);
      Object.assign(job, {
        title: entry.title ?? "Untitled",
        sessionId: entry.sessionId,
        model: entry.model ?? DEFAULT_MODEL,
        device: entry.device ?? null,
        turns: Number(entry.turns) || 0,
        costUsd: Number(entry.costUsd) || 0,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        status: "complete",
        // Said out loud rather than shown as an empty thread, because an empty
        // thread reads as "it forgot" — and it hasn't; Claude still holds the
        // session on disk.
        restored: true,
      });
      jobs.set(job.id, job);
      const n = Number(String(entry.id).replace(/\D/g, ""));
      if (Number.isFinite(n)) jobSeq = Math.max(jobSeq, n);
    }
    if (jobs.size) console.log(`[operator] restored ${jobs.size} job tab(s)`);
  } catch (err) {
    console.warn("[operator] could not read the saved job index:", err.message);
  }
}

await restore();

// --- the job --------------------------------------------------------------

function blankJob(id) {
  return {
    id,
    title: "Untitled",
    provider: "claude-code",
    model: DEFAULT_MODEL,
    status: "queued",
    sessionId: null,
    device: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    turns: 0,
    costUsd: 0,
    error: null,
    restored: false,
    /** Prompts not yet run, oldest first. A second message queues here. */
    pending: [],
    events: [],
    eventSeq: 0,
    proc: null,
  };
}

/**
 * Append an event.
 *
 * The vocabulary is the contract, not Claude Code's API — a second provider
 * emits these same types or it does not qualify (docs/ai-workspace-design.md).
 * `prompt` is the one addition to the design doc's table: what the owner typed
 * has to appear in the stream or the thread reads as answers with no questions.
 */
function emit(job, type, data = {}) {
  job.events.push({ seq: ++job.eventSeq, at: new Date().toISOString(), type, ...data });
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

function setStatus(job, status, detail = null) {
  job.status = status;
  emit(job, "status", { status, ...(detail ? { detail } : {}) });
}

/** One line, short enough for a tab. */
function titleFrom(prompt) {
  const line = String(prompt).replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled";
}

/** Drop the oldest finished jobs once there are too many. Never drops a live one. */
function prune() {
  while (jobs.size > MAX_JOBS) {
    const victim = [...jobs.values()].find(
      (j) => j.id !== runningId && !waiting.includes(j.id) && j.pending.length === 0
    );
    if (!victim) return;
    jobs.delete(victim.id);
  }
}

// --- budget ---------------------------------------------------------------

/**
 * Whether there is room to *start* another turn.
 *
 * Checked before spawning, never during. The owner's requirement was to stop
 * before the limit rather than at it — "if I overlap it becomes half done and
 * stuff would break" — and killing a turn mid-edit is precisely that breakage.
 * So a turn that starts is always allowed to finish; what a ceiling does is
 * refuse the next one.
 */
function budgetBlock() {
  if (!BUDGET_USD) return null;
  const reserve = Math.max(maxTurnUsd, MIN_RESERVE_USD);
  if (spentUsd + reserve <= BUDGET_USD) return null;
  return (
    `Operator has used $${spentUsd.toFixed(2)} of its own $${BUDGET_USD.toFixed(2)} ceiling, ` +
    `and the next turn could cost about $${reserve.toFixed(2)}. Stopping here rather than ` +
    `part-way through one. Raise OPERATOR_USAGE_BUDGET_USD and restart to continue.`
  );
}

export function usage() {
  return {
    spentUsd,
    budgetUsd: BUDGET_USD || null,
    // Named so no caller can mistake it for plan usage. There is no way to read
    // the plan percentage from here; see the note on BUDGET_USD.
    scope: "operator-only",
  };
}

// --- the runner -----------------------------------------------------------

/**
 * Start the next turn if nothing is running.
 *
 * One job at a time, globally.
 *
 * **A proposed default, not the owner's decision.** An earlier session recorded
 * this as his answer; he has since said it was a suggestion made to him. It is
 * kept because the reasoning stands on its own — one person driving one Claude,
 * and two agents editing the same file is a race nobody asked for — and because
 * it has been used and not objected to. Not because it was decided.
 *
 * Batch or parallel jobs remain open. The queue is what makes that a later
 * question rather than a bug.
 */
function pump() {
  if (runningId) return;
  while (waiting.length) {
    const job = jobs.get(waiting[0]);
    if (!job || job.pending.length === 0) {
      waiting.shift();
      continue;
    }
    waiting.shift();
    /*
      Claim the runner HERE, synchronously, not inside runTurn.

      runTurn awaits `resolveExecutable` before it sets `runningId`, so the
      guard at the top of this function and the assignment were separated by a
      microtask. Two calls into pump() in that window — two devices sending at
      once, or an input() racing the deferred re-pump — both saw a free runner
      and both spawned. Two `claude -p` processes editing the same repo is
      precisely what one-at-a-time exists to prevent, and it would have been
      near-impossible to diagnose from the symptoms.

      Claiming before any await closes it: JavaScript runs this to completion
      before another call can observe it.
    */
    runningId = job.id;
    void runTurn(job);
    return;
  }
}

async function runTurn(job) {
  const prompt = job.pending.shift();
  if (prompt === undefined) return;

  /*
    Both early exits below have to restart the queue themselves.

    `pump()` has already shifted this job off `waiting` by the time it calls us,
    and it only runs again when something completes. Returning here without
    re-pumping leaves the queue stalled: `runningId` was never set, so it is not
    a deadlock, but every other queued job sits there until someone happens to
    send another message. One job failing to start must not silently stop the
    rest.

    Deferred rather than called directly. The budget check runs before any
    `await`, so a direct call would re-enter `pump()` from inside its own frame,
    once per queued job.
  */
  const restartQueue = () => {
    // pump() claims the runner before calling us, so an exit before spawning
    // has to hand it back or nothing ever runs again.
    if (runningId === job.id) runningId = null;
    queueMicrotask(pump);
  };

  const blocked = budgetBlock();
  if (blocked) {
    job.error = blocked;
    setStatus(job, "blocked", blocked);
    // Put it back: raising the ceiling and restarting should not lose what he
    // typed. It is in the event log either way.
    job.pending.unshift(prompt);
    // Deliberately not re-queued into `waiting` — it would be picked up, blocked
    // and re-queued forever. The prompt survives in `pending`, so the next
    // message he sends runs both.
    restartQueue();
    return;
  }

  const resolved = await resolveExecutable("claude");
  if (!resolved) {
    job.error = "couldn't find Claude Code on this machine — set OPERATOR_TERMINAL_BIN_CLAUDE";
    setStatus(job, "failed", job.error);
    restartQueue();
    return;
  }

  // `runningId` was claimed by pump() before this ran — see the note there.
  job.outstandingTools = 0;
  job.startedAt = job.startedAt ?? new Date().toISOString();
  job.error = null;
  setStatus(job, "running");

  // `--resume` only on later turns: passing it with no prior session errors.
  const args = [
    ...resolved.prefixArgs,
    "-p",
    ...(job.sessionId ? ["--resume", job.sessionId] : []),
    prompt,
    "--model",
    job.model,
    /*
      OFF BY DEFAULT, pending the owner's decision — see PROFILE_ARMED.

      The standing profile — see DENIED_TOOLS.

      `bypassPermissions` reads alarmingly and is the correct mode here, but
      **only because the deny list is what actually holds the line**, and that
      was measured rather than assumed:

        dontAsk            → git push denied, and a plain file write ALSO denied.
                             It means "never prompt, so anything not explicitly
                             allowed fails" — the opposite of what it sounds
                             like, and it would have made every job useless.
        bypassPermissions  → git push denied (1 denial), file write succeeded
                             (0 denials). Both verified 2026-08-01.

      So the deny list survives bypass. If a future version of Claude Code stops
      honouring --disallowedTools under this mode, this becomes an unrestricted
      agent silently — re-run those two checks after any Claude Code upgrade.
    */
    ...(PROFILE_ARMED
      ? [
          "--permission-mode",
          "bypassPermissions",
          ...(DENIED_TOOLS.length ? ["--disallowedTools", ...DENIED_TOOLS] : []),
        ]
      : []),
    "--append-system-prompt",
    APPEND_PROMPT,
    "--output-format",
    "stream-json",
    // Not optional. Claude Code refuses `--output-format stream-json` under
    // `--print` without it.
    "--verbose",
  ];

  console.log(
    `[operator] job ${job.id} turn ${job.turns + 1} by ${job.device ?? "unknown"}` +
      `${job.sessionId ? ` (resuming ${job.sessionId.slice(0, 8)})` : " (new session)"}`
  );

  await new Promise((done) => {
    let buffer = "";
    let bytes = 0;
    let stderr = "";
    let settled = false;
    let sawResult = false;

    const proc = spawn(resolved.exe, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      // No stdin, for the same reason as the terminal: an open pipe nobody
      // writes to makes anything that reads stdin wait for the timeout. Step 2
      // changes this deliberately, with `--input-format stream-json`.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    job.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    let idle = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    idle.unref?.();
    function touch() {
      clearTimeout(idle);
      idle = setTimeout(onIdle, (job.outstandingTools ?? 0) > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
      idle.unref?.();
    }
    function onIdle() {
      if (settled) return;
      const mins = Math.round(
        ((job.outstandingTools ?? 0) > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS) / 60000
      );
      job.error = `no output for ${mins} minutes — stopped`;
      stop();
    }

    /*
      Ask, then insist.

      A plain kill() is a request the child may ignore, and one that does would
      hold the runner claim forever — every other job queued behind a process
      that will not die. On Windows kill() already terminates outright, so this
      is really for the EPYC move; it costs nothing to have it right now.
    */
    function stop() {
      if (settled) return;
      proc.kill();
      const hard = setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, 5_000);
      hard.unref?.();
    }

    proc.stdout.on("data", (chunk) => {
      touch();
      bytes += Buffer.byteLength(chunk, "utf8");
      buffer += chunk;
      /*
        Never stop parsing. This used to `return` once the total exceeded
        MAX_STDOUT_BYTES, which silently discarded every later line — including
        the final `result`, the one that carries the session id, the cost, and
        the fact that the turn finished at all. A long but perfectly successful
        turn would then be reported as failed, with no clue why.

        Total volume is not the memory risk, because lines are consumed as they
        arrive. The only unbounded case is a single line that never terminates,
        so that is what is capped instead — and it is dropped whole rather than
        sliced, since half a JSON document parses as nothing useful anyway.
      */
      if (buffer.length > MAX_STDOUT_BYTES) {
        buffer = "";
        emit(job, "text", { text: "[a line of output was too long and was dropped]", raw: true });
      }
      // NDJSON: one complete JSON document per line. The last fragment stays in
      // the buffer until its newline arrives.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          if (ingest(job, line)) sawResult = true;
        }
      }
    });

    proc.stderr.on("data", (d) => {
      touch();
      // Capped. It exists to explain a failure, and an unbounded string fed by
      // a chatty process is a memory leak that only shows up on a long run.
      if (stderr.length < MAX_STDERR_CHARS) stderr += d;
    });

    function finish(code, failure) {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      job.proc = null;
      job.outstandingTools = 0;
      // Only if it is still ours. A late exit from an earlier job would
      // otherwise unlock the runner while a different one is mid-turn.
      if (runningId === job.id) runningId = null;

      // A trailing line with no newline still counts.
      const tail = buffer.trim();
      if (tail && ingest(job, tail)) sawResult = true;

      if (job.status === "cancelled") {
        void persist();
        done();
        return pump();
      }

      if (failure || !sawResult) {
        const detail =
          failure ??
          job.error ??
          (stderr.trim().slice(0, 600) || `Claude exited ${code} with no result.`);
        job.error = detail;
        setStatus(job, "failed", detail);
      } else {
        setStatus(job, "complete");
      }

      void persist();
      done();
      pump();
    }

    proc.on("error", (err) => finish(null, `couldn't start Claude Code: ${err.message}`));
    proc.on("close", (code) => finish(code, null));
  });
}

/**
 * Turn one NDJSON line into events. Returns true if it was the final result.
 *
 * Deliberately tolerant. The shapes below are Claude Code's documented
 * `stream-json` output, but an unrecognised `type` is ignored rather than thrown
 * on — a new event type in a future CLI release must not take the chat down. The
 * one thing that is *not* silent is a line that fails to parse at all, because
 * that means the format changed under us and a silent empty reply is the thing
 * that makes a chat feel broken.
 */
function ingest(job, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emit(job, "text", { text: line.slice(0, MAX_RESULT_CHARS), raw: true });
    return false;
  }

  if (msg?.session_id && !job.sessionId) {
    job.sessionId = msg.session_id;
    // Saved the moment it appears, not at the end of the turn. The session id is
    // the memory, and a crash mid-turn is exactly when a later save doesn't run.
    void persist();
  }

  switch (msg?.type) {
    case "system":
      // `init` carries the tool list and cwd. Useful once, noisy repeated.
      if (msg.subtype === "init") {
        emit(job, "status", {
          status: "running",
          detail: Array.isArray(msg.tools) ? `${msg.tools.length} tools available` : null,
        });
      }
      return false;

    case "assistant": {
      for (const block of msg.message?.content ?? []) {
        if (block?.type === "text" && block.text?.trim()) {
          emit(job, "text", { text: block.text });
        } else if (block?.type === "tool_use") {
          // Tracked so the idle timer can tell "waiting on a build" from
          // "stuck" — see TOOL_IDLE_TIMEOUT_MS.
          job.outstandingTools = (job.outstandingTools ?? 0) + 1;
          emit(job, "tool_use", {
            tool: block.name,
            // What it is doing, in the terms the owner would use — a command, a
            // path — rather than the whole input object.
            subject: subjectOf(block.input),
          });
        }
      }
      return false;
    }

    case "user": {
      // Tool results come back as a synthetic user message.
      for (const block of msg.message?.content ?? []) {
        if (block?.type !== "tool_result") continue;
        job.outstandingTools = Math.max(0, (job.outstandingTools ?? 0) - 1);
        emit(job, "tool_result", {
          ok: block.is_error !== true,
          text: flatten(block.content).slice(0, MAX_RESULT_CHARS),
        });
      }
      return false;
    }

    case "result": {
      job.turns += 1;
      const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      if (cost > 0) {
        job.costUsd += cost;
        spentUsd += cost;
        maxTurnUsd = Math.max(maxTurnUsd, cost);
        emit(job, "usage", {
          // Reported by Claude Code as the API-equivalent cost. On a
          // subscription login this is plan usage, not a charge — every label
          // downstream must say so rather than render it as money.
          turnUsd: cost,
          jobUsd: job.costUsd,
          spentUsd,
          budgetUsd: BUDGET_USD || null,
          durationMs: typeof msg.duration_api_ms === "number" ? msg.duration_api_ms : null,
        });
      }

      const denials = Array.isArray(msg.permission_denials)
        ? msg.permission_denials.map(describeDenial).filter(Boolean)
        : [];
      for (const d of denials) emit(job, "permission_request", d);

      if (msg.is_error) {
        job.error = typeof msg.result === "string" && msg.result ? msg.result : "Claude reported an error";
        emit(job, "text", { text: job.error, error: true });
      }
      return true;
    }

    default:
      return false;
  }
}

/** The identifying part of a tool's input — a command, a path — for one line of UI. */
function subjectOf(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    if (typeof input[key] === "string" && input[key]) return input[key];
  }
  return "";
}

/** Tool result content is a string or a block array; both become one string. */
function flatten(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
    .join("")
    .trim();
}

// --- API ------------------------------------------------------------------

/** Everything a tab needs, and nothing a tab doesn't. No events. */
function summary(job) {
  return {
    id: job.id,
    title: job.title,
    provider: job.provider,
    model: job.model,
    status: job.status,
    sessionId: job.sessionId,
    device: job.device,
    createdAt: job.createdAt,
    turns: job.turns,
    costUsd: job.costUsd,
    error: job.error,
    restored: job.restored,
    queued: job.pending.length,
    latest: job.eventSeq,
  };
}

/**
 * The tab strip.
 *
 * Summaries only — the owner asked for tabs that don't carry their content until
 * one is opened. A long build's event log is measured in thousands of entries
 * and this endpoint is polled.
 */
export function list() {
  return {
    jobs: [...jobs.values()].map(summary),
    running: runningId,
    models: MODELS,
    defaultModel: DEFAULT_MODEL,
    // The standing profile, so the page states what it actually is rather than
    // repeating it in prose that drifts the first time OPERATOR_JOB_DENY is set.
    deniedTools: DENIED_TOOLS,
    ...usage(),
  };
}

/**
 * One job's events after `since`.
 *
 * The same offset trick the terminal uses, and for the same reason: polling is
 * what actually works on the owner's phone, and an event log means a locked
 * phone catches up rather than missing the gap a stream would have dropped.
 */
export function detail(id, since = 0) {
  const job = jobs.get(id);
  if (!job) return null;
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  return { ...summary(job), events: job.events.filter((e) => e.seq > from) };
}

/**
 * Who is allowed to send right now.
 *
 * One user on Claude at a time — a proposed default rather than his stated
 * answer; see the note on the queue above. While a job is running,
 * devices other than the one that started it are read-only — they can watch,
 * which is the desk-to-phone hand-off this whole feature exists for, but they
 * cannot queue work into someone else's session. When nothing is running, any
 * authorised device may send.
 */
export function holder() {
  const job = runningId ? jobs.get(runningId) : null;
  return job ? { id: job.id, device: job.device } : null;
}

function assertMine(identity) {
  const held = holder();
  if (!held) return;
  const me = identity?.device ?? null;
  if (held.device && me && held.device === me) return;
  throw new Error(`Claude is busy on "${jobs.get(held.id)?.title ?? held.id}" from ${held.device ?? "another device"}`);
}

export function create(prompt, model, identity) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("nothing to send");
  assertMine(identity);

  const job = blankJob(`job-${++jobSeq}`);
  job.title = titleFrom(text);
  job.device = identity?.device ?? null;
  if (MODELS.some((m) => m.id === model)) job.model = model;

  jobs.set(job.id, job);
  emit(job, "prompt", { text });
  job.pending.push(text);
  waiting.push(job.id);
  prune();
  pump();
  return summary(job);
}

/** Another turn on an existing job, or a cancellation. */
export function input(id, body, identity) {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");

  if (body?.type === "cancel") {
    /*
      **Cancel deliberately skips `assertMine`.** Sending into someone else's
      running job is refused, but stopping one is not: a runaway has to be
      killable from whichever device is in your hand, and every device that can
      reach this is already authorised to run arbitrary commands. Restricting it
      would protect nothing and strand the person watching it go wrong.

      Drop the queue either way. Killing the child only ends the turn that is
      running; anything already queued on this job would start the moment the
      process exits and pump() runs again — so pressing Stop launched the next
      turn instead of stopping. Stop means stop.
    */
    job.pending.length = 0;
    if (job.proc) {
      setStatus(job, "cancelled", "stopped from the app");
      job.proc.kill();
    } else {
      setStatus(job, "cancelled", "stopped before it started");
    }
    return summary(job);
  }

  const text = String(body?.text ?? "").trim();
  if (!text) throw new Error("nothing to send");
  assertMine(identity);

  // Whoever sends the turn holds it, not whoever opened the tab. `holder()`
  // reads this to say "busy on X from <device>", and naming the wrong device
  // makes that message actively misleading on a two-device setup.
  job.device = identity?.device ?? job.device;

  emit(job, "prompt", { text });
  job.pending.push(text);
  if (!waiting.includes(job.id)) waiting.push(job.id);
  if (job.status !== "running") setStatus(job, "queued");
  pump();
  return summary(job);
}

export function setModel(id, model) {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");
  if (MODELS.some((m) => m.id === model)) job.model = model;
  return summary(job);
}

/**
 * Forget a job.
 *
 * Deletes the tab, not Claude Code's session — that stays on disk, so nothing is
 * truly destroyed and this is closing a tab rather than shredding work. A
 * running job is cancelled first; removing it underneath the runner would leave
 * a process with nowhere to report.
 */
export function remove(id, identity) {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");
  if (job.proc) {
    setStatus(job, "cancelled", "closed from the app");
    job.proc.kill();
  }
  jobs.delete(id);
  const at = waiting.indexOf(id);
  if (at !== -1) waiting.splice(at, 1);
  console.log(`[operator] job ${id} closed by ${identity?.device ?? "unknown"}`);
  void persist();
  return list();
}

/** Close every job. The index file goes with them, or they'd return on restart. */
export function clear(identity) {
  for (const job of jobs.values()) if (job.proc) job.proc.kill();
  jobs.clear();
  waiting.length = 0;
  runningId = null;
  rm(JOBS_FILE, { force: true }).catch(() => {});
  console.log(`[operator] all jobs cleared by ${identity?.device ?? "unknown"}`);
  return list();
}

// --- permissions ----------------------------------------------------------
//
// What Claude was not allowed to do, and the rule that would allow it. Carried
// over from `workspace.mjs` unchanged — the Windows path-matching fix below cost
// three denied grants to find and must not be re-derived.
//
// Print mode cannot stop and ask. When Claude wants a tool it is not allowed to
// use, the turn simply ends with a `permission_denials` entry — and from a phone
// that is a dead end, because the approval prompt it refers to only exists in an
// interactive terminal. So instead of pretending to be interactive, this reports
// **what** was wanted and **the exact rule that would allow it**, and offers to
// write that rule to the same file the interactive prompt writes to.
//
// Granting a Claude permission is strictly less powerful than what an authorised
// device can already do through the terminal, so this sits behind the same gate
// and adds no new capability. It is a shortcut, not a hole.
//
// Step 2 of docs/ai-workspace-design.md — `--input-format stream-json` — is what
// finally makes the answer land *inside* the same turn. Until then this is how a
// denial stops being a dead end.

const SETTINGS_FILE = join(ROOT, ".claude", "settings.local.json");

/**
 * Turn a raw denial into something showable, plus the rule that would permit it.
 *
 * Rules are generated **exact**, not wildcarded: `Bash(git push --dry-run)`
 * rather than `Bash(git push:*)`. An exact rule allows the thing that was
 * actually asked for and nothing else; broadening it is a decision the owner can
 * make by editing the file, and should not be made for him by a button on a
 * phone.
 */
export function describeDenial(d) {
  const tool = d?.tool_name ?? d?.tool ?? null;
  if (!tool) return null;
  const input = d?.tool_input ?? {};
  // Bash is the common case and its `command` is what the rule keys on. Other
  // tools key on a path, so fall back to whichever identifying field exists.
  const isCommand = typeof input.command === "string";
  const rawSubject = isCommand
    ? input.command
    : typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : "";

  /*
    A path-based rule has to be written the way the matcher reads it, or the
    grant silently does nothing.

    Claude Code matches file tools (Write, Edit, Read…) against gitignore-style
    paths — forward slashes, relative to the project. `tool_input.file_path`
    on Windows is neither: it arrives as `D:\Projects\Operator\server\jobs.mjs`.
    Writing that verbatim produced a rule that looked right in
    `.claude/settings.local.json`, sat in the allow list, and never fired. The
    owner granted the same write three times and watched it be denied three
    times, because each grant added another rule that could not match.

    Bash is unaffected — its rule keys on the command string as typed, which is
    why that half worked from the start and hid this.
  */
  const subject = isCommand ? rawSubject : toRulePath(rawSubject);

  return {
    tool,
    subject,
    description: typeof input.description === "string" ? input.description : "",
    rule: subject ? `${tool}(${subject})` : tool,
    // Which of the two refusals this is. The client shows a grant button for one
    // and the command to run by hand for the other — see matchesStanding.
    standing: matchesStanding(tool, isCommand ? rawSubject : subject),
  };
}

/** Absolute Windows path → the forward-slash, project-relative form rules use. */
export function toRulePath(raw) {
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/").replace(/\/$/, "");
  // Case-insensitive because Windows paths are, and the drive letter's case
  // varies depending on which tool reported it.
  if (slashed.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return slashed.slice(root.length + 1);
  }
  return slashed;
}

/** Rules currently allowed, so a grant that already exists isn't offered again. */
async function readSettings() {
  if (!existsSync(SETTINGS_FILE)) return { permissions: { allow: [] } };
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    if (!parsed.permissions) parsed.permissions = {};
    if (!Array.isArray(parsed.permissions.allow)) parsed.permissions.allow = [];
    return parsed;
  } catch (err) {
    // Never overwrite a file we could not parse — the owner has hand-edited this
    // one and losing it would be worse than refusing.
    throw new Error(`.claude/settings.local.json is unreadable: ${err.message}`);
  }
}

/** Append one rule to the allow list. Idempotent. */
export async function allowRule(rule, identity) {
  const clean = String(rule ?? "").trim();
  if (!clean) throw new Error("no rule given");
  if (clean.length > 2000) throw new Error("rule is implausibly long");

  /*
    Refuse rather than write a rule that can never fire.

    The page no longer offers this for a standing denial, but the check belongs
    here too: a stale tab, an old event log, or a second client would otherwise
    get a cheerful "allowed" for a grant that deny-beats-allow makes inert. The
    whole point of this feature is that a refusal stops being a dead end — an
    imaginary grant is a worse dead end than an honest refusal, because it looks
    solved.
  */
  const parsed = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(clean);
  if (parsed && matchesStanding(parsed[1], parsed[2] ?? "")) {
    throw new Error(
      "That's one of the two Operator never runs for you. It's denied at the " +
        "command line, and a deny beats an allow — this rule would be written and " +
        "then ignored every time. Run it in the terminal yourself."
    );
  }

  const settings = await readSettings();
  if (settings.permissions.allow.includes(clean)) {
    return { added: false, rule: clean, reason: "already allowed" };
  }
  settings.permissions.allow.push(clean);

  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await rename(tmp, SETTINGS_FILE);

  console.log(`[operator] permission allowed by ${identity?.device ?? "unknown"}: ${clean}`);
  return { added: true, rule: clean };
}
