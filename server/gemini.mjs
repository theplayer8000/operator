// The Google Gemini worker.
//
// Approved by name on 2026-08-20 — see the table in CLAUDE.md. What leaves the
// machine: the prompt, the conversation so far, and whatever job context is
// attached. Nothing else. The key lives in GEMINI_API_KEY and is read here
// only; it never enters data/operator.json, git, or any response the client
// sees.
//
// ## What this is and is not
//
// It implements the same `runTurn` contract as runner.mjs, so jobs.mjs
// dispatches to it through providers.mjs without knowing the difference. But
// the two are not equivalent workers, and pretending otherwise would be the
// dishonest part:
//
//   runner.mjs (Claude Code)  a full agentic loop. Reads and writes files,
//                             runs commands, holds a session on disk, asks
//                             permission mid-turn.
//   this file (Gemini)        a model that answers, and can call Operator's
//                             capability actions. No filesystem, no shell.
//
// That difference is declared in `capabilities` (providers.mjs), not hidden —
// the UI can hide tool affordances a worker doesn't have rather than showing
// controls that silently do nothing.
//
// ## Why raw fetch and no SDK
//
// `@google/generative-ai` would be a second npm dependency in server/, and
// ADR 0012 bounded that deliberately: runner.mjs is the ONLY file here allowed
// to import from npm. This endpoint is one POST with a JSON body — a
// dependency would buy types and retries, neither worth reopening that rule
// for. Node's built-in fetch is enough.

import { runAction, listActions, ActionError } from "./actions.mjs";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Conversations, in memory, keyed by the session id we hand back.
 *
 * Gemini's API is stateless — there is no server-side session to resume, so
 * "the conversation" is the full turn history replayed on every request. That
 * is the opposite of Claude Code, which owns a session on disk and takes
 * `--resume`.
 *
 * **In memory means restart-fatal, deliberately.** jobs.mjs persists a job's
 * `sessionId` and restores the tab, so after a restart a Gemini tab reopens
 * with an id whose history is gone. Rather than pretend, `runTurn` starts a
 * fresh history and the reply simply has no memory of before — the same
 * honest degradation the job model already documents for event logs. Writing
 * transcripts to disk is a real feature (and a real privacy decision) rather
 * than something to do by accident here.
 */
const conversations = new Map();

/** Matches the id shape jobs.mjs already persists for Claude sessions. */
function newSessionId() {
  return `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The capability actions, as Gemini function declarations.
 *
 * Built from the same registry the CLI reads, so a new action is available to
 * Gemini the moment it exists in actions.mjs — no second list to keep in step.
 *
 * The parameter shape is deliberately loose (`object`, no per-field schema):
 * `listActions()` documents params as a human-readable line, not JSON Schema,
 * and inventing a schema here would be a second source of truth that drifts
 * from the validation actions.mjs actually performs. The action validates and
 * returns a specific error; that error goes back to the model, which corrects
 * itself. Same loop the CLI gives Claude.
 */
function toolDeclarations() {
  return [
    {
      functionDeclarations: listActions().map((action) => ({
        name: action.name,
        description: `${action.description} Parameters: ${action.params}`,
        parameters: {
          type: "object",
          properties: {
            params: {
              type: "string",
              description: `JSON object of parameters. ${action.params}`,
            },
          },
          required: ["params"],
        },
      })),
    },
  ];
}

async function callGemini({ model, contents, systemInstruction, signal, onRateLimit, retried = false }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set on the server. Set it and restart — note that a " +
        "running process keeps the environment it started with, so the Restart " +
        "button is not enough (schtasks /end then /run, or a fresh shell)."
    );
  }

  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents,
      tools: toolDeclarations(),
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    }),
    signal,
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    /*
      429 is the common one and it is not really an error — the free tier is
      20 requests a minute, and Google says exactly how long to wait. Passing
      its raw message through gave two paragraphs of billing URLs for what is
      "busy, try in a minute", so the wait is honoured once and only the
      failure after that is reported.
    */
    if (res.status === 429) {
      /*
        A daily cap and a per-minute burst are the same status code and both
        carry a `retryDelay`, but only one of them is worth waiting for. The
        free tier's real limit is **20 requests per DAY**
        (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), and it still
        says "retry in 18s" — waiting that out just fails again, having told
        the owner something untrue about why.
      */
      if (isDailyCap(body)) {
        throw new Error(
          "Gemini's free tier is spent for today (20 requests a day). It resets tomorrow — " +
            "use Claude for now, or add billing to the Google project."
        );
      }
      const wait = retryAfterMs(body);
      // Once only. A second wait would mean a turn sitting silent for two
      // minutes, which from a phone is indistinguishable from a hang.
      if (!retried && wait !== null && wait <= MAX_RETRY_WAIT_MS && !signal?.aborted) {
        onRateLimit?.(Math.round(wait / 1000));
        await new Promise((r) => setTimeout(r, wait));
        return callGemini({ model, contents, systemInstruction, signal, onRateLimit, retried: true });
      }
      throw new Error(
        `Gemini is rate-limited (free tier: 20 requests a minute)${
          wait ? `. It asks for ${Math.round(wait / 1000)}s` : ""
        } — try again shortly, or use Claude for this one.`
      );
    }
    // Google's error body carries a real reason; the status alone does not.
    // Never include the response headers or the request — the key is in there.
    const reason = body?.error?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`Gemini refused the request: ${reason}`);
  }
  return body;
}

/** Longest we'll sit on a rate limit before giving the turn back. */
const MAX_RETRY_WAIT_MS = 65_000;

/**
 * Is this the daily allowance, rather than a burst limit?
 *
 * Read from `quotaId` rather than the prose, which is identical for both. The
 * free tier's daily figure is small enough to matter — 20 requests, where a
 * single conversation with a few tool calls can spend several.
 */
function isDailyCap(body) {
  for (const detail of body?.error?.details ?? []) {
    for (const violation of detail?.violations ?? []) {
      if (/PerDay/i.test(String(violation?.quotaId ?? ""))) return true;
    }
  }
  return false;
}

/**
 * How long Google wants us to wait, in ms, or null.
 *
 * It arrives two ways depending on the endpoint: a `RetryInfo` detail with a
 * duration string ("48.9s"), or plain prose in the message. Both are read
 * rather than picking one, because a missed delay means either failing a turn
 * that would have succeeded, or sleeping a made-up amount of time.
 */
function retryAfterMs(body) {
  const details = body?.error?.details ?? [];
  for (const detail of details) {
    const seconds = String(detail?.retryDelay ?? "").match(/^([\d.]+)s$/);
    if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  }
  const prose = String(body?.error?.message ?? "").match(/retry in ([\d.]+)s/i);
  return prose ? Math.ceil(Number(prose[1]) * 1000) : null;
}

/**
 * One turn, same contract as runner.mjs.
 *
 * `onPermission` is accepted and deliberately never called: everything this
 * worker can do is a capability action, and those are pre-approved by
 * definition — they are the validated, named, can-only-do-what-the-UI-does
 * set. There is no equivalent of "Claude wants to run an arbitrary command"
 * here, so there is nothing to ask about. If this worker ever gains a
 * genuinely open-ended tool, that stops being true and this comment is the
 * thing to come back to.
 */
export async function runTurn({
  prompt,
  model,
  sessionId,
  budgetUsd = null,
  appendSystemPrompt = "",
  signal,
  onEvent,
}) {
  const id = sessionId ?? newSessionId();
  const history = conversations.get(id) ?? [];
  if (!sessionId || !conversations.has(id)) onEvent("session", { sessionId: id });

  const contents = [...history, { role: "user", parts: [{ text: prompt }] }];
  let error = null;

  try {
    /*
      Tool calls loop: ask, run whatever it asked for, ask again with the
      results, until it answers with text instead of a function call.

      Bounded rather than `while (true)`. A model that keeps calling actions
      forever is a runaway with the owner's data on the other end, and this
      runs unattended from a phone. Ten is far above any real task — the
      handful of actions a "sort out my week" request needs — and low enough
      that a loop stops being a bill.
    */
    for (let round = 0; round < 10; round += 1) {
      const body = await callGemini({
        model,
        contents,
        systemInstruction: appendSystemPrompt,
        signal,
        // Said out loud, because a silent 48-second pause on a phone reads as
        // a hang — and the event log is the only thing that can say otherwise.
        onRateLimit: (seconds) =>
          onEvent("text", { text: `_Rate-limited by Gemini — waiting ${seconds}s and retrying._` }),
      });

      const candidate = body?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      if (parts.length === 0) {
        // A safety block is the usual cause, and it has its own field.
        const blocked = body?.promptFeedback?.blockReason ?? candidate?.finishReason;
        error = blocked ? `Gemini returned nothing (${blocked})` : "Gemini returned nothing";
        break;
      }

      contents.push({ role: "model", parts });

      const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
      for (const part of parts) {
        if (part.text?.trim()) onEvent("text", { text: part.text });
      }

      if (calls.length === 0) break;

      const responses = [];
      for (const call of calls) {
        let params = {};
        try {
          // The declaration asks for params as a JSON string — models are
          // markedly better at that than at nested schemas, and actions.mjs
          // validates the result either way.
          params = call.args?.params ? JSON.parse(call.args.params) : {};
        } catch {
          responses.push({
            functionResponse: {
              name: call.name,
              response: { error: `params was not valid JSON: ${call.args?.params}` },
            },
          });
          continue;
        }

        onEvent("tool_use", { tool: call.name, subject: JSON.stringify(params) });
        try {
          const result = await runAction(call.name, params);
          onEvent("tool_result", { ok: true, text: JSON.stringify(result) });
          responses.push({ functionResponse: { name: call.name, response: { result } } });
        } catch (err) {
          // An ActionError is the model's mistake and it can fix it next
          // round, so it goes back as data rather than ending the turn.
          const message = err instanceof ActionError ? err.message : `failed: ${err.message}`;
          onEvent("tool_result", { ok: false, text: message });
          responses.push({ functionResponse: { name: call.name, response: { error: message } } });
        }
      }
      contents.push({ role: "user", parts: responses });
    }
  } catch (err) {
    // An abort is a cancellation, not a failure — the caller asked for it.
    if (signal?.aborted) error = null;
    else error = String(err?.message ?? err).slice(0, 500);
  }

  conversations.set(id, contents);

  /*
    No cost is reported, and that is not an oversight.

    Gemini's response carries token counts, not money, and turning one into the
    other means hardcoding a price list that goes stale silently — the exact
    "a number that looks authoritative and is wrong" failure the usage counter
    was warned about. jobs.mjs sums costUsd across a job; contributing a
    confident 0 is honest (this is free-tier), a guess would not be.
  */
  return { sessionId: id, costUsd: 0, error };
}

/** Called when a job is closed, so a conversation doesn't outlive its tab. */
export function forgetSession(sessionId) {
  conversations.delete(sessionId);
}
