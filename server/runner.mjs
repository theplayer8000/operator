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
 * @param {string[]} spec.deniedTools tools refused outright, never asked about
 * @param {number|null} spec.budgetUsd hard ceiling for this turn, or null
 * @param {string} [spec.permissionMode] must be "default" for onPermission to be consulted
 * @param {AbortSignal} [spec.signal]
 * @param {(type: string, data?: object) => void} spec.onEvent
 * @param {(req: {tool: string, subject: string, input: object}) => Promise<boolean>} spec.onPermission
 *        Resolves true to allow. **Awaited** — hold it as long as the person
 *        takes to answer; that is the entire point of this file.
 * @returns {Promise<{sessionId: string|null, costUsd: number, error: string|null}>}
 */
export async function runTurn({
  prompt,
  model,
  sessionId,
  cwd,
  deniedTools = [],
  budgetUsd = null,
  permissionMode = "default",
  signal,
  onEvent,
  onPermission,
}) {
  let resolvedSession = sessionId ?? null;
  let costUsd = 0;
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
      /*
        `default` is the mode that consults `canUseTool`. Leaving it unset does
        not: measured, an unallow-listed `hostname --fqdn` ran without the
        callback ever firing, which would have meant shipping a permission
        prompt nothing could reach. The other modes decide for themselves —
        `bypassPermissions` allows, `dontAsk` refuses anything not pre-allowed.
      */
      permissionMode,
      ...(resolvedSession ? { resume: resolvedSession } : {}),
      ...(deniedTools.length ? { disallowedTools: deniedTools } : {}),
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
      */
      canUseTool: async (toolName, input) => {
        const allowed = await onPermission({
          tool: toolName,
          subject: subjectOf(input),
          input,
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
            onEvent("status", { status: "running" });
          }
          break;

        case "assistant":
          for (const block of message.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
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
            onEvent("text", { text: error, error: true });
          }
          onEvent("usage", { turnUsd: costUsd });
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
