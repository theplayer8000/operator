// The local worker: a model running on this machine, through Ollama.
//
// ## What makes this one different from every other worker
//
// **Nothing leaves the machine.** Claude and Gemini are approved external
// hosts, and each turn sends the prompt and whatever job context is attached to
// somebody else's server. This one talks to 127.0.0.1:11434. There is no
// approval to seek under CLAUDE.md's external-application rule, because there
// is no external application.
//
// One honest caveat so nobody records this as "fully offline": pulling a model
// downloads it from Ollama's registry. That is a package fetch, the same class
// of thing as `npm install`, done once and never during a turn. No prompt, no
// job context and no owner data is involved.
//
// It is also the only worker with **no quota and no per-token cost**, which is
// what makes it the right occupant of the always-on role in
// docs/control-plane-design.md and docs/presence-layer-design.md. Gemini's free
// tier is 20 requests a day; Claude's is money now that usage credits are on.
// A router that has to be cheap enough to run on every message cannot be either
// of them.
//
// ## Why raw fetch and no SDK
//
// Same reason as gemini.mjs, and the rule it protects is ADR 0012's: runner.mjs
// is the ONLY file in server/ allowed to import from npm. `ollama` publishes a
// client library; this endpoint is one POST with a JSON body, so it would buy
// nothing worth reopening that for.
//
// ## Expect it to be slower and less capable, and let it be
//
// On the owner's hardware (i5-10400, no usable GPU, 4GB AMD VRAM that ROCm does
// not cover) this runs on CPU at a few tokens a second, with a 3B-class model.
// That is genuinely fine for the jobs it is for - routing, classification, and
// eventually verification - and genuinely not fine for writing code. The point
// is not that it competes with Claude. The point is that it is always there.

import { runAction, listActions, groupsFor, ActionError } from "./actions.mjs";

/** Loopback only. A remote Ollama would be an external host needing approval. */
const ENDPOINT = process.env.OPERATOR_OLLAMA_URL ?? "http://127.0.0.1:11434";

/**
 * How long one request may take.
 *
 * Generous on purpose: local inference is slow, and a timeout that fires
 * mid-answer looks identical to a broken worker. The signal from jobs.mjs still
 * cancels immediately when the owner does.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.OPERATOR_OLLAMA_TIMEOUT_MS ?? 180_000) || 180_000;

/*
  Keep the model resident between requests.

  **This is the single biggest thing about local inference being usable here.**
  Measured 2026-08-30 on the owner's RX 6400: a one-word classification took
  24.4 seconds, of which 21.3 was `load_duration` - reloading 1.8GB from disk
  into VRAM. The thinking was under a second. Ollama's default keep-alive is
  five minutes, which is long enough to look fine when you test twice in a row
  and far too short for a worker asked something once an hour.

  "30m" rather than "-1" (forever): the model holds roughly 2GB of a 4GB card,
  and a machine that also plays games should get it back eventually. Set
  OPERATOR_OLLAMA_KEEP_ALIVE to "-1" to pin it, or "0" to unload immediately.
*/
const KEEP_ALIVE = process.env.OPERATOR_OLLAMA_KEEP_ALIVE ?? "30m";

/*
  Context window. Ollama's default is larger than anything this worker does and
  the KV cache for it comes out of the same 4GB the weights are in - on a card
  this size that is the difference between fitting and spilling.
*/
const NUM_CTX = Number(process.env.OPERATOR_OLLAMA_NUM_CTX ?? 4096) || 4096;

/**
 * Conversations in memory, keyed by the session id handed back.
 *
 * Identical to gemini.mjs and for the same reason: Ollama's chat endpoint is
 * stateless, so "the conversation" is the history replayed each request. In
 * memory means restart-fatal, and that is declared in `capabilities` as
 * `sessions: "in-memory"` rather than papered over.
 */
const conversations = new Map();

function newSessionId() {
  return `ollama-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The capability actions, as Ollama tool definitions.
 *
 * Built from the same registry the CLI and Gemini read, so a new action reaches
 * every worker the moment it exists in actions.mjs. The loose parameter shape
 * is deliberate for the reason gemini.mjs sets out: `listActions()` documents
 * params as a human-readable line rather than JSON Schema, and inventing a
 * schema here would be a second source of truth that drifts from the validation
 * actions.mjs actually performs.
 */
function toolDefinitions(groups) {
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

/** Is Ollama actually running? Used by providers.mjs to decide whether to register. */
export async function isAvailable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${ENDPOINT}/api/tags`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Models this machine has pulled, so the picker offers what actually exists. */
export async function installedModels() {
  try {
    const res = await fetch(`${ENDPOINT}/api/tags`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.models ?? [])
      .map((m) => String(m?.name ?? ""))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function callOllama({ model, messages, signal, tools, numPredict }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(`${ENDPOINT}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        tools,
        // One JSON object back rather than a token stream. jobs.mjs polls an
        // event log; it does not consume a stream, so streaming would add
        // parsing for nothing.
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: NUM_CTX, ...(numPredict ? { num_predict: numPredict } : {}) },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new Error(
          `Ollama does not have the model "${model}". Pull it first: ollama pull ${model}`,
        );
      }
      throw new Error(`Ollama returned ${res.status}. ${text.slice(0, 300)}`);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      // Distinguish the owner cancelling from the model simply being slow -
      // they need different responses and look identical at this layer.
      if (signal?.aborted) throw new Error("cancelled");
      /*
        Say what this worker is for, not just that it ran out of time.

        The first version of this message suggested a smaller model or a longer
        timeout, and both are the wrong advice for the case that actually
        happens: generation here runs around 1.7 tokens a second, so the
        timeout buys roughly 300 tokens, and a question that wants a long
        explanation exceeds that on an idle machine. Nothing is broken and no
        setting fixes it - the answer was simply longer than this worker
        produces in the time.
      */
      throw new Error(
        `the local model ran out of time (${Math.round(REQUEST_TIMEOUT_MS / 1000)}s). It generates ` +
          `roughly 300 tokens in that window, so this is usually a question whose answer is ` +
          `simply longer than that rather than anything being wrong. This worker is for short ` +
          `answers, routing and checking work — ask Claude for a long explanation, or leave the ` +
          `picker on Auto and let it choose. Genuinely want it local? A smaller model ` +
          `(ollama pull qwen2.5:1.5b) roughly doubles the rate, and OPERATOR_OLLAMA_TIMEOUT_MS ` +
          `raises the ceiling.`,
      );
    }
    if (err?.cause?.code === "ECONNREFUSED") {
      throw new Error(`Ollama is not running at ${ENDPOINT}. Start it and try again.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * One turn. Same contract as runner.mjs and gemini.mjs.
 *
 * `costUsd: 0` is a fact here rather than a placeholder: the electricity is
 * already being spent and no meter runs. ADR 0013's `basis` distinction matters
 * - this is genuinely zero, not an unpriced valuation.
 */
/**
 * One question, one answer, NO TOOLS.
 *
 * `runTurn` hands the model the whole capability layer, which is right for a
 * worker and wrong for anything being asked to judge. A checker that can write
 * to the owner's data is a second actor, not a check — so this exists
 * separately rather than as a flag on the other one, because a flag is
 * something a later caller forgets to set.
 *
 * Stateless: no session, no history, nothing remembered. Every caller so far
 * wants a fresh opinion rather than a conversation.
 */
export async function ask({ prompt, model, system = "", signal, maxTokens = 200 }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = await callOllama({
    model,
    messages,
    signal,
    // Explicitly nothing. Ollama omits the field entirely when undefined.
    tools: undefined,
    // Short answers only. This is a classifier, and letting a 1.7 tok/s model
    // write an essay is how a background check becomes a three-minute wait.
    numPredict: maxTokens,
  });
  return String(body?.message?.content ?? "").trim();
}

export async function runTurn({
  prompt,
  model,
  sessionId,
  appendSystemPrompt = "",
  signal,
  onEvent,
}) {
  const id = sessionId ?? newSessionId();
  const history = conversations.get(id) ?? [];
  if (!sessionId || !conversations.has(id)) onEvent("session", { sessionId: id });

  const messages = [...history];
  if (messages.length === 0 && appendSystemPrompt) {
    messages.push({ role: "system", content: appendSystemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  let error = null;

  /*
    Only the actions this request plausibly needs, and built ONCE per turn.

    Measured 2026-08-31: all 39 actions serialise to 17,001 characters of tool
    definitions — roughly 4.2k tokens against a `num_ctx` of 4096. The tool
    block alone did not fit in this worker's context window, before the system
    prompt, the history or the question. That is not overhead, it is the reason
    the local model was slow and lost the plot.

    It was also rebuilt inside every round of the loop, so a six-round turn paid
    for it six times.

    `groupsFor` returns null when the wording gives no clue, and null means send
    everything — an unfiltered turn is merely expensive, where a wrongly
    filtered one makes Operator look like it cannot do something it plainly
    can.
  */
  const groups = groupsFor(prompt);
  const tools = toolDefinitions(groups);

  try {
    /*
      Tool-call loop, bounded for the same reason gemini.mjs bounds its own: a
      model that keeps calling actions forever is a runaway with the owner's
      data on the other end, running unattended from a phone.

      Six rather than ten. A small model loops more readily than a large one,
      and the tasks this worker is for need a couple of actions, not a chain.
    */
    for (let round = 0; round < 6; round += 1) {
      const body = await callOllama({ model, messages, signal, tools });
      const message = body?.message;
      if (!message) throw new Error("Ollama returned no message");

      if (message.content?.trim()) onEvent("text", { text: message.content });

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        ...(calls.length ? { tool_calls: calls } : {}),
      });

      if (calls.length === 0) break;

      for (const call of calls) {
        const name = call?.function?.name;
        const rawArgs = call?.function?.arguments;
        // Ollama hands arguments back as an object; some models emit a JSON
        // string instead. Accept both rather than failing on a formatting
        // difference the model cannot be told about.
        let params = {};
        try {
          const holder = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs ?? {});
          const inner = holder?.params;
          params = typeof inner === "string" ? JSON.parse(inner) : (inner ?? holder ?? {});
        } catch {
          params = {};
        }

        onEvent("tool_use", { tool: name, subject: JSON.stringify(params) });
        try {
          const result = await runAction(name, params);
          onEvent("tool_result", { ok: true, text: JSON.stringify(result) });
          messages.push({ role: "tool", content: JSON.stringify(result) });
        } catch (err) {
          const message2 = err instanceof ActionError ? err.message : String(err?.message ?? err);
          onEvent("tool_result", { ok: false, text: message2 });
          // The error goes back to the model so it can correct itself - the
          // same self-correcting loop the CLI gives Claude.
          messages.push({ role: "tool", content: `Error: ${message2}` });
        }
      }
    }

    conversations.set(id, messages);
  } catch (err) {
    error = String(err?.message ?? err);
  }

  return { sessionId: id, costUsd: 0, error };
}

/** Called when a job is closed, so a conversation doesn't outlive its tab. */
export function forgetSession(sessionId) {
  conversations.delete(sessionId);
}
