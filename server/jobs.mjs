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
// ## A denial is no longer a dead end
//
// Turns run through the **Claude Agent SDK** (`runner.mjs`, ADR 0012), whose
// `canUseTool` callback suspends the turn until it is answered. So a tool
// Claude is not pre-approved for becomes a question on the phone with an Allow
// and a Deny, and the same turn carries on with the answer — rather than ending
// and being asked again from the beginning.
//
// The mode is the owner's decision of 2026-08-19, option C of three:
// **`default` plus a broad pre-allow list** (ALLOWED_TOOLS). Ordinary work —
// reading, editing, building, committing — never prompts because it is
// pre-approved. Anything outside that pauses and asks. The deny list still
// hard-stops `git push` and deletes, and those never reach the callback at all,
// so they cannot be waved through by a mis-tap.
//
// The old `claude -p` spawn is still here behind `OPERATOR_JOB_RUNNER=cli`.
// It is a fallback for the SDK path failing in a way that would otherwise leave
// no working chat, not a supported second mode — see the note above runTurn.
//
// ## Same security gate as the terminal, deliberately
//
// `claude -p` has tool access — it reads files and runs commands. This is
// therefore arbitrary execution by another route, so it sits behind the same
// armed-plus-listed-device gate rather than a softer one. A future session must
// not "relax it because it's only chat". It is not only chat.

import { spawn } from "node:child_process";
import { notify } from "./notify.mjs";
import { reviewWork, snapshot as workspaceSnapshot } from "./semantic.mjs";
import { runAction } from "./actions.mjs";
import { state as worktreeState, sync as syncWorktree, warningFor } from "./worktree.mjs";
import { recallFor } from "./memory.mjs";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./terminal.mjs";
import { claimResources, removeJobResources } from "./uploads.mjs";
import { DEFAULT_PROVIDER, listProviders, runWorkerTurn, selectWorker } from "./providers.mjs";
import { routeTask, noteFailure, noteSuccess, cooldownRemaining, needsCode } from "./routing.mjs";
import { verifyWorkspace } from "./verify.mjs";
import {
  checkCeiling,
  countRequest,
  jobCeilingUsd,
  markQuotaExhausted,
  recordTurn,
  usageSnapshot,
} from "./usage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/*
  Where Claude works — deliberately not necessarily where Operator runs.

  Jobs used to spawn in ROOT, the same checkout serving the app. That is how
  `main` ended up unable to restart twice in one day: Claude migrated the server
  half of a change, the frontend half was still in flight, and the tree the
  running server reads was the tree being edited. There was no moment where a
  half-finished change was invisible to the thing using it.

  Point `OPERATOR_JOB_CWD` at a git worktree and that stops being possible. The
  agent commits to its own branch, the app keeps serving `main`, and its work
  becomes visible only when the branch is merged — the review step that was
  previously a matter of remembering.

  Unset, it is ROOT and behaves as before, so nothing breaks for a setup that
  hasn't made a worktree.
*/
const JOB_CWD = process.env.OPERATOR_JOB_CWD
  ? resolve(process.env.OPERATOR_JOB_CWD)
  : ROOT;
if (JOB_CWD !== ROOT) console.log(`[operator] jobs will run in ${JOB_CWD}`);

const DEFAULT_MODEL = selectWorker(DEFAULT_PROVIDER).model;

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
/*
  How long a permission question waits for an answer before giving up.

  It has to exist — a turn suspended on a question nobody will ever answer holds
  the runner forever, and one job at a time means it holds every other job too.
  It has to be *generous*, because the question lands on a phone that may be in
  a pocket: the whole point is that the owner answers when he gets to it, not
  that he is on call.

  Timing out **denies**, and says so in the event log. The alternative — allow
  on timeout — turns walking away from your phone into approval, which is the
  one interpretation of silence nobody wants.

  The idle timers below are suspended while a question is outstanding; see
  `job.awaitingPermission`. Otherwise the tool-idle timeout would kill the turn
  at 45 minutes for the crime of waiting to be answered.
*/
const PERMISSION_TIMEOUT_MS =
  Number(process.env.OPERATOR_JOB_PERMISSION_MS ?? 30 * 60_000) || 30 * 60_000;
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
  The usage ceiling lives in `server/usage.mjs` now — ADR 0013.

  What used to be here was `spentUsd += result.costUsd` against
  `OPERATOR_USAGE_BUDGET_USD`: one accumulator summing one number that does not
  mean one thing. The ADR retired it rather than shipping it, because the same
  addition mixes a subscription *valuation* with real *billed* spend, and a
  ceiling that stops work for a reason it cannot explain is worse than none.

  Three env-only ceilings replace it, checked in this order:

    OPERATOR_CEILING_JOB_USD       the runaway guard. Also handed to the SDK as
                                   maxBudgetUsd, so it can stop a loop MID-turn.
    OPERATOR_CEILING_PROVIDER_USD  routing exists to funnel work, so funnelling
                                   it all into the expensive worker is likely.
    OPERATOR_CEILING_DAILY_USD     last and weakest alone — applied per basis.
    OPERATOR_QUOTA_REQUESTS        a separate ledger. Gemini's free tier ran out
                                   while reporting $0.00; dollars cannot see it.

  All unset by default: a number picked here would be a guess at the owner's
  headroom, and limits get temporarily boosted, so anything tuned to today is
  wrong next month. **Setting one matters now that OPERATOR_MAX_CONCURRENT is
  above 1** — one turn at a time bounded spend by wall-clock, and N turns
  multiply it by N.

  Checking before a turn rather than during it is the owner's requirement:
  killing a turn mid-edit leaves the repo half-changed, which is worse than
  overshooting a self-imposed number by one turn.

  **This counts Operator's own usage and nothing else.** There is no
  `claude usage` subcommand and `/usage` is interactive-only, so the plan
  percentage is not knowable from here. A number that looks like plan usage but
  only counts one client is worse than no number at all.
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
  DECIDED 2026-08-19 — option C. This constant is now the CLI fallback's switch
  only; the SDK path ignores it and always runs `default` + ALLOWED_TOOLS.

  The three options were mutually exclusive and the owner picked the third:

    bypassPermissions   no interruptions, canUseTool never fires — ADR 0012
                        buys nothing, and the Snapchat dead end stays.
    default alone       every unapproved tool prompts. Answerable, but a
                        workspace that asks to read a file is not a workspace.
    default + pre-allow ordinary work is silent because it is pre-approved;
                        anything else pauses and is answerable from the phone.

  What made the third cheap was the probe of 2026-08-19: the SDK auto-approves
  trivially safe calls without consulting the callback at all (`echo` never
  reached it), so ALLOWED_TOOLS only has to cover the middle ground.

  The note below is kept because it is still true of the CLI fallback, and it is
  the reason the pre-allow list is a list of *what to run without asking* rather
  than a blacklist of what not to.

  The standing profile was **disabled** pending that decision, because testing
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

/*
  The escape hatch back to spawning `claude -p`.

  The SDK is the runner (ADR 0012) and this is not a supported second mode — it
  is there because the failure it guards against is total. If the SDK path
  breaks on an upgrade, the owner does not lose a feature, he loses the way he
  works on this project, possibly from a phone, possibly with no way to fix it
  except the thing that just broke. One environment variable and a restart is a
  cheaper insurance policy than that risk deserves.

  It does **not** get the permission pause — print mode cannot ask, which is the
  entire reason ADR 0012 exists. Under `cli` a denial goes back to ending the
  turn and being reported after the fact.

  Delete this and the spawn path with it once the SDK has a few weeks of real
  use. Two runners is a maintenance tax, and the note above is the only thing
  keeping it honest about which one is real.
*/
const USE_CLI = process.env.OPERATOR_JOB_RUNNER === "cli";

export const DENIED_TOOLS = (
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

/*
  The pre-allow list — what runs without asking. Option C's quiet half.

  The line it draws: **the tools Claude uses constantly run silently; commands
  that touch the machine rather than the repo pause and ask.** Installing a
  package, killing a process or calling out to the network now suspend the turn
  and put a question on the owner's phone, instead of ending it — which is the
  entire point of ADR 0012.

  ## Two forms, and they behave differently. Measured 2026-08-19.

  **A bare tool name auto-approves that tool completely, before `canUseTool` is
  consulted at all.** The SDK says so itself, on stderr:

      [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for:
      Read, Glob, Grep. Bare allowedTools entries auto-approve the whole tool
      before the callback is consulted.

  So `Write` here means every write, anywhere on the disk, unasked — not every
  write inside the repo.

  **The obvious fix does not work.** `Write(**)` was tried, and it matched
  nothing: an in-repo write and a write to the temp directory *both* asked. That
  is the worst outcome of the three, because a workspace that asks permission
  for every file edit is one nobody will use, and the failure is silent — the
  rule sits in the list looking effective, exactly like the two inert-grant bugs
  this file already documents.

  So the choice is binary, and `Write`/`Edit` are bare **deliberately**:

    - It is the owner's actual decision. The standing profile is "everything
      except `git push` and deleting files", and editing anywhere including
      `server/` is named in it as recoverable from git.
    - It is not a regression. Under the previously-armed `bypassPermissions`
      profile, writes anywhere were already unasked.
    - What contains the blast radius here is the **worktree**, not this list —
      the same reasoning the threat model gives for the deny list being a speed
      bump rather than a boundary.

  If a narrower rule is wanted later, **measure it before shipping it**. Both
  probes are in `scripts/` and cost about $0.35 each.

  ## Bash entries

  Patterns matched by Claude Code's own matcher, the same syntax as the deny
  list, and they *are* scoped — these are prefixes, so `Bash(git commit:*)`
  covers `git commit -m "…"` but not `git -C … commit`. The same under-matching
  that makes a *deny* list useless makes an *allow* list safe: wrong in the
  direction of asking too often, which is a tap, not a hazard.

  Deliberately NOT here:
    - `Bash(npm install:*)`  reaches the network and rewrites the lockfile
    - `Bash(curl:*)` / WebFetch  outbound, and the owner approves hosts one by
                                 one (CLAUDE.md) — that rule is not the SDK's to
                                 relax
    - `Bash(schtasks:*)`, `Bash(taskkill:*)`  machine state, not repo state

  Widen it with OPERATOR_JOB_ALLOW (comma-separated) if the asking gets tedious
  — but widen it deliberately, one entry at a time, or it becomes
  bypassPermissions wearing a list.

  One more shadow to know about, from the same warning: **allow rules in
  `.claude/settings.local.json` also bypass the callback**, and the SDK cannot
  see them to warn about them. The post-hoc grant button writes to that file, so
  a rule granted there stops being a question rather than becoming an
  auto-answered one. See SETTINGS_FILE.
*/
/**
 * The environment a worker runs in, with Operator's own secrets removed.
 *
 * **A worker has never needed these and should never have had them.** The
 * server holds `GEMINI_API_KEY` because `server/gemini.mjs` makes the call;
 * the worker is on the other side of that boundary. `OPERATOR_TOKEN` is worse
 * — `threat-model.md` calls it "a password to everything", and a job reaching
 * the API only ever does so over loopback, which is authenticated by being
 * loopback.
 *
 * Why it matters more than it looks: `Bash(echo:*)` is pre-approved, so a job
 * can already *read* whatever is in its environment. What stops a key leaving
 * is that no outbound command is pre-approved — a boundary made of two
 * separate half-measures, either of which could reasonably be relaxed later
 * by someone who did not know the other was load-bearing. Removing the secrets
 * removes the dependency between them.
 *
 * Deliberately a denylist of *Operator's own* secrets rather than a scrub of
 * anything matching /KEY|TOKEN/: the worker legitimately needs PATH, HOME,
 * APPDATA and whatever Claude Code itself authenticates with, and guessing at
 * that pattern would eventually strip something that matters and produce a
 * failure nobody could explain.
 */
const WORKER_SECRETS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "OPERATOR_TOKEN"];

export function workerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of WORKER_SECRETS) delete env[key];
  return env;
}

export const ALLOWED_TOOLS = (
  process.env.OPERATOR_JOB_ALLOW ??
  [
    // Reading and searching. Never destructive, and constant enough that
    // asking about them would make the feature unusable.
    "Read",
    "Glob",
    "Grep",
    "NotebookRead",
    "TodoWrite",
    // Editing. The owner's standing profile explicitly covers this, including
    // `server/`, because the worktree and git make it recoverable.
    "Edit",
    "Write",
    "NotebookEdit",
    // The verification gate CLAUDE.md requires before anything is handed back.
    "Bash(npm run build:*)",
    "Bash(npx tsc:*)",
    "Bash(npx vite:*)",
    "Bash(node --check:*)",
    "Bash(node scripts/log-update.mjs:*)",
    /*
      The capability layer (server/actions.mjs). Pre-allowed for the same
      reason log-update is: it is how a worker is *supposed* to change the
      owner's data, and every action behind it is named, validated, and
      limited to something he could already do through that feature's own
      page. Asking permission per call would make the intended path the
      annoying one — and the unintended path (editing source, or a raw
      PUT /api/state) is the one that stays gated.
    */
    "Bash(node scripts/operator-action.mjs:*)",
    /*
      Logging a change (scripts/log-update.mjs). Pre-allowed for the same
      reason operator-action is: CLAUDE.md REQUIRES every shipped change to be
      logged, so it is the one command every job ends with — and it was the one
      command that always prompted. A rule that fires on the thing the rules
      themselves mandate is friction with no safety in it.

      It writes one line to a changelog through the API. There is nothing here
      a permission prompt is protecting.
    */
    /*
      The FULL-PATH form, which was the actual gap.

      `Bash(node scripts/log-update.mjs:*)` has been allowed for ages — and
      the agent does not write `node`, it writes the absolute path, because
      CLAUDE.md tells it to: the `node` on PATH is a broken shim that fails
      silently. So the one rule that existed could never match the command
      the rules themselves produce.
    */
    'Bash("C:\\Program Files\\nodejs\\node.exe" scripts/log-update.mjs:*)',
    'Bash("C:/Program Files/nodejs/node.exe" scripts/log-update.mjs:*)',
    /*
      The SAME two scripts, prefixed with `cd`.

      This is what actually caused the prompting, and it was not a missing
      script — `operator-action.mjs` is pre-allowed three ways and was still
      asked about TWELVE times. The matcher sees the whole command string, and
      the agent was writing `cd /d/Projects/Operator && node scripts/...`
      because the worktree it runs in was 183 commits behind and did not HAVE
      the capability layer. The prefix broke every rule.

      That drift is fixed and the prompt now says not to cd — but the habit
      will recur, and the honest fix is to allow the shape it actually uses
      rather than to rely on it never using it.

      Deliberately NOT `Bash(cd:*)`. That would match `cd anywhere && rm -rf`,
      which is allowing everything with extra steps. Each entry names the
      script it ends in.
    */
    "Bash(cd /d/Projects/Operator && node scripts/operator-action.mjs:*)",
    "Bash(cd /d/Projects/Operator && node scripts/log-update.mjs:*)",
    'Bash(cd /d/Projects/Operator && "C:\\Program Files\\nodejs\\node.exe" scripts/operator-action.mjs:*)',
    'Bash(cd /d/Projects/Operator && "C:\\Program Files\\nodejs\\node.exe" scripts/log-update.mjs:*)',
    /*
      The same command as the repo tells it to write it.

      Measured 2026-09-01: asked the time, the worker ran
      `"C:\Program Files\nodejs\node.exe" scripts/operator-action.mjs now`,
      was asked for permission, tried the fully-qualified script path, and was
      asked AGAIN. Two prompts for the one command this list exists to
      pre-approve.

      Nothing was wrong with what it ran. CLAUDE.md tells it that plain `node`
      is shadowed by a broken binary one directory above the repo and to use
      the real path — so our own guidance produced a command our own allow-list
      did not match. These entries close that gap rather than asking the model
      to spell it the one way the pattern expects, which it has no way to know.
    */
    /*
      **The backslashes are escaped here, and that is the entire point.**

      These three were written as plain quoted strings, so JavaScript consumed
      the escapes before the matcher ever saw them: `\P` silently drops its
      backslash, and `\n` in `\nodejs` becomes a NEWLINE. What actually reached
      the SDK was a rule containing two line breaks, which cannot match any
      command.

      Measured from his phone, 2026-09-01: every capability call still asked
      permission — as if these lines were absent. They were written to fix
      exactly that symptom, looked correct in the diff, and did nothing.

      A pre-allow rule fails SILENTLY: an entry matching nothing is
      indistinguishable from an entry never added. If you touch this list,
      print it and read what the strings actually contain.
    */
    'Bash("C:\\Program Files\\nodejs\\node.exe" scripts/operator-action.mjs:*)',
    'Bash("C:\\Program Files\\nodejs\\node.exe" "D:\\Projects\\Operator\\scripts\\operator-action.mjs":*)',
    'Bash("C:\\Program Files\\nodejs\\node.exe" "D:\\Projects\\Operator-agent\\scripts\\operator-action.mjs":*)',
    // Forward slashes as well — the model writes Windows paths both ways.
    'Bash("C:/Program Files/nodejs/node.exe" scripts/operator-action.mjs:*)',
    /*
      Rendering a page to a PNG so the model can look at what it built
      (server/render.mjs). Pre-allowed because the alternative is asking a
      person "does this look right?", which is the round trip the whole thing
      exists to remove — a permission prompt per look would leave that cost
      exactly where it was. It writes only into data/renders/, reaches no
      external host, and reads nothing the worker could not already Read.
    */
    "Bash(node scripts/render.mjs:*)",
    /*
      Hosted apps (server/apps.mjs). Reading is pre-allowed; **restarting is
      deliberately not**, and the omission is the design rather than an
      oversight.

      The registry already makes this a named capability — a worker can say
      which app, never what command — so the question is only whether taking a
      running app down should happen without the owner noticing. One tap on the
      phone is a far lighter gate than arming the terminal, and it is exactly
      what ADR 0012 made cheap: the turn suspends and carries on with the
      answer. Ordinary work stays silent; disrupting something someone may be
      using asks once.

      Widen it to `Bash(node scripts/app.mjs:*)` if that ever becomes friction.
    */
    /*
      Handing a piece of work down to a cheaper model (server/delegate.mjs).

      Pre-allowed because a gate here would defeat it. The point of delegation
      is that the expensive worker stops doing the cheap reading — if every
      hand-off costs a tap on the phone, it does the reading itself, which is
      the behaviour this exists to change.

      Safe to pre-allow on its own terms: the sub-task gets NO tools, so it
      cannot write anything; it reads only files inside the project, which this
      worker could already Read; and it reaches only AI Router or the local
      model, both already approved and already registered as workers.
    */
    "Bash(node scripts/delegate.mjs:*)",
    'Bash("C:\\Program Files\\nodejs\\node.exe" scripts/delegate.mjs:*)',
    'Bash("C:/Program Files/nodejs/node.exe" scripts/delegate.mjs:*)',
    "Bash(node scripts/app.mjs list:*)",
    "Bash(node scripts/app.mjs status:*)",
    // Git, minus the one that publishes — which the deny list stops outright.
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git branch:*)",
    "Bash(git checkout:*)",
    "Bash(git stash:*)",
    "Bash(git worktree list:*)",
    // Looking around the filesystem.
    "Bash(ls:*)",
    "Bash(cat:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
    "Bash(wc:*)",
    "Bash(find:*)",
    "Bash(grep:*)",
    "Bash(rg:*)",
    "Bash(echo:*)",
    "Bash(pwd:*)",
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

/**
 * Told to the model, because how it should behave depends on which refusal it
 * hits, and the two are not the same.
 *
 * **Asking is now possible and retrying is now correct** — for everything
 * except the two denied tools. Under the SDK a tool outside the pre-allow list
 * suspends the turn and asks the owner, so "it stopped, ask again" is no longer
 * the model's problem to work around. Telling it otherwise would make it avoid
 * the exact tools the whole feature exists to unblock.
 *
 * The two denied ones are unchanged: they are refused before the question is
 * ever asked, so retrying them is a loop with no exit.
 */
const APPEND_PROMPT = [
  "You are running inside Operator.",
  "Tools outside a pre-approved list pause the turn and ask the owner on his phone;",
  "he may take a while to answer, and a denial there is a considered no — respect it",
  "and carry on with the rest of the work rather than looking for another route to",
  "the same thing.",
  `Separately, these are denied outright and can never be approved: ${DENIED_TOOLS.join(", ")}.`,
  "You will not be asked about those. If your work needs one, DO NOT retry it and do not",
  "try to reach it another way. Finish everything else, then write the exact command out",
  "for the owner to run in Operator's terminal himself, and note it in",
  "docs/handoffs/CURRENT.md so it survives a restart.",
  /*
    The capability layer, stated plainly, because the wrong instinct here is
    an expensive one: asked to tick off a gym session or add a mission, a
    coding agent's default is to go and edit source code. That is the slow,
    risky path to a data change — it needs a build, sometimes a restart, and
    it puts a code diff in the way of what was meant to be one row changing.
  */
  "To change the owner's own data — gym, missions, calendar, daily routine —",
  "use the capability layer, NOT source edits:",
  "`node scripts/operator-action.mjs list` shows every action and its parameters,",
  "and `node scripts/operator-action.mjs <action> '<json params>'` runs one.",
  "These are pre-approved, validated, and do exactly what the app's own UI does.",
  "Only edit source when the request is genuinely about changing how Operator",
  "*works*, rather than what it currently holds.",
  /*
    Name the read actions inline rather than trusting `list` to be run.

    Measured 2026-08-31: asked "what time is it", this worker ran
    `PowerShell Get-Date` over two attempts and charged $0.58. The prompt above
    already said the catalogue existed — but a model will not spend a tool call
    discovering a catalogue before answering something it believes it can
    answer in one shot. So the few that come up constantly are named here,
    where they cost nothing to know.
  */
  "READS matter as much as writes, and these are the ones that come up:",
  "`now` (the date, time and weekday), `gym_day`, `missions_list`,",
  "`calendar_range`, `routine_day`.",
  "Do NOT shell out for something an action already answers — no `Get-Date` for",
  "the time, no reading data/operator.json, no grepping source to find out what",
  "the owner has scheduled. Those are slower, cost more, and can be wrong in",
  "ways the action cannot.",
  /*
    Said out loud because a capability nobody mentions does not get used. A
    session spent three round trips asking the owner whether a generated PDF
    looked right, while its own Read tool could have shown it the pages.
  */
  "LOOK AT WHAT YOU PRODUCE. You can see images and PDFs by Reading them —",
  "Read takes a `pages` range for a PDF. For HTML and SVG, which have no",
  "picture until something lays them out, run",
  "`node scripts/render.mjs <file-or-localhost-url> --width W --height H`",
  "and Read the PNG it prints. Only the viewport is captured, so make the",
  "height tall enough. Check your own visual work this way instead of asking",
  "the owner whether it came out right.",
  /*
    Delegation, stated as an instruction rather than an option.

    The owner's ask on 2026-09-02: Claude takes everything in and dispatches,
    the other models help, and it only does the heavy lifting when the work
    genuinely needs it. A tool this model is merely TOLD EXISTS will not get
    used — its default is to read the file itself, because that always works.
    So the prompt names the shapes where delegating is the right call, and says
    plainly which half of the job stays here.
  */
  /*
    Recording what you finished, stated as an obligation.

    Operator can only tell him what happened if the thing that happened said
    so. A worker that finishes silently is invisible to the surface he actually
    looks at, which is the gap this closes.
  */
  /*
    Two habits that came from a broken worktree and outlived it.

    The agent worktree was 183 commits behind, so `scripts/` did not have the
    capability layer and the agent learned to `cd` to the main checkout. That
    prefix broke every pre-allow rule, which is why a pre-allowed script was
    asked about twelve times. The drift is fixed; the habit needs saying.
  */
  "You are ALREADY in the right checkout. Do NOT prefix commands with",
  "`cd /d/Projects/Operator` — it breaks the pre-allow rules and makes ordinary",
  "work ask permission. Run `node scripts/…` directly.",
  "Do NOT curl Operator's own API to read its data either. Every read has a",
  "capability action, they are pre-approved, and they return exactly what you",
  "need instead of the whole store.",
  "WHEN YOU FINISH work that changed anything, record it:",
  "`node scripts/operator-action.mjs work_record '{\"summary\":\"…\",\"by\":\"Claude Code\",\"files\":[\"…\"]}'`.",
  "One line saying what happened, and `needsOwner: true` ONLY when he actually",
  "has to do something himself. That is how Operator answers \"what did you do\"",
  "and \"did anything happen while I was out\" — it cannot see work it did not",
  "dispatch unless the work says so.",
  "PASS `mission` when the work belongs to one — the id from `missions_list`, or",
  "its exact name. That writes the same line to the mission's activity, which is",
  "how the board stays current without anyone remembering to update it. Progress",
  "percentages stay his: a percentage is a judgement, not a fact you can derive.",
  /*
    The handoff, named as an action rather than as a file.

    It has been a rule in CLAUDE.md since restarts became routine, and it was
    followed roughly never — because the model had to remember a path, and
    because a job writes in the `agent` worktree while the Updates page renders
    main's copy, so the note it wrote was invisible on his phone anyway. Both
    are fixed underneath (server/handoff.mjs always writes the served copy);
    what is left is saying so here, since a capability nobody mentions does not
    get used.
  */
  "KEEP THE HANDOFF CURRENT — it is the only record that survives a restart,",
  "and a restart destroys every job's event log including this conversation's.",
  "`handoff_read` at the start of a piece of work (what was half-finished, what",
  "the last session could not verify), `handoff_write` as you go and ALWAYS",
  "before asking for a restart, and `handoff_fold` with a short slug when a",
  "piece of work is genuinely finished. It replaces rather than appends: short",
  "and true beats long and stale. Do not write the file with Write — you are in",
  "the agent worktree and that copy is not the one the app shows him.",
  "YOU ARE THE ONE DISPATCHING, not the one who has to do everything.",
  "`node scripts/delegate.mjs \"<task>\" --file <path> --file <path>` hands one",
  "piece of work to a cheaper model (AI Router, flat rate) and prints its answer.",
  "The sub-task gets NO tools and cannot change anything — it reads and reports.",
  "Delegate the bulk reading: summarising a long file or diff, finding which of",
  "twenty files mentions a thing, drafting boilerplate, checking a document for",
  "contradictions, writing a first pass you will then review. It costs you one",
  "command and a short answer instead of the whole file in your context.",
  "Keep for yourself: the decisions, anything touching correctness, the final",
  "edit, and anything where being wrong is expensive. Delegating is not a",
  "requirement — do the work directly when it is small, when you already have",
  "the file, or when the judgement IS the task.",
  "To restart an app Operator hosts, use `node scripts/app.mjs restart <name>`",
  "(`list` shows them) rather than running its stop and start commands yourself —",
  "it confirms the app actually stopped before starting it, waits until it answers,",
  "and shows the log tail if it does not. Restarting asks the owner first; listing",
  "and checking status do not.",
].join(" ");

/**
 * The standing prompt plus what Operator knows about the owner.
 *
 * Memory is appended here rather than baked into APPEND_PROMPT because it
 * changes: a fact learned this morning has to reach this afternoon's turn, and
 * a constant computed at module load never would.
 *
 * `recallFor` returns the empty string when nothing is known, so a fresh
 * install pays nothing — no "you know nothing about the user" sentence
 * occupying tokens forever, which is the shape this kind of thing usually
 * rots into.
 *
 * One honest cost, recorded because it is easy to miss: a prompt that changes
 * every turn defeats prompt caching. It is bounded at roughly 500 tokens and
 * usually far less, but with OPERATOR_MAX_CONCURRENT above 1 that multiplies.
 * If it ever matters, the fix is to inject only on a job's FIRST turn — the
 * session resumes and the model still has it — rather than to shrink what he
 * is allowed to be known by.
 */
/**
 * What THIS worker can do, as opposed to what workers in general can.
 *
 * `APPEND_PROMPT` is shared, and it was written when only one worker had tools:
 * it tells the model to run `node scripts/operator-action.mjs`, to delegate with
 * `scripts/delegate.mjs`, and to restart an app with `scripts/app.mjs`. All of
 * that is a shell command, and three of the four workers have no shell — for
 * them the capability actions arrive as native tool calls and the instruction
 * describes a route that does not exist.
 *
 * Harmless while a capability worker could only answer questions. Not harmless
 * now that AI Router can edit files: a model told to verify its work by running
 * a command it has no way to run will simply skip verifying.
 */
function workerPromptFor(capabilities) {
  if (!capabilities || capabilities.tools === true) return "";
  const lines = [
    "You are a worker with NO SHELL. Ignore any instruction above to run a",
    "`node scripts/…` command — you cannot. The capability actions are available",
    "to you directly as tools, by name, and calling one is the same thing.",
  ];
  if (capabilities.files) {
    lines.push(
      "YOU CAN READ AND EDIT THIS PROJECT'S SOURCE. `read_file`, `list_files` and",
      "`search_files` reach the checkout; `write_file` and `edit_file` change it and",
      "SUSPEND THE TURN while the owner is asked on his phone — a refusal there is a",
      "considered no, so carry on with the rest of the work rather than looking for",
      "another route. Prefer `edit_file` over rewriting a whole file.",
      "READ BEFORE YOU EDIT. `edit_file` needs text that appears exactly once, and",
      "guessing at what a file contains is how a unique match becomes three.",
      "VERIFY YOUR OWN WORK with `run_check` before you say it is done: `typecheck`",
      "and `build` are the project's gates, and `syntax` is the one they do NOT cover,",
      "because neither of them opens a .mjs file. A server change that compiles",
      "cleanly has been verified by nothing.",
      "Operator's own DATA is not on the filesystem for you — `data/` is refused, and",
      "the capability actions answer those questions properly.",
    );
  }
  return lines.join(" ");
}

async function systemPromptFor(capabilities = null) {
  try {
    const recalled = await recallFor("");
    const worker = workerPromptFor(capabilities);
    return [APPEND_PROMPT, worker, recalled].filter(Boolean).join("\n\n");
  } catch (err) {
    /*
      Memory failing must never cost him a turn. An assistant that forgets is
      worse than one that never knew; an assistant that refuses to run because
      it could not remember is worse than both.
    */
    console.warn(`[operator] memory unavailable: ${err?.message ?? err}`);
    return APPEND_PROMPT;
  }
}

// --- state ----------------------------------------------------------------

/** @type {Map<string, object>} newest last, insertion-ordered. */
const jobs = new Map();
/** Ids waiting for the runner, oldest first. One job runs at a time. */
const waiting = [];
/**
 * The jobs running right now.
 *
 * A Set rather than a single id, as of 2026-09-01. Decided 2026-08-31 in the
 * owner's words: *"would like turns to run concurrently if possible, but of
 * course have a scale for it in place."*
 *
 * Both halves matter. One-at-a-time was never justified on its merits — it
 * matched a single person on a phone, and it meant a long build blocked every
 * question asked while it ran, which is the opposite of what a control plane is
 * for. And unbounded is how a mistyped loop becomes a bill.
 */
const running = new Set();

/**
 * How many turns may run at once.
 *
 * Environment-only, and default 1 so nothing changes until it is deliberately
 * set. App-editable would let a worker widen its own fan-out, which is the same
 * reasoning that keeps OPERATOR_TERMINAL_DEVICES and OPERATOR_APPS out of the
 * store.
 *
 * Raising this multiplies spend by N. `store.mjs`'s withState() is race-safe for
 * a read-modify-write, which is NOT the same as two workers making sensible
 * decisions about the same mission — deliberate concurrency will find more of
 * that class of bug than the incidental kind already has.
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.OPERATOR_MAX_CONCURRENT ?? 1) || 1);
let jobSeq = 0;

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
    provider: job.provider,
    sessionId: job.sessionId,
    model: job.model,
    device: job.device,
    turns: job.turns,
    costUsd: job.costUsd,
    createdAt: job.createdAt,
    resources: job.resources,
    task: job.task,
    handoff: job.handoff,
    // Prompts stay out of the index: a restored tab keeps its provider session,
    // not a second private transcript. Attempts retain only operational facts.
    attempts: job.attempts.map(({ number, provider, model, status, startedAt, endedAt, error }) => ({
      number,
      provider,
      model,
      status,
      startedAt,
      endedAt,
      error,
    })),
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

/**
 * Wait until the job index is actually on disk.
 *
 * Every other `persist()` call is `void`-ed, which is correct in the middle of
 * a turn and wrong on the way out: `process.exit()` does NOT wait for pending
 * I/O, so an un-awaited write can be cut between `writeFile` and `rename` —
 * leaving an orphan `.tmp` and the previous jobs.json. Tmp-then-rename stops a
 * TRUNCATED file; it does nothing for a write that never got to run.
 *
 * A shutdown calls this and awaits it. Nothing else needs to.
 */
export function flush() {
  return persist();
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
        provider: entry.provider ?? DEFAULT_PROVIDER,
        sessionId: entry.sessionId,
        model: entry.model ?? DEFAULT_MODEL,
        device: entry.device ?? null,
        turns: Number(entry.turns) || 0,
        costUsd: Number(entry.costUsd) || 0,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        resources: Array.isArray(entry.resources) ? entry.resources : [],
        task: entry.task && typeof entry.task === "object" ? entry.task : blankTask(),
        handoff: entry.handoff && typeof entry.handoff === "object" ? entry.handoff : null,
        attempts: Array.isArray(entry.attempts) ? entry.attempts : [],
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
    provider: DEFAULT_PROVIDER,
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
    /** The CLI fallback's child process, when that path is in use. */
    proc: null,
    /** The SDK path's stop button. Aborts the turn *and* any open question. */
    abort: null,
    /** Set by the SDK path so `ask()` can stand the idle timer down. */
    touchIdle: null,
    /** Questions outstanding. Non-zero means waiting on a person, not stuck. */
    awaitingPermission: 0,
    /** Local files attached to this conversation, never stored in operator.json. */
    resources: [],
    /** The orchestrator's provider-neutral description of the current work. */
    task: blankTask(),
    /** Last completed worker-to-owner handoff; a later worker can consume it. */
    handoff: null,
    /** In-memory retry payload plus persistable execution facts. */
    attempts: [],
    /**
     * Automatic recoveries spent on this job — see `recoverFromLimit`. In
     * memory, and deliberately not reset by a manual retry: two failed
     * hand-offs mean the owner should look, not that the job should keep
     * shopping for a worker that will take it.
     */
    recoveries: 0,
    /** `{ until, timer, provider }` while a turn waits out a worker's cooldown. */
    backoff: null,
  };
}

/**
 * Stop whichever runner this job is using.
 *
 * Both paths, one call, because every caller wants "stop it" and none of them
 * should have to know which runner is behind this job. Missing the SDK half was
 * the obvious way to ship a Stop button that silently did nothing.
 */
function halt(job) {
  if (job.proc) job.proc.kill();
  if (job.abort) job.abort.abort();
  /*
    A turn waiting out a worker's cooldown is a turn this job is in the middle
    of, even though nothing is running. Without this, Stop would look like it
    worked and the timer would put the job back on the queue minutes later.
  */
  if (job.backoff) {
    clearTimeout(job.backoff.timer);
    job.backoff = null;
  }
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
  const attempt = job.attempts.at(-1);
  if (attempt?.status === "running" && ["complete", "failed", "blocked", "cancelled"].includes(status)) {
    attempt.status = status;
    attempt.endedAt = new Date().toISOString();
    attempt.error = detail;
    /*
      Verification starts as "running", and is filled in a moment later.

      It cannot be awaited here: setStatus is called from the middle of the turn
      loop and a build takes minutes, so blocking would hold the job open long
      after the work finished. So the job completes, the checks run, and the
      verdict lands on the job afterwards with its own event — which is also
      the honest shape, because "done" and "checked" genuinely are two
      different moments.

      Only after a COMPLETE turn. A failed or cancelled one has nothing worth
      building, and running a four-minute build over a cancelled job is a way
      to make cancelling feel broken.
    */
    if (status === "complete") {
      job.task.verification = {
        requested: true,
        status: "running",
        note: "checking the workspace…",
      };
      void runVerification(job);
    } else {
      /*
        Only failed and blocked. A turn he cancelled himself needs no telling,
        and a completed one he asked for two minutes ago is noise — but work
        that stopped without him is exactly what he cannot see from a phone.
      */
      if (status === "failed" || status === "blocked") {
        void notify(
          `Operator job ${status}`,
          `${job.title || job.id}${detail ? ` — ${detail}` : ""}`.slice(0, 300),
          { priority: "high", tags: [status === "blocked" ? "no_entry" : "warning"] },
        );
      }
      job.task.verification = {
        requested: job.task.verification?.requested === true,
        status: "not-run",
        note: `turn ended ${status}; nothing to verify`,
      };
    }
    job.handoff = {
      from: { provider: attempt.provider, model: attempt.model, attempt: attempt.number },
      to: "owner-or-next-worker",
      status,
      at: attempt.endedAt,
      resourceIds: job.resources.map((resource) => resource.id),
      verification: job.task.verification,
      ...(detail ? { detail } : {}),
    };
    emit(job, "handoff", { handoff: job.handoff });

    /*
      And into the durable work log, so this survives a restart and sits
      alongside work done by sessions Operator did not dispatch.

      `job.handoff` above is in memory and dies with the process — which was
      fine while it was bookkeeping for a future verifier, and is not fine now
      that the owner asks Operator what happened. One ledger, every finisher.

      Fire-and-forget and never fatal: failing to write the log must not fail
      the turn that already succeeded.
    */
    void runAction("work_record", {
      summary: `${job.title || job.id} — ${status}`,
      detail: detail || "",
      by: `${attempt.provider}${attempt.model ? ` (${attempt.model})` : ""}`,
      kind: "job",
      jobId: job.id,
      /*
        Blocked means a permission question is waiting and the turn is
        suspended; failed means it needs looking at. Complete does not need
        him, which is the whole point of the flag.
      */
      needsOwner: status === "blocked" || status === "failed",
    }).catch((err) => console.warn(`[operator] work log: ${err?.message ?? err}`));
  }
}

/**
 * Run the gates over whatever the job left behind, and record the verdict.
 *
 * Deliberately never throws and never changes the job's status: a verifier that
 * can break a job is worse than no verifier. A failed check is INFORMATION —
 * the work happened, and this says whether it holds up — so it is reported and
 * the owner decides. Turning a red build into a failed job would also make
 * "cancel" and "the build broke" look identical in the tab strip.
 */
async function runVerification(job) {
  try {
    const result = await verifyWorkspace(JOB_CWD);
    job.task.verification = {
      requested: true,
      status: result.status,
      note: result.note,
      checks: result.checks.map((c) => ({
        name: c.name,
        passed: c.passed,
        ms: c.ms,
        // Only the failing output is kept. A passing build's stdout is
        // hundreds of lines nobody reads, and this rides in every poll.
        ...(c.passed ? {} : { output: c.output }),
      })),
      changed: result.changed.length,
    };
    if (job.handoff) job.handoff.verification = job.task.verification;
    emit(job, "verification", job.task.verification);
    console.log(
      `[operator] ${job.id} verification: ${result.status} — ${result.note}`,
    );

    /*
      The second layer: did it do what was ASKED, not just does it compile.

      Stored as a sibling field and never as a `status` value. The frontend
      colours on `status`, so letting a 3B model's opinion write there would
      let a guess render as a red build — and `status` is the thing that cannot
      be wrong. Two fields, two kinds of certainty, told apart.

      Runs after the gates and only when they found something to check: with
      `status: "skipped"` nothing changed, so there is no diff to review and a
      job that merely answered a question is one the owner reads himself.

      Emitted a second time rather than awaited before the first emit — the
      local model is slow enough (cold start alone was measured at 21s) that
      holding the deterministic verdict back for it would make the fast, certain
      answer arrive at the speed of the slow, uncertain one.
    */
    if (result.status !== "skipped") {
      const attempt = job.attempts.at(-1);
      const request =
        attempt?.prompt ||
        /*
          `attempts[].prompt` is in memory only, so a job restored after a
          restart has none. Falling back to the last prompt event keeps this
          working across the restarts that are a normal part of editing
          Operator; the title is a 60-char summary and would be reviewed
          against as if it were the brief, which is worse than not running.
        */
        [...job.events].reverse().find((e) => e.type === "prompt")?.text ||
        "";
      const claimed = [...job.events]
        .reverse()
        .find((e) => e.type === "text" && !e.error)?.text ?? "";

      const semantic = await reviewWork({
        cwd: JOB_CWD,
        request,
        claimed,
        // Null on a restored job whose turn predates the restart; reviewWork
        // falls back to HEAD, which is what it always did.
        since: job.workspaceBefore ?? null,
      });
      if (semantic && job.task.verification) {
        job.task.verification.semantic = semantic;
        if (job.handoff) job.handoff.verification = job.task.verification;
        emit(job, "verification", job.task.verification);
        console.log(
          `[operator] ${job.id} semantic: ${semantic.verdict} (${semantic.model}, ${semantic.ms}ms) — ${semantic.note}`,
        );
      }
    }
  } catch (err) {
    // Even the verifier failing is a verdict worth recording rather than
    // swallowing: "could not check" is different from "checked and fine".
    job.task.verification = {
      requested: true,
      status: "error",
      note: `verification could not run: ${String(err?.message ?? err).slice(0, 200)}`,
    };
    emit(job, "verification", job.task.verification);
  }
}

function blankTask(kind = "coding") {
  return {
    kind,
    context: { resourceIds: [] },
    // Deliberately a request, not a claim. A future verifier worker may satisfy
    // it; until then the event log/tool results are the evidence.
    verification: { requested: true, status: "not-run", note: "No separate verifier is configured." },
  };
}

function beginAttempt(job, prompt) {
  const attempt = {
    number: job.attempts.length + 1,
    provider: job.provider,
    model: job.model,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    // Never persisted — it can carry owner content and is only needed for a
    // deliberate retry while this server is alive.
    prompt,
  };
  job.attempts.push(attempt);
  job.task.context = { resourceIds: job.resources.map((resource) => resource.id) };
  job.handoff = null;
  return attempt;
}

/** One line, short enough for a tab. */
function titleFrom(prompt) {
  const line = String(prompt).replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled";
}

/** Claude Code accepts files by local path, so name each newly attached path plainly. */
function promptWithResources(text, resources) {
  if (!resources.length) return text;
  const files = resources.map((resource) => `- ${resource.name}: ${resource.path}`).join("\n");
  return `Attached files (read these local paths if relevant):\n${files}\n\n${text}`;
}

/** Drop the oldest finished jobs once there are too many. Never drops a live one. */
function prune() {
  while (jobs.size > MAX_JOBS) {
    const victim = [...jobs.values()].find(
      (j) => !running.has(j.id) && !waiting.includes(j.id) && j.pending.length === 0
    );
    if (!victim) return;
    jobs.delete(victim.id);
    void removeJobResources(victim.id);
  }
}

// --- ceilings -------------------------------------------------------------

/**
 * Whether there is room to *start* another turn for this job.
 *
 * Checked before spawning, never during. The owner's requirement was to stop
 * before the limit rather than at it — "if I overlap it becomes half done and
 * stuff would break" — and killing a turn mid-edit is precisely that breakage.
 * So a turn that starts is always allowed to finish; what a ceiling does is
 * refuse the next one.
 *
 * The reasoning behind each ceiling lives in `usage.mjs`; this is only the call
 * site. `job.costUsd` is passed rather than read there because a job's running
 * total is job bookkeeping, not accounting state.
 */
function ceilingBlockFor(job) {
  return checkCeiling({ provider: job.provider, model: job.model, jobUsd: job.costUsd });
}

/** The accounting, for `list()` and anything that renders a number. */
export function usage() {
  return usageSnapshot();
}

/**
 * The flat pair the current Orchestrator footer reads.
 *
 * Both are pinned to one basis by `usageSnapshot()` — they are **not** a total
 * across bases, and there deliberately is no such total. Kept only so the
 * existing UI keeps working; the page should move to the `today` breakdown and
 * these should then go.
 */
function legacyUsageFields() {
  const { spentUsd, budgetUsd } = usageSnapshot();
  return { spentUsd, budgetUsd };
}

// --- questions ------------------------------------------------------------
//
// A permission the owner has not answered yet.
//
// This is the whole of ADR 0012 in one map. `canUseTool` hands us a promise's
// worth of suspended turn; we park the resolver here, emit an event the phone
// can render, and settle it when he taps. The turn is *inside* that await the
// entire time — not polling, not restarted afterwards, the same turn with the
// same context, waiting.
//
// Everything else in this section exists so that the await always ends: by an
// answer, by the timeout, or by a cancel. A resolver that leaks is a job that
// hangs forever and, since one job runs at a time, a queue that never moves.

/** @type {Map<string, object>} permission id → the parked question. */
const questions = new Map();
let questionSeq = 0;

/*
  Rules the owner said to stop asking about, for as long as this server runs.

  **In memory, deliberately, and not the same thing as `allowRule` below.**
  Writing to `.claude/settings.local.json` is how the old post-hoc grant worked
  and it survives a restart, but it is read by Claude Code when it builds a
  session — so a rule written mid-conversation may not apply to the very turn
  that is sitting there waiting for it. This set is checked by us, before we
  ask, so "don't ask again" means it from the next question onwards with no
  ambiguity about when it takes effect.

  The cost is that it is forgotten on restart. That is the honest trade: a
  remembered grant that quietly stops applying is worse than one you re-tap.
*/
const remembered = new Set();

/** What the question is about, in one line, for a phone. */
function questionRule(tool, subject) {
  return subject ? `${tool}(${subject})` : tool;
}

/**
 * Ask the owner, and suspend until he answers.
 *
 * @returns {Promise<boolean>} true to allow
 */
function ask(job, req) {
  const rule = questionRule(req.tool, req.subject);

  // Already answered once with "don't ask again" — honour it without a round
  // trip. Checked before anything is emitted so the log doesn't fill with
  // questions that were never really asked.
  if (remembered.has(rule)) return Promise.resolve(true);

  /*
    Already stopping. `addEventListener` on a signal that has *already* aborted
    never fires, so registering the teardown below would park a question nothing
    could settle — and it would sit there for the full permission timeout on a
    job the owner had stopped half an hour earlier. Narrow window (cancel landing
    between the tool call and this callback) and easy to never see in testing,
    which is why it is worth a line rather than a comment.
  */
  if (req.signal?.aborted) return Promise.resolve(false);

  const id = `perm-${++questionSeq}`;
  return new Promise((resolve) => {
    let settled = false;

    const finish = (allowed, decision, by = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener?.("abort", onAbort);
      questions.delete(id);
      job.awaitingPermission = Math.max(0, (job.awaitingPermission ?? 0) - 1);
      emit(job, "permission_answer", { id, rule, decision, by });
      // Silence means "stuck" again now that nobody is being waited on.
      job.touchIdle?.();
      resolve(allowed);
    };

    const timer = setTimeout(() => finish(false, "timeout"), PERMISSION_TIMEOUT_MS);
    timer.unref?.();

    /*
      The third `canUseTool` argument earns its place here.

      Without the signal, pressing Stop on a job that is waiting to be answered
      would abort the SDK's turn while this promise stayed pending — the job
      would report cancelled, the resolver would sit in this map forever, and
      the runner claim would only come back at the permission timeout, half an
      hour later, for a job the owner thought he had stopped.
    */
    const onAbort = () => finish(false, "cancelled");
    req.signal?.addEventListener?.("abort", onAbort, { once: true });

    questions.set(id, {
      id,
      jobId: job.id,
      tool: req.tool,
      subject: req.subject,
      rule,
      finish,
    });
    job.awaitingPermission = (job.awaitingPermission ?? 0) + 1;
    // Stand the idle timer down. A turn waiting on a person is not a turn that
    // has hung, and the tool-idle timeout would otherwise kill it at 45
    // minutes for the crime of being patient.
    job.touchIdle?.();

    /*
      The one notification that genuinely matters.

      The turn is SUSPENDED right now and dies after thirty minutes. Until this
      existed the only way to find out was to open the app and look, and he is
      usually not looking — which is the whole point of a system that works
      while he is at work.

      `void` and never awaited: notify() has its own timeout and swallows its
      own failures, but a three-second POST must not sit in front of the event
      that renders the question on screen.

      No dedupe needed. A rule already answered with "stop asking" returns from
      `remembered` above without ever reaching here.
    */
    void notify(
      "Operator needs you",
      `${req.tool} — ${rule}`.slice(0, 300),
      // Urgent, not high: the turn is SUSPENDED and dies in thirty minutes.
      { priority: "urgent", tags: ["question"], click: process.env.OPERATOR_APP_URL || "" },
    );

    emit(job, "permission_request", {
      id,
      tool: req.tool,
      subject: req.subject,
      rule,
      // The bridge's own sentence ("Claude wants to read foo.txt") when it gave
      // us one — it knows things this file doesn't, such as which path inside a
      // Bash command triggered the ask.
      title: req.title || "",
      description: req.description || "",
      // Answerable, as opposed to the after-the-fact denial records the CLI
      // path emits under this same type. The client keys its buttons on this:
      // an old event log from before a restart has no `id` and must not render
      // a button that resolves nothing.
      pending: true,
      standing: false,
    });

    console.log(`[operator] job ${job.id} is asking about ${rule}`);
  });
}

/**
 * Answer one. Called by the route the phone taps.
 *
 * @param {string} id
 * @param {"allow"|"deny"} decision
 * @param {boolean} remember  stop asking about this rule until the server restarts
 */
export function answerPermission(id, decision, remember, identity) {
  const q = questions.get(id);
  /*
    Gone rather than wrong. A question disappears on its own three ways — the
    timeout, a cancel, or the job being closed — and every one of them can race
    a tap that was already on its way. Saying "that one has gone" is honest and
    harmless; a 404 would render as a failure on a phone that did nothing wrong.
  */
  if (!q) return { answered: false, reason: "that question has already been settled" };

  const allowed = decision === "allow";
  if (allowed && remember) remembered.add(q.rule);
  q.finish(allowed, allowed ? "allowed" : "denied", identity?.device ?? null);

  console.log(
    `[operator] ${allowed ? "allowed" : "denied"} by ${identity?.device ?? "unknown"}: ${q.rule}` +
      (allowed && remember ? " (and won't ask again)" : "")
  );
  return { answered: true, rule: q.rule, decision, remembered: Boolean(allowed && remember) };
}

/** Questions outstanding on one job — so a reopened tab knows what it owes. */
export function openQuestions(jobId) {
  return [...questions.values()]
    .filter((q) => q.jobId === jobId)
    .map(({ id, tool, subject, rule }) => ({ id, tool, subject, rule }));
}

/** Tear down every question on a job. Used when it is cancelled or closed. */
function dropQuestions(jobId, decision) {
  for (const q of [...questions.values()]) {
    if (q.jobId === jobId) q.finish(false, decision);
  }
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
  while (waiting.length && running.size < MAX_CONCURRENT) {
    const job = jobs.get(waiting[0]);
    if (!job || job.pending.length === 0) {
      waiting.shift();
      continue;
    }
    waiting.shift();
    /*
      Claim the runner HERE, synchronously, not inside runTurn.

      runTurn awaits `resolveExecutable` before it claims a slot, so the
      guard at the top of this function and the assignment were separated by a
      microtask. Two calls into pump() in that window — two devices sending at
      once, or an input() racing the deferred re-pump — both saw a free runner
      and both spawned. Two `claude -p` processes editing the same repo is
      precisely what one-at-a-time exists to prevent, and it would have been
      near-impossible to diagnose from the symptoms.

      Claiming before any await closes it: JavaScript runs this to completion
      before another call can observe it.
    */
    running.add(job.id);
    /*
      An unhandled rejection here is not a lost turn, it is a dead server —
      Node's default is to throw on one, and this is called from a `void` with
      nobody downstream to catch it. Both runners handle their own failures, so
      reaching this means something unforeseen; report it on the job, hand the
      runner back, and let the queue carry on rather than taking Operator down
      with it.
    */
    void runTurn(job).catch((err) => {
      const detail = String(err?.message ?? err).slice(0, 500);
      console.error(`[operator] job ${job.id} runner threw:`, detail);
      job.error = detail;
      setStatus(job, "failed", detail);
      running.delete(job.id);
      queueMicrotask(pump);
    });
    /*
      Keep going rather than returning. The single-slot version returned after
      claiming, because there was nothing left to claim; with a ceiling above
      one, stopping here would start exactly one job per pump() call and the
      queue would drain at the speed of whatever happens to call it next.
    */
  }
}

/**
 * One turn, through the SDK. The real runner.
 *
 * Everything CLI-shaped is gone from this path: no argv, no NDJSON buffering,
 * no stderr scraping, no `.cmd` resolution. `runner.mjs` hands back parsed
 * events and this owns what they mean *to a job* — the accounting, the idle
 * timers, the session id, the queue.
 *
 * The caller has already claimed the runner and reset the job's counters.
 */
async function runViaSdk(job, prompt) {
  setStatus(job, "running");

  /*
    One controller for every way this turn can be stopped: the Stop button, the
    idle timeout, and the job being closed. `runner.mjs` forwards it to the SDK
    *and* to each open question, so a cancel unblocks a turn suspended on a
    permission instead of leaving it parked until the permission timeout.
  */
  const abort = new AbortController();
  job.abort = abort;

  let idle = null;
  function touch() {
    if (idle) clearTimeout(idle);
    idle = null;
    /*
      Three states, not two. Working (short fuse), waiting on a tool (long
      fuse), and waiting on a person (no fuse at all — see PERMISSION_TIMEOUT_MS,
      which is the bound on that one).
    */
    if ((job.awaitingPermission ?? 0) > 0) return;
    const ms = (job.outstandingTools ?? 0) > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    idle = setTimeout(() => {
      job.error = `no output for ${Math.round(ms / 60000)} minutes — stopped`;
      abort.abort();
    }, ms);
    idle.unref?.();
  }
  // `ask()` reaches for this by name when a question opens and closes.
  job.touchIdle = touch;
  touch();

  console.log(
    `[operator] job ${job.id} turn ${job.turns + 1} by ${job.device ?? "unknown"}` +
      `${job.sessionId ? ` (resuming ${job.sessionId.slice(0, 8)})` : " (new session)"}`
  );

  /*
    Wall-clock for the turn, recorded alongside the cost.

    The real defect of 2026-08-20 — 129 seconds and nine permission prompts to
    answer "what's my gym session today" — was invisible to a dollar meter and
    obvious in duration. Measured here rather than taken from the worker because
    it is the only number every provider can produce.
  */
  const startedMs = Date.now();
  // One provider request, against today's quota. Counted before the call: a
  // request that fails still spent the allowance, which is the whole reason
  // Gemini went from working to unusable inside one evening.
  countRequest(job.provider);

  let result;
  try {
    result = await runWorkerTurn(job.provider, {
      prompt,
      model: job.model,
      sessionId: job.sessionId,
      cwd: JOB_CWD,
      env: workerEnv(),
      deniedTools: DENIED_TOOLS,
      allowedTools: ALLOWED_TOOLS,
      // The SDK's own ceiling. The only one that can stop a runaway *inside* a
      // turn rather than refusing the next one.
      budgetUsd: jobCeilingUsd(),
      /*
        The drift warning rides along with the prompt.

        Being told is cheaper than discovering, and far cheaper than the wrong
        conclusion — that the missing action does not exist at all.
      */
      /*
        The worker's own capabilities decide half the prompt. A capability-only
        worker must not be told to run shell commands it has no way to run, and
        one WITH files has to be told it has them — an unmentioned tool is an
        unused tool, measured twice on this project already.
      */
      appendSystemPrompt: [
        await systemPromptFor(listProviders().find((p) => p.id === job.provider)?.capabilities),
        warningFor(job.worktree),
      ]
        .filter(Boolean)
        .join("\n\n"),
      /*
        Option C. `default` is the only mode that consults the callback —
        `bypassPermissions` decides for itself and would make every line of the
        questions section above dead code.
      */
      permissionMode: "default",
      signal: abort.signal,
      onEvent: (type, data = {}) => {
        switch (type) {
          case "session":
            // Persisted the moment it exists, not at the end of the turn.
            if (data.sessionId && !job.sessionId) {
              job.sessionId = data.sessionId;
              void persist();
            }
            return;
          case "tool_use":
            // Tracked so the idle timer can tell "waiting on a build" from
            // "stuck" — see TOOL_IDLE_TIMEOUT_MS.
            job.outstandingTools = (job.outstandingTools ?? 0) + 1;
            break;
          case "tool_result":
            job.outstandingTools = Math.max(0, (job.outstandingTools ?? 0) - 1);
            break;
          default:
            break;
        }
        emit(job, type, data);
        touch();
      },
      onPermission: (req) => ask(job, req),
    });
  } catch (err) {
    // runner.mjs handles its own errors and returns them; this is the belt to
    // that braces. An exception escaping here without releasing the runner
    // would stall every queued job behind it.
    result = { sessionId: job.sessionId, costUsd: 0, error: String(err?.message ?? err).slice(0, 500) };
  } finally {
    if (idle) clearTimeout(idle);
    job.touchIdle = null;
    job.abort = null;
    job.outstandingTools = 0;
    // Nothing should still be parked here — the abort tears questions down and
    // a clean turn cannot end with one outstanding. If one is, it is a leaked
    // resolver, and leaving it would hang the next thing that waits on it.
    dropQuestions(job.id, "abandoned");
    running.delete(job.id);
  }

  job.turns += 1;
  if (result.sessionId) job.sessionId = result.sessionId;

  /*
    Recorded whether or not it cost anything.

    The old code only counted a turn when `cost > 0`, which made every Gemini
    and Ollama turn invisible to the accounting — and those are exactly the ones
    a dollar figure cannot govern. `usage.mjs` decides what the number means;
    this hands it the facts and nothing else.

    `tokens` is not passed yet: `runner.mjs` reads `total_cost_usd` and drops the
    SDK's `usage` and `modelUsage` on the floor, so the counts are available and
    simply not plumbed through. When they are, add `tokens` here and the records
    become re-derivable with no other change.
  */
  const record = recordTurn({
    jobId: job.id,
    attempt: job.attempts.length,
    provider: job.provider,
    model: job.model,
    reportedUsd: typeof result.costUsd === "number" ? result.costUsd : null,
    durationMs: Date.now() - startedMs,
    turns: 1,
    error: Boolean(result.error),
  });

  const cost = typeof record.usd === "number" ? record.usd : 0;
  if (cost > 0) job.costUsd += cost;
  emit(job, "usage", {
    /*
      `basis` is the field that stops this number being read as money. On the
      subscription login it is a `valuation` — what the work would have cost at
      API list price — not a charge, and every label downstream must say so.
    */
    basis: record.basis,
    source: record.source,
    turnUsd: record.usd,
    jobUsd: job.costUsd,
    durationMs: record.durationMs,
    ...legacyUsageFields(),
  });

  // Cancelling is not failing. The status was set when Stop was pressed and the
  // abort that followed is the expected end, not an error to report over it.
  if (job.status === "cancelled") {
    void persist();
    pump();
    return;
  }

  // `job.error` carries the idle timeout's reason, which the SDK reports as a
  // plain abort with no message of its own.
  const failure = result.error ?? job.error ?? null;
  if (failure) {
    job.error = failure;
    /*
      Tell the router this worker is out of capacity, when that is what the
      failure means.

      Without this the router weighs capability and knows nothing about
      availability — so on 2026-08-21, Claude hit its session limit, the owner
      said "use a different model then duh", and the next two turns were routed
      straight back to Claude. `noteFailure` ignores ordinary errors; only
      "not now" phrasing sidelines a worker, and only for as long as that kind
      of limit plausibly lasts.
    */
    const kind = noteFailure(job.provider, failure);
    /*
      The provider itself saying "out for today" is the authority on its own
      quota, and worth more than Operator's local request count — which counts
      turns, while a worker like Gemini can spend several provider requests
      inside one. Recorded in the quota ledger, not enforced there: `routing.mjs`
      already steers away for six hours, and blocking here as well would stop a
      retry after the window genuinely resets.
    */
    if (kind === "daily") markQuotaExhausted(job.provider, { window: "day", source: "provider" });
    /*
      And carry THIS turn on, not just the next one.

      `noteFailure` above only helps the next job. The one that was running when
      the limit hit still died on the spot and waited for a tap — and `retry()`
      reuses `job.provider`, so that tap went straight back to the worker that
      had just said no. Same shape as the 2026-08-21 complaint the cooldown was
      built for, one job to the left of it.
    */
    if (!(kind && (await recoverFromLimit(job, kind, failure)))) {
      if (kind) {
        emit(job, "text", {
          text:
            kind === "daily"
              ? `_${job.provider} is out of quota for today — later work will route elsewhere._`
              : `_${job.provider} is unavailable right now — later work will route elsewhere._`,
        });
      }
      setStatus(job, "failed", failure);
    }
  } else {
    // A worker that just answered is plainly back, whatever it said last time.
    noteSuccess(job.provider);
    // And the job's recovery allowance is about a run of failures, not a
    // lifetime total — a thread that has worked since is not on its last one.
    job.recoveries = 0;
    setStatus(job, "complete");
  }

  void persist();
  pump();
}

// --- when a worker says "not now" -----------------------------------------
//
// Two answers, and which one is right depends entirely on whether anywhere
// else can actually do the work:
//
//   reroute   the work does not need a repo, or another worker can reach one.
//             Requeued immediately on the new worker, with a fresh session —
//             sessions are not transferable, and pretending otherwise would
//             hand the next worker a `--resume` id it has never seen.
//   back off  nothing else can do it. The turn is held, the session is kept,
//             and it runs again when the window is up. A session cap lifts in
//             half an hour and Claude Code's session survives on disk, so
//             waiting genuinely finishes the work; rerouting to a worker with
//             no filesystem produces a confident answer about work it did not
//             do, which is worse than being slow (see routing.mjs's header).
//
// Only ever for an availability failure. `limitKind` is conservative on
// purpose: an ordinary error — a bad tool call, a bug, a refusal — is not a
// reason to spend another worker's turn on the same broken instruction.

/**
 * Automatic recoveries one job may spend before it stops and asks.
 *
 * Two, because the useful cases are one hand-off and one wait. A third is a
 * job being passed around a set of workers that all decline it, which is the
 * owner's problem to look at, not a loop to leave running on his behalf.
 */
const MAX_RECOVERIES = 2;

/**
 * The longest a job will hold a turn waiting for its worker to come back.
 *
 * A session cap fits inside this; a spent daily quota does not, and waiting six
 * hours on a live job is indistinguishable from being stuck. Longer than this,
 * it fails and says so.
 */
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * @returns {Promise<boolean>} true if the turn now has a future — the caller
 *   must not mark the job failed.
 */
async function recoverFromLimit(job, kind, failure) {
  const attempt = job.attempts.at(-1);
  const prompt = attempt?.prompt;
  // A job restored from disk has the facts of its attempts but not their
  // prompts, so there is nothing to re-run. Same limit `retry()` states.
  if (!prompt) return false;
  if (job.recoveries >= MAX_RECOVERIES) return false;

  const here = listProviders().find((p) => p.id === job.provider);
  const hasTools = here?.capabilities?.tools === true;

  /*
    Never escalate.

    A job on a capability-only worker may have been started by a caller with no
    terminal armed, and `executionAllowed` is a fact about that request, not
    about this job — it is not knowable here. So a reroute moves sideways or
    down, never into a worker that can run commands. The worst case is a job
    that waits; the worst case of guessing is an unarmed device getting
    arbitrary execution through a failure path.
  */
  const candidates = listProviders().filter(
    (p) =>
      p.id !== job.provider &&
      cooldownRemaining(p.id) === 0 &&
      (hasTools || p.capabilities?.tools !== true),
  );

  /*
    A repo task needs a worker that can touch the repo — which is no longer the
    same thing as a worker that can run commands.

    `tools === true` means "arbitrary execution as the owner" and is what the
    guard above refuses to escalate into. `files` means "can read and edit the
    checkout, through server/workspace.mjs, with writes asking first". AI Router
    has the second and not the first, which is exactly the point: a coding job
    whose Claude ran out of quota can now move somewhere that can finish it,
    without the reroute handing anything a shell.
  */
  const canCode = (p) => p.capabilities?.tools === true || p.capabilities?.files === true;
  const target =
    hasTools && (await needsCode(prompt))
      ? (candidates.find((p) => p.capabilities?.tools === true) ?? candidates.find(canCode))
      : (candidates.find(canCode) ?? candidates[0]);

  const waitMs = cooldownRemaining(job.provider);
  // Nothing to hand it to, and nothing worth waiting for.
  if (!target && (waitMs <= 0 || waitMs > MAX_BACKOFF_MS)) return false;

  job.recoveries += 1;
  // Close this attempt by hand: `setStatus` does it for a terminal status, and
  // the whole point here is that the job is not reaching one.
  attempt.status = "failed";
  attempt.endedAt = new Date().toISOString();
  attempt.error = failure;
  job.error = null;
  job.pending.unshift(prompt);

  if (target) {
    const previous = here?.label ?? job.provider;
    const selection = selectWorker(target.id, target.defaultModel);
    job.provider = selection.provider;
    job.model = selection.model;
    // A session belongs to the worker that made it. The new one starts clean.
    job.sessionId = null;
    /*
      `routed`, the same event the router emits at creation, so the reason a
      job changed hands shows up in the thread the same way the original
      decision did. Routing that happens silently is indistinguishable from
      routing that is broken.
    */
    emit(job, "routed", {
      provider: job.provider,
      model: job.model,
      label: target.label ?? target.id,
      why: `${previous} ${kind === "daily" ? "is out of quota for today" : "is unavailable"} — carrying on here, from a fresh session`,
    });
    setStatus(job, "queued", `rerouted from ${previous}`);
    if (!waiting.includes(job.id)) waiting.push(job.id);
    return true;
  }

  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  const timer = setTimeout(() => {
    // Everything that ends a job — cancel, close, clear — goes through halt(),
    // which drops the backoff. This checks its own identity anyway: a job can
    // be removed and its id reused by nothing, but a second failure could have
    // replaced the timer while this one was pending.
    if (jobs.get(job.id) !== job || job.backoff?.timer !== timer) return;
    job.backoff = null;
    if (!job.pending.length) return;
    emit(job, "text", { text: `_Trying ${job.provider} again._` });
    if (!waiting.includes(job.id)) waiting.push(job.id);
    pump();
    // A second past the window, so the cooldown has genuinely lapsed by the
    // time `usable()` is consulted rather than lapsing during the call.
  }, waitMs + 1_000);
  timer.unref?.();
  job.backoff = { until: Date.now() + waitMs, timer, provider: job.provider };

  emit(job, "text", {
    text: `_${here?.label ?? job.provider} is unavailable and nothing else here can do this work — holding this turn and trying again in ${minutes} minute${minutes === 1 ? "" : "s"}._`,
  });
  setStatus(job, "queued", `waiting ${minutes}m for ${job.provider}`);
  return true;
}

async function runTurn(job) {
  const prompt = job.pending.shift();
  if (prompt === undefined) return;

  /*
    Where the workspace stood before this turn touched it.

    Semantic verification used to diff against HEAD, which is "everything
    uncommitted in the worktree" rather than "what this turn did". Jobs run in
    a separate worktree, and that worktree sat on branch `agent` for two weeks
    holding an abandoned attachments feature — so every job in that period got
    the same verdict describing the same unrelated diff. Six different requests,
    one identical answer, and it read as a flaky checker rather than as a
    checker being handed the wrong input.

    Taken here rather than inside reviewWork, because by the time that runs the
    turn has already happened and the before-state is gone. `git stash create`
    writes a commit object and touches nothing, so this is safe to do on every
    turn including concurrent ones.
  */
  /*
    Bring the worktree up to date before the turn, if that is safe.

    On 2026-09-03 it was 183 commits behind, so every job ran against a copy of
    Operator from two weeks earlier — no work log, no vault actions, no
    delegate. Operator diagnosed that itself, after spending turns and
    permission prompts finding out.

    Fast-forward only, and only on a clean tree with nothing else running in
    there. Anything else is refused and reported: losing an agent's uncommitted
    work to an automatic sync would be worse than the drift.

    Before the snapshot, deliberately — the snapshot is what semantic
    verification diffs against, and taking it first would make the sync itself
    look like this turn's work.
  */
  /*
    `busy` means SOMEONE ELSE is in the worktree — not "a turn is happening".

    `running.size > 0` was always true here, because `pump()` does
    `running.add(job.id)` before calling this. So every turn asked "is anything
    running?" while being the thing that was running, and the answer was always
    yes. The sync could not run with a job (it counted itself) and was never
    called without one (nothing else calls it). Unreachable from both sides,
    for as long as it has existed — the log says "a job is running in the
    worktree" on turn 1 of a brand new job, which is the tell.

    The owner closed his last job at 5am specifically so this could sync, and
    it still did not. That is the bug, not the drift.
  */
  const othersInTree = [...running].some((id) => id !== job.id);
  const treeBefore = await syncWorktree(JOB_CWD, othersInTree).catch(() => null);
  if (treeBefore?.synced) {
    console.log(`[operator] worktree fast-forwarded to main (was ${treeBefore.behind} behind)`);
  } else if (treeBefore?.behind) {
    console.warn(
      `[operator] worktree is ${treeBefore.behind} commit(s) behind main — ${treeBefore.reason}`,
    );
  }
  job.worktree = treeBefore ?? null;

  job.workspaceBefore = await workspaceSnapshot(JOB_CWD).catch(() => null);

  /*
    Both early exits below have to restart the queue themselves.

    `pump()` has already shifted this job off `waiting` by the time it calls us,
    and it only runs again when something completes. Returning here without
    re-pumping leaves the queue stalled: no slot was ever claimed, so it is not
    a deadlock, but every other queued job sits there until someone happens to
    send another message. One job failing to start must not silently stop the
    rest.

    Deferred rather than called directly. The ceiling check runs before any
    `await`, so a direct call would re-enter `pump()` from inside its own frame,
    once per queued job.
  */
  const restartQueue = () => {
    // pump() claims the runner before calling us, so an exit before spawning
    // has to hand it back or nothing ever runs again.
    running.delete(job.id);
    queueMicrotask(pump);
  };

  /*
    Begun before the budget check, not after.

    `setStatus()`'s handoff logic closes out whichever attempt is currently
    "running" — and until this call happens, that is whatever attempt last ran,
    including one a crash left stuck at "running" forever, since `restore()`
    rebuilds `attempts` verbatim from disk with no way to know one never
    finished. Beginning the attempt first means a ceiling block always closes out
    its own attempt, never a stale unrelated one, and gives a blocked turn the
    same handoff record every other terminal status gets — previously it left
    whatever `job.handoff` a *previous* attempt had set, unrelated to why the
    job is blocked now.
  */
  beginAttempt(job, prompt);

  const blocked = ceilingBlockFor(job);
  if (blocked) {
    job.error = blocked.message;
    setStatus(job, "blocked", blocked.message);
    // Put it back: raising the ceiling and restarting should not lose what he
    // typed. It is in the event log either way.
    job.pending.unshift(prompt);
    // Deliberately not re-queued into `waiting` — it would be picked up, blocked
    // and re-queued forever. The prompt survives in `pending`, so the next
    // message he sends runs both.
    restartQueue();
    return;
  }

  // The slot was claimed by pump() before this ran — see the note there.
  job.outstandingTools = 0;
  job.awaitingPermission = 0;
  job.startedAt = job.startedAt ?? new Date().toISOString();
  job.error = null;

  if (!USE_CLI) {
    await runViaSdk(job, prompt);
    return;
  }

  const resolved = await resolveExecutable("claude");
  if (!resolved) {
    job.error = "couldn't find Claude Code on this machine — set OPERATOR_TERMINAL_BIN_CLAUDE";
    setStatus(job, "failed", job.error);
    restartQueue();
    return;
  }

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
    await systemPromptFor(),
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
      cwd: JOB_CWD,
      shell: false,
      windowsHide: true,
      // No stdin, for the same reason as the terminal: an open pipe nobody
      // writes to makes anything that reads stdin wait for the timeout. Step 2
      // changes this deliberately, with `--input-format stream-json`.
      stdio: ["ignore", "pipe", "pipe"],
      env: workerEnv({ FORCE_COLOR: "0", NO_COLOR: "1" }),
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
      running.delete(job.id);

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
      /*
        Same accounting as the SDK path — see the note there. This fallback has
        one thing the SDK path does not: `num_turns` and `duration_api_ms` come
        straight off the CLI's result envelope, so they are used in preference
        to anything measured here.
      */
      const record = recordTurn({
        jobId: job.id,
        attempt: job.attempts.length,
        provider: job.provider,
        model: job.model,
        reportedUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        durationMs: typeof msg.duration_api_ms === "number" ? msg.duration_api_ms : null,
        turns: typeof msg.num_turns === "number" ? msg.num_turns : 1,
        error: Boolean(msg.is_error),
      });
      const cost = typeof record.usd === "number" ? record.usd : 0;
      if (cost > 0) job.costUsd += cost;
      emit(job, "usage", {
        basis: record.basis,
        source: record.source,
        turnUsd: record.usd,
        jobUsd: job.costUsd,
        durationMs: record.durationMs,
        ...legacyUsageFields(),
      });

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
    /*
      Waiting on an answer, not working. The tab strip needs this: a job that
      has stopped to ask looks identical to one that is thinking, and the whole
      feature fails if the question is only visible to whoever happens to have
      that tab open.
    */
    asking: job.awaitingPermission ?? 0,
    resources: job.resources,
    task: job.task,
    handoff: job.handoff,
    attempts: job.attempts.map(({ number, provider, model, status, startedAt, endedAt, error }) => ({
      number,
      provider,
      model,
      status,
      startedAt,
      endedAt,
      error,
    })),
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
    running: [...running][0] ?? null,
    runningIds: [...running],
    maxConcurrent: MAX_CONCURRENT,
    providers: listProviders(),
    models: selectWorker(DEFAULT_PROVIDER).worker.models,
    defaultModel: DEFAULT_MODEL,
    // The standing profile, so the page states what it actually is rather than
    // repeating it in prose that drifts the first time OPERATOR_JOB_DENY is set.
    deniedTools: DENIED_TOOLS,
    // What runs without asking, named by the server for the same reason the
    // deny list is: so the page states the policy rather than describing it in
    // prose that drifts the first time OPERATOR_JOB_ALLOW is set.
    allowedTools: ALLOWED_TOOLS,
    // Which runner is actually behind these jobs. The permission pause only
    // exists on one of them, and a page promising a tappable question under the
    // CLI fallback would be lying.
    runner: USE_CLI ? "cli" : "sdk",
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
/**
 * Is Operator in the middle of something?
 *
 * Running turns, queued ones, and — importantly — any turn suspended on a
 * permission question. A suspended turn is the case that matters most: it is
 * not consuming anything, so a naive "is anything running" check would call it
 * idle, and the terminal's auto-disarm would then cut off the one thing that
 * can un-suspend it.
 */
export function busy() {
  if (running.size > 0 || waiting.length > 0) return true;
  for (const job of jobs.values()) {
    if (job.awaitingPermission > 0) return true;
    if (job.pending?.length) return true;
  }
  return false;
}

export function holder() {
  /*
    Nobody holds the runner while there is capacity.

    This guard exists so one device cannot queue work into another device's
    session. With a ceiling above one that reason disappears until the ceiling
    is reached: a second request does not join someone else's turn, it gets a
    turn of its own. Below the limit, any authorised device may send.
  */
  if (running.size < MAX_CONCURRENT) return null;
  const first = [...running][0];
  const job = first ? jobs.get(first) : null;
  return job ? { id: job.id, device: job.device } : null;
}

function assertMine(identity) {
  const held = holder();
  if (!held) return;
  const me = identity?.device ?? null;
  if (held.device && me && held.device === me) return;
  throw new Error(`Claude is busy on "${jobs.get(held.id)?.title ?? held.id}" from ${held.device ?? "another device"}`);
}

export async function create(
  prompt,
  model,
  identity,
  resources = [],
  provider = "auto",
  taskKind = "coding",
  { executionAllowed = true } = {},
) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("nothing to send");
  assertMine(identity);

  /*
    "auto" is the default, and the point of the page.

    Choosing from a row of chips is a menu; the orchestrator is supposed to
    decide. An explicit provider still wins — the chips remain an override for
    when he knows better than the router — but nothing has to be chosen for a
    job to start.

    Routed here rather than in `pump()` so the decision is made once, at
    creation, and the job carries one worker for its whole life. Re-routing per
    turn would mean a conversation whose worker changes underneath it, and the
    two workers' sessions are not interchangeable.
  */
  /*
    Which workers this caller may actually reach.

    Not every worker is the same risk, and treating them as one is what made
    talking to Operator require an armed terminal. `claude-code` has full tool
    access — starting one IS arbitrary execution. Gemini and the local model
    have `tools: "capability-actions"`, so they can do precisely what an
    unarmed caller could already do by calling an action directly. Requiring
    the terminal for those is friction buying nothing.

    So an unarmed caller gets the capability-only workers. The router chooses
    from that shorter list rather than choosing freely and being refused after
    the fact, which would produce "no" for a request that had a perfectly good
    home.
  */
  const reachable = listProviders().filter(
    (p) => executionAllowed || p.capabilities?.tools !== true,
  );
  if (reachable.length === 0) {
    throw new Error(
      "no worker available without the terminal armed — arm it on the Dev page to reach Claude Code",
    );
  }

  let routed = null;
  if (!provider || provider === "auto") {
    routed = await routeTask(text, reachable.map((p) => p.id));
    provider = routed.provider;
  }

  if (!reachable.some((p) => p.id === provider)) {
    throw new Error(
      `${provider} needs the terminal armed — it can run commands. Arm it on the Dev page, or ask something the local model can answer.`,
    );
  }

  const selection = selectWorker(provider, model);
  const job = blankJob(`job-${++jobSeq}`);
  job.title = titleFrom(text);
  job.device = identity?.device ?? null;
  job.provider = selection.provider;
  job.model = selection.model;
  job.task = blankTask(typeof taskKind === "string" && taskKind.trim() ? taskKind.trim().slice(0, 48) : "coding");
  const claimed = await claimResources(job.id, resources);
  job.resources.push(...claimed);
  const turn = promptWithResources(text, claimed);

  jobs.set(job.id, job);
  /*
    Say what was chosen and why, before the prompt.

    Routing that happens silently is indistinguishable from routing that is
    broken — the owner needs to see "this went to Gemini because it read as a
    data question" to trust it, and to spot the day it starts getting that
    wrong. Only emitted when the router actually decided; an explicit choice
    needs no explanation.
  */
  if (routed) {
    emit(job, "routed", {
      provider: job.provider,
      model: job.model,
      label: listProviders().find((p) => p.id === job.provider)?.label ?? job.provider,
      why: routed.why,
    });
  }
  emit(job, "prompt", { text, resources: claimed.map((resource) => resource.name) });
  job.pending.push(turn);
  waiting.push(job.id);
  prune();
  pump();

  /*
    Say what happened to it, immediately.

    The owner's framing, and it is better than the decision log's: a second
    request should not queue in silence. He should hear "I will handle that
    while the build runs" or "that will wait behind the build" — an answer from
    the CONTROL PLANE, arriving now, not the worker's answer arriving in four
    minutes.

    This is deliberately a fact about scheduling rather than a generated
    sentence: it says which worker took it and what is ahead of it, and the
    surface that speaks decides the wording. A model writing "got it" would be
    a model call on the fast path, which is the thing this whole design avoids.
  */
  const ahead = waiting.indexOf(job.id);
  emit(job, "accepted", {
    started: running.has(job.id),
    provider: job.provider,
    ahead: ahead < 0 ? 0 : ahead,
    concurrent: running.size,
    limit: MAX_CONCURRENT,
  });

  return summary(job);
}

/** Another turn on an existing job, or a cancellation. */
export async function input(id, body, identity) {
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
    if (job.proc || job.abort) {
      // Status first, then stop: the SDK path reads `job.status` when the turn
      // unwinds to decide whether this was a cancellation or a failure, and the
      // abort can get there before the next line would have.
      setStatus(job, "cancelled", "stopped from the app");
      halt(job);
    } else {
      setStatus(job, "cancelled", "stopped before it started");
    }
    // A question outstanding on a job nobody is running any more is a promise
    // nothing will ever settle. The abort above covers the SDK path; this
    // covers a job stopped before its turn began.
    dropQuestions(job.id, "cancelled");
    return summary(job);
  }

  const text = String(body?.text ?? "").trim();
  if (!text) throw new Error("nothing to send");
  assertMine(identity);

  // Whoever sends the turn holds it, not whoever opened the tab. `holder()`
  // reads this to say "busy on X from <device>", and naming the wrong device
  // makes that message actively misleading on a two-device setup.
  job.device = identity?.device ?? job.device;
  const claimed = await claimResources(job.id, body?.resources);
  job.resources.push(...claimed);
  const turn = promptWithResources(text, claimed);

  emit(job, "prompt", { text, resources: claimed.map((resource) => resource.name) });
  job.pending.push(turn);
  if (!waiting.includes(job.id)) waiting.push(job.id);
  if (job.status !== "running") setStatus(job, "queued");
  pump();
  return summary(job);
}

/**
 * Stop everything that is running or queued, whoever started it.
 *
 * The voice "stop" goes here rather than to `input(id, {type:"cancel"})`,
 * because when he says it he does not know or care which job is running — he
 * has heard something start that he did not ask for. Asking him to name it
 * defeats the point.
 *
 * **No identity check, same reasoning as `input`'s cancel.** Sending INTO
 * someone else's job is refused; stopping one is not. A runaway has to be
 * killable from whatever device is in your hand.
 *
 * @returns {{stopped: number, ids: string[]}}
 */
export function stopAll(why = "stopped by voice") {
  const ids = [];
  for (const job of jobs.values()) {
    const live = job.proc || job.abort || job.status === "running" || job.status === "queued";
    if (!live) continue;

    // Drop the queue too. Killing the turn that is running would otherwise let
    // the next queued one start the moment the process exits — "stop" that
    // launches the next thing is not stop.
    job.pending.length = 0;
    if (job.proc || job.abort) {
      // Status BEFORE halt: the SDK path reads `job.status` as the turn unwinds
      // to tell a cancellation from a failure, and the abort can land first.
      setStatus(job, "cancelled", why);
      halt(job);
    } else {
      setStatus(job, "cancelled", why);
    }
    dropQuestions(job.id, "cancelled");
    ids.push(job.id);
  }

  /*
    Clear the wait list as well, or a job that was queued but never started
    stays in it and pump() revives it on the next turn anyone sends.
  */
  waiting.length = 0;

  if (ids.length) console.log(`[operator] ${why} — cancelled ${ids.length} job(s)`);
  /*
    Save it, exactly as remove() and clear() already do.

    This was the hole under the "soft" restart. stopAll marked every job
    cancelled IN MEMORY and wrote none of it, so reboot.mjs — the caller this
    exists for — exited before anything reached disk and data/jobs.json kept the
    attempt recorded as "running". That is precisely the state the call was
    added to prevent, and the comment above it in reboot.mjs claimed it did.

    Fire-and-forget here matches every other call site and is right for the
    voice "stop everything", which carries on running afterwards. A shutdown
    must not rely on it — see flush().
  */
  if (ids.length) void persist();
  return { stopped: ids.length, ids };
}

/**
 * Stop ONE job, by id. What the Stop button does, reachable by a worker.
 *
 * `stopAll` existed for the voice command and nothing could stop a single one,
 * so a chat could watch a job it had no way to end — and the job holding the
 * worktree is exactly the job you most need to stop. Mirrors `stopAll`'s body
 * for one job rather than reimplementing it: the queue is dropped too, because
 * a "stop" that lets the next queued turn start is not a stop.
 */
export function stop(id, why = "stopped") {
  const job = jobs.get(id);
  if (!job) return { stopped: false, reason: `no job called "${id}"` };

  const live = job.proc || job.abort || job.status === "running" || job.status === "queued";
  if (!live) return { stopped: false, id, status: job.status, reason: "not running" };

  job.pending.length = 0;
  // Status BEFORE halt, as in stopAll: the SDK path reads job.status as the
  // turn unwinds to tell a cancellation from a failure.
  setStatus(job, "cancelled", why);
  if (job.proc || job.abort) halt(job);
  dropQuestions(job.id, "cancelled");

  const at = waiting.indexOf(id);
  if (at >= 0) waiting.splice(at, 1);

  console.log(`[operator] job ${id} ${why}`);
  // Same reason as stopAll: a cancellation only in memory is a cancellation
  // that the next restart silently un-does.
  void persist();
  return { stopped: true, id, status: job.status };
}

/** Requeue the last failed/cancelled live attempt. Never retries automatically. */
export function retry(id, identity) {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");
  if (job.proc || job.abort || job.status === "running") throw new Error("job is still running");
  assertMine(identity);
  const attempt = job.attempts.at(-1);
  if (!attempt?.prompt) {
    throw new Error("this attempt cannot be retried after a server restart; send the instruction again");
  }
  if (!["failed", "blocked", "cancelled"].includes(attempt.status)) {
    throw new Error("only a failed, blocked, or cancelled attempt can be retried");
  }
  job.device = identity?.device ?? job.device;
  job.pending.unshift(attempt.prompt);
  job.error = null;
  setStatus(job, "queued", "retry requested from the app");
  emit(job, "retry", { attempt: attempt.number, provider: job.provider, model: job.model });
  if (!waiting.includes(job.id)) waiting.push(job.id);
  pump();
  return summary(job);
}

export function setModel(id, model) {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");
  job.model = selectWorker(job.provider, model).model;
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
  if (job.proc || job.abort) {
    setStatus(job, "cancelled", "closed from the app");
    halt(job);
  }
  dropQuestions(id, "cancelled");
  jobs.delete(id);
  void removeJobResources(id);
  const at = waiting.indexOf(id);
  if (at !== -1) waiting.splice(at, 1);
  console.log(`[operator] job ${id} closed by ${identity?.device ?? "unknown"}`);
  void persist();
  return list();
}

/** Close every job. The index file goes with them, or they'd return on restart. */
export function clear(identity) {
  for (const job of jobs.values()) {
    halt(job);
    dropQuestions(job.id, "cancelled");
    void removeJobResources(job.id);
  }
  jobs.clear();
  waiting.length = 0;
  running.clear();
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

/*
  **JOB_CWD, not ROOT.**

  Claude Code reads `.claude/settings.local.json` relative to the directory it
  is working in, and since OPERATOR_JOB_CWD sent jobs into the `agent` worktree
  that is no longer where Operator itself is installed. Writing to ROOT put
  every granted rule in the main checkout, to be read by a Claude running in the
  worktree — a file that looks right, sits in the allow list, and can never
  fire.

  That is the same failure as the Windows path-matching bug documented below,
  arriving from a different direction: a grant that silently does nothing. It
  cost three denied grants to find the first time. Unset, JOB_CWD is ROOT and
  this is exactly what it was.
*/
const SETTINGS_FILE = join(JOB_CWD, ".claude", "settings.local.json");

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
  // Relative to where Claude works, not where Operator lives — the two are
  // different checkouts now. See the note on SETTINGS_FILE.
  const root = JOB_CWD.replace(/\\/g, "/").replace(/\/$/, "");
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
