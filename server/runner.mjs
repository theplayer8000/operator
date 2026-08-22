// The Claude Agent SDK, behind one door.
//
// ADR 0012 adopted the SDK for one reason: `canUseTool` lets a permission be
// answered *inside* a turn. The CLI cannot do that — asked to close Snapchat it
// made six attempts and every one was refused, because print mode has no channel
// to say yes on.
//
// ## Why this is its own file
//
// The ADR promised the dependency would be bounded: `auth.mjs`, the storage
// layer, backups and the terminal stay pure Node, so *what runs when Operator
// serves your data* is still readable end to end. Only *what runs when a job
// talks to Claude* becomes trust. This file is that boundary, and it is the only
// place in `server/` that imports anything off npm. Keep it that way.
//
// It is also the provider implementation ADR 0009 describes. `jobs.mjs` owns
// jobs, queueing, persistence and the event vocabulary; this owns one turn.
// A second provider later implements this same signature.

import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Run one turn.
 *
 * @param {object} spec
 * @param {string} spec.prompt        what to ask
 * @param {string} spec.model
 * @param {string|null} spec.sessionId  resume a conversation, or null to start one
 * @param {string} spec.cwd           where Claude works — the agent worktree
 * @param {object} [spec.env]         the worker's environment. Pass one with
 *        Operator's own secrets removed (`jobs.mjs`'s `workerEnv()`) — the SDK
 *        otherwise inherits this process's, API keys included
 * @param {string[]} spec.deniedTools tools refused outright, never asked about
 * @param {string[]} spec.allowedTools tools run without asking — see jobs.mjs
 * @param {number|null} spec.budgetUsd hard ceiling for this turn, or null
 * @param {string} [spec.appendSystemPrompt] appended to the system prompt
 * @param {string} [spec.permissionMode] must be "default" for onPermission to be consulted
 * @param {AbortSignal} [spec.signal]
 * @param {(type: string, data?: object) => void} spec.onEvent
 * @param {(req: {tool: string, subject: string, input: object, title: string,
 *                description: string, signal: AbortSignal}) => Promise<boolean>} spec.onPermission
 *        Resolves true to allow. **Awaited** — hold it as long as the person
 *        takes to answer; that is the entire point of this file.
 * @returns {Promise<{sessionId: string|null, costUsd: number, error: string|null}>}
 */
export async function runTurn({
  prompt,
  model,
  sessionId,
  cwd,
  env,
  deniedTools = [],
  allowedTools = [],
  budgetUsd = null,
  appendSystemPrompt = "",
  permissionMode = "default",
  signal,
  onEvent,
  onPermission,
}) {
  let resolvedSession = sessionId ?? null;
  let costUsd = 0;
  /** The last assistant text, so the result's error isn't printed twice. */
  let lastText = "";
  let error = null;

  const abort = new AbortController();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const response = query({
    prompt,
    options: {
      model,
      cwd,
      abortController: abort,
      // Without this the SDK hands the worker this process's environment,
      // Operator's own API keys included. See workerEnv() in jobs.mjs.
      ...(env ? { env } : {}),
      /*
        `default` is the mode that consults `canUseTool`. Leaving it unset does
        not: measured, an unallow-listed `hostname --fqdn` ran without the
        callback ever firing, which would have meant shipping a permission
        prompt nothing could reach. The other modes decide for themselves —
        `bypassPermissions` allows, `dontAsk` refuses anything not pre-allowed.
      */
      permissionMode,
      /*
        `bypassPermissions` is refused by the SDK without this. It did not need
        a second flag on the CLI, so a wiring that forwards a profile mode
        through here fails at the first turn until it is passed. Set only for
        the mode that requires it — passing it under `default` would be a
        confusing lie about what this turn can do.
      */
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(resolvedSession ? { resume: resolvedSession } : {}),
      ...(deniedTools.length ? { disallowedTools: deniedTools } : {}),
      /*
        The pre-allow list — the half of option C that keeps this quiet.

        `default` mode consults `canUseTool` for everything, and a workspace
        that asks permission to read a file is not a workspace. These run
        without being asked about; anything outside the list reaches the
        callback below and becomes a question the owner can answer.

        The SDK also auto-approves trivially safe calls on its own (measured:
        `echo` never reached the callback), so this list only has to cover the
        middle ground, not every `ls`.
      */
      ...(allowedTools.length ? { allowedTools } : {}),
      /*
        **Not `appendSystemPrompt`** — that is the CLI's flag name, and the SDK
        would accept the object with the key silently ignored. The instruction
        would simply never reach the model, and nothing would look wrong.

        The preset keeps Claude Code's own system prompt and adds to it;
        passing a bare string would *replace* it and throw away the tool
        instructions with it.
      */
      ...(appendSystemPrompt
        ? { systemPrompt: { type: "preset", preset: "claude_code", append: appendSystemPrompt } }
        : {}),
      // The SDK's own ceiling, which stops a turn *before* it overruns rather
      // than after. Better than counting cost afterwards, which is all the CLI
      // allowed.
      ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),

      /*
        The reason this file exists.

        Returning a promise here suspends the turn — not the process, not the
        request, the turn — until it settles. So a denial stops being a dead end:
        the phone is asked, the answer comes back, and the same turn carries on
        with the tool it wanted. That is what six refused attempts to close
        Snapchat were missing.

        `deniedTools` is checked by the SDK before we are consulted, so the two
        irreversible actions never even reach this callback and cannot be waved
        through by a mis-tap.

        **Three arguments, not two.** The third carries `signal`, and it is the
        reason a cancel works while a permission is outstanding: without it,
        pressing Stop on a job waiting to be answered would leave this promise
        pending and the turn would hang until the idle timeout rather than
        stopping. It is forwarded to `onPermission` so the pending question can
        be torn down at the same moment the turn is.

        `title` and `description` are the bridge's own rendering of the prompt
        ("Claude wants to read foo.txt"). Preferred over reconstructing a
        sentence from tool name and input, because the bridge knows things this
        file does not — such as which path in a Bash command triggered the ask.
      */
      canUseTool: async (toolName, input, options = {}) => {
        const allowed = await onPermission({
          tool: toolName,
          subject: subjectOf(input),
          input,
          title: typeof options.title === "string" ? options.title : "",
          description: typeof options.description === "string" ? options.description : "",
          signal: options.signal,
        });
        return allowed
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Refused from Operator." };
      },
    },
  });

  try {
    for await (const message of response) {
      switch (message.type) {
        case "system":
          // `init` carries the session id for a new conversation — the thing
          // that makes the next turn a continuation rather than a stranger.
          if (message.subtype === "init" && message.session_id) {
            resolvedSession = message.session_id;
            /*
              Announced the moment it appears, not just returned at the end.

              The session id is the memory — it is what makes the next turn a
              continuation — and the moment a later save doesn't run is exactly
              the moment it is most needed. Handing it back only on a clean
              return means a turn that crashes half way through loses the
              conversation, which was already fixed once and written up as "the
              chat was lying about remembering".
            */
            onEvent("session", { sessionId: message.session_id });
            onEvent("status", { status: "running" });
          }
          break;

        case "assistant":
          for (const block of message.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              onEvent("text", { text: block.text });
            } else if (block.type === "tool_use") {
              onEvent("tool_use", { tool: block.name, subject: subjectOf(block.input) });
            }
          }
          break;

        case "user":
          // Tool results come back as a synthetic user message.
          for (const block of message.message?.content ?? []) {
            if (block.type !== "tool_result") continue;
            onEvent("tool_result", {
              ok: block.is_error !== true,
              text: flatten(block.content).slice(0, MAX_RESULT_CHARS),
            });
          }
          break;

        case "result":
          if (typeof message.total_cost_usd === "number") costUsd = message.total_cost_usd;
          if (message.session_id) resolvedSession = message.session_id;
          if (message.is_error) {
            error =
              typeof message.result === "string" && message.result
                ? message.result
                : "Claude reported an error";
            /*
              Only if it has not already been said.

              A session-limit failure arrives twice: once as an assistant text
              block ("You've hit your session limit · resets 10pm") and again
              as the result's error. Emitting both printed the same sentence
              twice in the log, which reads like two separate failures rather
              than one. Observed 2026-08-21 on job-1.
            */
            if (error.trim() !== lastText.trim()) {
              onEvent("text", { text: error, error: true });
            }
          }
          /*
            No `usage` event here on purpose. Cost is returned, and the caller
            emits it — because the numbers the owner actually reads are
            per-job and per-server totals, and those are `jobs.mjs`'s to keep.
            Emitting a partial `usage` here as well would put two events of the
            same type in the log carrying different subsets of the truth.
          */
          break;

        default:
          break;
      }
    }
  } catch (err) {
    // An abort is a cancellation, not a failure — the caller asked for it.
    if (abort.signal.aborted) error = null;
    else error = String(err?.message ?? err).slice(0, 500);
  }

  return { sessionId: resolvedSession, costUsd, error };
}

/** A single tool result can be a whole file. Truncated for display only. */
const MAX_RESULT_CHARS = 600;

/** What a tool is doing, in the terms the owner would use — a command, a path. */
function subjectOf(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

/** Tool result content is either a string or an array of blocks. */
function flatten(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
    .join("\n");
}
