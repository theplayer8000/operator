// One turn, through AI Router — a flat-rate, Swiss-hosted, OpenAI-compatible API.
//
// Same `runTurn` contract as `runner.mjs` and `gemini.mjs`, so `jobs.mjs` does
// not know or care which of them ran. Raw `fetch`, no SDK, so `server/`'s
// one-dependency rule holds.
//
// ## Why this exists, and what it is NOT for
//
// It replaces **`ollama.mjs`**, not Claude. See ADR 0016.
//
// The local model is 3B because 4GB of VRAM says so, and it is measurably too
// weak for the jobs it already has — semantic verification scores two out of
// three and has hallucinated agreement outright. This is a 27B dense model and
// a 284B mixture-of-experts at a flat monthly rate, so the work the 3B does
// badly can move here at zero MARGINAL cost.
//
// Claude on the Pro subscription stays for anything needing judgement. Its
// marginal turn is already free and its verification is the one that is
// trusted.
//
// ## OpenAI-shaped, which is the whole reason it was cheap to add
//
// `chat/completions` with `tools`, so the tool loop below is the same shape as
// gemini.mjs's — ask, run what it asked for, ask again with the results. The
// differences are the wire format (`tool_calls` with a JSON `arguments` string,
// rather than Gemini's `functionCall.args`) and that history is a flat
// `messages` array rather than `contents` with `parts`.
//
// ## Sessions die with the process, and the UI says so
//
// Same as gemini.mjs and for the same reason: Claude Code's session lives on
// disk and resumes, while this is a replayed history in server memory. A
// restart loses it. Pretending otherwise would give a tab an id whose history
// is gone.
//
// ## Cost
//
// Flat rate, so there is no per-token figure to report and reporting $0 would
// be a lie of a different kind. `usage.mjs` records the turn with
// `basis: "billed"` and a null cost — the ceiling that can actually govern this
// provider is the QUOTA ledger, not the dollar one. Their fair use is 3
// parallel requests, 240/min, 10M tokens/min; the parallel limit happens to be
// exactly `OPERATOR_MAX_CONCURRENT`.

import { runAction, listActions, groupsFor, ActionError, redactParams } from "./actions.mjs";

const env = (name) => (process.env[name] ?? "").replace(/^﻿/, "").trim();

const API_KEY = env("AIROUTER_API_KEY");
const BASE_URL = env("AIROUTER_BASE_URL") || "https://api.airouter.ch/v1";

/** Whether this worker can run at all. `providers.mjs` reads it before registering. */
export const configured = Boolean(API_KEY);

/**
 * The models this router offers, best-known first.
 *
 * Hardcoded rather than fetched: a model list is a network call on a path that
 * has to answer instantly, and a provider that is down should fail when a turn
 * runs rather than when the page loads.
 */
export const MODELS = ["DeepSeek-V4-Flash", "Qwen3.8"];
export const DEFAULT_MODEL = "DeepSeek-V4-Flash";

/**
 * Sessions, in memory, keyed by id.
 *
 * A `Map` of message arrays. Deliberately not persisted — see the header. The
 * cap is on ROUNDS per turn rather than history length, because a long
 * conversation is the thing a 262K context window is for.
 */
const conversations = new Map();

let counter = 0;
const newSessionId = () => `air-${Date.now().toString(36)}-${(counter += 1)}`;

/** Long enough for a big reasoning turn, short enough that a hang ends. */
const TIMEOUT_MS = 180_000;

/**
 * The capability layer, as OpenAI tool declarations.
 *
 * Built ONCE per turn, not per round. Measured on Gemini 2026-08-31: all the
 * actions serialise to ~16KB of declarations, and rebuilding them inside the
 * loop sent that up to ten times for one turn.
 *
 * The cost is not only tokens. Asked the time, a model handed a catalogue of
 * everything reached for `calendar_range` and `jobs_list` — the right action
 * gets harder to find the more wrong ones surround it.
 *
 * `params` is a JSON STRING rather than a nested schema. Models are markedly
 * better at producing that, and `actions.mjs` validates either way.
 */
function toolDeclarations(groups) {
  return listActions({ groups }).map((action) => ({
    type: "function",
    function: {
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
    },
  }));
}

/**
 * One call to the router, with a bounded retry on rate limiting.
 *
 * Their fair use is warning-first rather than a hard cutoff, so a 429 here is
 * far more likely to be the per-minute ceiling than a suspension — which is
 * worth waiting out rather than failing the turn.
 */
async function call({ model, messages, tools, signal, onRateLimit, reasoningEffort }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    /*
      Abort on EITHER the caller's signal or the timeout. Without forwarding
      the caller's, pressing Stop would leave this request running to
      completion and the job would report cancelled while still burning a slot.
    */
    const onAbort = () => controller.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length ? tools : undefined,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const wait = Math.min(30, 2 ** attempt * 5);
        onRateLimit?.(wait);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AI Router returned ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }
  throw new Error("AI Router kept rate-limiting — gave up after three attempts");
}

/**
 * Run one turn. Same contract as runner.mjs and gemini.mjs.
 *
 * @returns {Promise<{sessionId: string, error: string|null, usage: object}>}
 */
export async function runTurn({
  prompt,
  model,
  sessionId,
  appendSystemPrompt = "",
  signal,
  onEvent,
  /**
   * How much internal reasoning to spend, when the caller knows it is wasted.
   *
   * DeepSeek-V4-Flash thinks before it answers, and on extraction that thinking
   * IS the latency: one 16k-character conversation produced 13,788 characters
   * of reasoning to reach 3,454 characters of answer, and took a hundred
   * seconds doing it. Long enough to hit the request timeout, which returned
   * nothing at all.
   *
   * "none" is advertised by the router and measurably works — zero reasoning
   * characters returned. Left undefined by default, because a turn that is
   * genuinely reasoning (a job, a conversation) should keep it.
   */
  reasoningEffort,
  /*
    Whether this turn may reach the capability layer.

    True for a job, because a worker answering "what's on this week" needs to
    look. False for a DELEGATED sub-task (`server/delegate.mjs`), where the
    model is reading code and returning prose — there, tools are ~16KB of
    declarations it has no use for, and worse: a sub-task that can write to his
    data is a second actor rather than an assistant to the one that asked.
  */
  useTools = true,
}) {
  const id = sessionId ?? newSessionId();
  const history = conversations.get(id) ?? [];
  if (!sessionId || !conversations.has(id)) onEvent("session", { sessionId: id });

  const messages = [...history];
  /*
    The system prompt goes in only once, at the head. Repeating it per turn
    would grow the replayed history by its own length every round trip.
  */
  if (appendSystemPrompt && messages.length === 0) {
    messages.push({ role: "system", content: appendSystemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const tools = useTools ? toolDeclarations(groupsFor(prompt)) : [];
  let error = null;
  let rounds = 0;

  try {
    /*
      Bounded rather than `while (true)`. A model that keeps calling actions
      forever is a runaway with the owner's data on the other end, and this runs
      unattended from a phone. Ten is far above any real task and low enough
      that a loop stops being a problem — which matters less here than on a
      metered provider, but a wedged turn is still a wedged turn.
    */
    for (; rounds < 10; rounds += 1) {
      const body = await call({
        model: model || DEFAULT_MODEL,
        messages,
        tools,
        signal,
        reasoningEffort,
        // Said out loud: a silent pause on a phone reads as a hang, and the
        // event log is the only thing that can say otherwise.
        onRateLimit: (seconds) =>
          onEvent("text", { text: `_Rate-limited — waiting ${seconds}s and retrying._` }),
      });

      const choice = body?.choices?.[0];
      const message = choice?.message;
      if (!message) {
        error = `AI Router returned no message (${choice?.finish_reason ?? "no reason given"})`;
        break;
      }

      messages.push(message);
      if (message.content?.trim()) onEvent("text", { text: message.content });

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) break;

      for (const toolCall of calls) {
        const name = toolCall.function?.name;
        let params = {};
        try {
          const raw = JSON.parse(toolCall.function?.arguments ?? "{}");
          // Declared as a JSON string, but a model will sometimes send the
          // object directly. Accept both rather than failing on the better one.
          params = typeof raw.params === "string" ? JSON.parse(raw.params) : (raw.params ?? raw);
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: `arguments were not valid JSON: ${toolCall.function?.arguments}`,
            }),
          });
          continue;
        }

        onEvent("tool_use", { tool: name, subject: redactParams(name, params) });
        try {
          const result = await runAction(name, params);
          onEvent("tool_result", { ok: true, text: JSON.stringify(result) });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ result }),
          });
        } catch (err) {
          /*
            An ActionError is the model's mistake and it can fix it next round,
            so it goes back as DATA rather than ending the turn. Anything else
            is ours and should stop.
          */
          const text = String(err?.message ?? err);
          onEvent("tool_result", { ok: false, text });
          if (!(err instanceof ActionError)) throw err;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: text }),
          });
        }
      }
    }
  } catch (err) {
    error = signal?.aborted ? null : String(err?.message ?? err);
  }

  conversations.set(id, messages);

  return {
    sessionId: id,
    error,
    /*
      No cost, deliberately.

      Flat rate means there is no per-token figure, and reporting 0 would be the
      exact mistake ADR 0013 exists to prevent — a real zero and an unknown
      wearing a digit are different things. `basis: "billed"` with a null cost
      says "this was paid for, monthly, and the number is not per turn".

      Token counts are passed through when the router reports them, because the
      quota ledger is the ceiling that can actually govern this provider.
    */
    usage: { basis: "billed", costUsd: null, rounds },
  };
}

/** Drop a session's replayed history. Called when a job is closed or cleared. */
export function forgetSession(sessionId) {
  conversations.delete(sessionId);
}
