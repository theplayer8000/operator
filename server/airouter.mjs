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
// ## It has a filesystem now — 2026-09-04
//
// The owner: *"airouter should have that too please because when claude is
// down ai router is the second most capable worker."*
//
// That was the gap the reroute exposed. A job that hit a Claude limit moved to
// a worker that could discuss the code and not touch it, so "recovered" meant
// "asked someone who cannot help". `server/workspace.mjs` supplies read, list,
// search, write, edit and a fixed set of named checks; the boundaries live
// there and are not this file's to relax.
//
// Two things worth knowing from here:
//
// **Writes ask the owner.** `jobs.mjs` has always passed `onPermission` into
// every provider's turn — nothing but the Claude path had ever called it. Now
// this one does, so a write from AI Router raises the same card on his phone,
// and the same turn resumes on the tap.
//
// **The round cap moves with the tools.** Ten rounds is plenty for "what's on
// my calendar" and nowhere near enough for read → edit → typecheck → fix. It is
// raised only when the file tools are actually in play.
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
import { readFile } from "node:fs/promises";
import {
  TOOLS as FILE_TOOLS,
  TOOL_NAMES as FILE_TOOL_NAMES,
  runWorkspaceTool,
  WorkspaceError,
  enabled as filesEnabled,
} from "./workspace.mjs";

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

/*
  How big the replayed conversation may get before the oldest tool output is
  thrown away.

  ## The failure

  This worker has no session on the provider's side, so every turn re-sends the
  ENTIRE conversation. The comment above `conversations` said the cap belongs on
  rounds rather than history length "because a long conversation is the thing a
  262K context window is for" — true of the context window, and beside the point
  for the thing that actually broke. On 2026-09-06, at turn 59, the router
  answered **413 Request Entity Too Large**: an HTTP body limit, measured in
  bytes, sitting well below the token ceiling anyone was reasoning about. The job
  could not continue and the only way out was starting a new one, which throws
  the thread away.

  ## Why caching is not the answer

  Prompt caching stops a provider RECOMPUTING a prefix. It does not stop us
  SENDING it — the request body is byte-identical either way, so a 413 lands
  exactly the same. Caching would buy latency and cost; only pruning buys a turn
  60.

  ## What gets dropped, and why it is the right thing

  Tool output, oldest first. The prose — what he asked and what the model
  answered — is small and is the whole point of a thread. A 20KB command dump or
  a whole file read forty turns ago is enormous and almost never load-bearing
  again; if the model needs that file it can read it, and now it will.

  The message is STUBBED IN PLACE, never removed. Deleting a `tool` message
  orphans its `tool_call_id` and the API rejects the request — a fix that
  produces a 400 instead of a 413 is not a fix. Replacing the content keeps every
  id paired and the structure intact, and the stub says what happened so the
  model reads "this was dropped" rather than "this was empty".

  The most recent rounds are never touched: those are what the turn is actively
  working from.
*/
const HISTORY_BUDGET = Math.max(
  50_000,
  Number(process.env.OPERATOR_AIROUTER_HISTORY_BYTES || 300_000) || 300_000,
);
/** Recent messages left alone however big they are — the live working set. */
const KEEP_RECENT = 12;
/** Below this a tool result is not worth stubbing; the stub costs bytes too. */
const STUB_OVER = 400;

const sizeOf = (messages) => {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
};

/**
 * Bring the replayed history under the budget, in place.
 *
 * Returns nothing: it mutates, because the array it is handed is the same one
 * stored in `conversations` and the point is that the session shrinks too, not
 * only this one request.
 */
function pruneHistory(messages, onEvent) {
  let total = sizeOf(messages);
  if (total <= HISTORY_BUDGET) return;

  let dropped = 0;
  let freed = 0;
  const last = messages.length - KEEP_RECENT;

  /*
    Three places carry bulk, and the first version only reached one of them.

    It stubbed `role: "tool"` messages and nothing else, so it ran, reported
    success, and the very next turn returned 413 again. The two it missed are
    both larger than the one it caught:

      - IMAGES, in a user message's parts array. An attached photo is a base64
        data URI that outweighs an entire conversation, and it was being replayed
        on every later turn forever. An image is evidence for the turn it arrived
        in; keeping it after that is what guarantees the wall.
      - TOOL CALL ARGUMENTS, on an assistant message. `write_file` puts a whole
        file in `arguments`, so the file is in the history TWICE — once going in
        as an argument and once coming back as a result — and only the result
        was being pruned.

    Ordered by what costs least to lose: images first (huge, and their moment has
    passed), then write arguments, then tool results.
  */

  // 1. Old images.
  for (let i = 0; i < last && total > HISTORY_BUDGET; i += 1) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    const kept = [];
    let removed = 0;
    for (const part of m.content) {
      if (part?.type === "image_url") {
        removed += part.image_url?.url?.length ?? 0;
        continue;
      }
      kept.push(part);
    }
    if (!removed) continue;
    kept.push({ type: "text", text: "[an image sent earlier in this conversation was dropped to stay under the request size limit]" });
    m.content = kept;
    freed += removed;
    total -= removed;
    dropped += 1;
  }

  // 2. Old tool-call arguments — where write_file hides a whole file.
  for (let i = 0; i < last && total > HISTORY_BUDGET; i += 1) {
    const m = messages[i];
    if (!Array.isArray(m?.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const args = call?.function?.arguments;
      if (typeof args !== "string" || args.length <= STUB_OVER) continue;
      if (args.startsWith('{"pruned"')) continue;
      const was = args.length;
      call.function.arguments = JSON.stringify({ pruned: true, was });
      freed += was - call.function.arguments.length;
      total -= was - call.function.arguments.length;
      dropped += 1;
    }
  }

  // 3. Old tool results.
  for (let i = 0; i < last && total > HISTORY_BUDGET; i += 1) {
    const m = messages[i];
    if (m?.role !== "tool" || typeof m.content !== "string") continue;
    if (m.content.length <= STUB_OVER || m.content.startsWith('{"pruned"')) continue;
    const was = m.content.length;
    m.content = JSON.stringify({
      pruned: true,
      note: `output of ${was} characters dropped to keep this conversation under the request size limit — read the file or run the command again if it still matters`,
    });
    freed += was - m.content.length;
    dropped += 1;
    total -= was - m.content.length;
  }

  /*
    Say so when it was not enough, instead of sending a request that will be
    rejected. A 413 from the gateway tells him nothing about which part was
    oversized; this names the number.
  */
  if (total > HISTORY_BUDGET) {
    onEvent?.("text", {
      text: `_Still ${Math.round(total / 1000)}KB after trimming, over the ${Math.round(HISTORY_BUDGET / 1000)}KB budget — the recent ${KEEP_RECENT} messages are kept whole and one of them is large. If this turn fails with 413, that is why._`,
    });
  }

  if (dropped) {
    /*
      Said out loud in the thread. A conversation that quietly forgets what it
      was told is the worst kind of bug to debug from the outside — he would see
      the model re-reading files it had already read and conclude it was being
      stupid rather than that it had been trimmed.
    */
    onEvent?.("text", {
      text: `_Trimmed ${dropped} old tool result${dropped === 1 ? "" : "s"} (${Math.round(freed / 1000)}KB) from this conversation's replayed history — it was approaching the request size limit. Recent turns are untouched._`,
    });
  }
}

/**
 * Per-REQUEST timeout, not per turn.
 *
 * 180s was fine while this worker only called capability actions — those
 * return a few hundred bytes and the history stayed small. With file tools the
 * history carries every file the turn has read, re-sent every round, so a late
 * round is a much bigger request than an early one and 180s stopped being
 * generous: on 2026-09-04 four turns failed, two at exactly 180.0s.
 *
 * 420s is the figure `delegate.mjs` arrived at against the same provider, for
 * the same reason, and it was measured rather than guessed. The read budget in
 * `workspace.mjs` is the other half of this fix — a longer timeout alone would
 * buy a slower failure rather than a success.
 */
const TIMEOUT_MS = Number(process.env.OPERATOR_AIROUTER_TIMEOUT_MS || 420_000);

/*
  Which models accept image parts in the user message.

  MODELS is the full catalogue — a model may still be text-only. Qwen3.8 is a
  vision-language model, and DeepSeek-V4-Flash accepts images through its
  scaling pipeline (the owner's call, 2026-09-04). If the router rejects the
  image parts anyway, call() falls back to the text-only prompt, so a turn
  never dies just because a model turned out text-only.
*/
const VISION_MODELS = new Set(["Qwen3.8", "DeepSeek-V4-Flash"]);

/*
  Caps on what gets attached, because an image travels as base64 and base64 is
  4/3 of the file — a 10 MB phone photo would eat a 262K window before the
  text arrives. Skipped images are named in a text part, not dropped silently.
*/
/*
  Sized against the REQUEST BODY LIMIT, not the context window.

  These were 5 MB and 4 images, and the reasoning written beside them was about
  a 262K context window — "one phone photo would eat the window before the text
  arrives". That was the wrong ceiling, and the right one is three orders of
  magnitude tighter: base64 is 4/3 of a file, so a single 5 MB image is 6.7 MB
  on the wire against an nginx `client_max_body_size` of 1 MB. One attached photo
  was six times over the limit on its own, before any conversation.

  It is the same mistake the history cap made — reasoning about tokens when the
  thing that rejects the request counts bytes — and it produced the same 413
  twice in one afternoon.

  600 KB of base64 across the whole turn leaves comfortable room for the prose,
  the tool schemas and the replayed history underneath the 1 MB wall.
*/
const MAX_IMAGE_BYTES = Number(process.env.OPERATOR_AIROUTER_MAX_IMAGE_BYTES || 420 * 1024);
const MAX_IMAGES_PER_TURN = Number(process.env.OPERATOR_AIROUTER_MAX_IMAGES || 2);
/** Total base64 an entire turn's images may contribute to the body. */
const MAX_IMAGE_BUDGET = Number(process.env.OPERATOR_AIROUTER_IMAGE_BUDGET || 600 * 1024);

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
function toolDeclarations(groups, { files = false } = {}) {
  /*
    File tools FIRST.

    Order is not cosmetic: asked to fix a bug, a model handed forty capability
    actions and six file tools reaches for what it sees first, and the whole
    point of this worker having a filesystem is that a repo task stops being
    answered out of the model's memory of the codebase.
  */
  const fileTools = files ? [...FILE_TOOLS] : [];
  return fileTools.concat(listActions({ groups }).map((action) => ({
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
  })));
}

/**
 * One call to the router, with a bounded retry on rate limiting.
 *
 * Their fair use is warning-first rather than a hard cutoff, so a 429 here is
 * far more likely to be the per-minute ceiling than a suspension — which is
 * worth waiting out rather than failing the turn.
 */
async function call({
  model,
  messages,
  tools,
  signal,
  onRateLimit,
  reasoningEffort,
  /*
    When the request carries image parts and the model turns out to reject
    them, the router answers 400. `altContent` is the same user message with
    the images removed; `onFallback` lets the caller keep its own history in
    step — a response that answered a text-only prompt must not follow an
    image-bearing one in the replay.
  */
  altContent,
  onFallback,
}) {
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
        if (res.status === 400 && altContent && /image|vision|multimodal/i.test(text)) {
          // Retried once with the images removed. A model that rejects image
          // parts is still a usable worker; the text-only request then stands
          // or fails on its own merits below.
          messages = [...messages];
          messages[messages.length - 1] = { role: "user", content: altContent };
          onFallback?.();
          continue;
        }
        /*
          Say what happened, not what nginx said.

          A gateway answers in HTML, and the raw body was going straight into
          the failure message — so a push notification on his lock screen read
          "<html><head><title>413 Request Entity Too Large</title>..." and he
          had to work out from that what to do next. 413 in particular has a
          specific, actionable cause here and deserves to say so.
        */
        const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
        if (res.status === 413) {
          throw new Error(
            "AI Router returned 413 — the request body was too large for its gateway. " +
              "This worker has no session on their side, so the whole conversation is re-sent every turn " +
              "and old tool output (files read, command output) is what fills it. The history is pruned " +
              `automatically above ${Math.round(HISTORY_BUDGET / 1000)}KB; if this still happens, lower ` +
              "OPERATOR_AIROUTER_HISTORY_BYTES or start a new job.",
          );
        }
        throw new Error(
          `AI Router returned ${res.status}${looksHtml ? " (an HTML error page from its gateway, not the API)" : `: ${text.slice(0, 300)}`}`,
        );
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
/*
  Turn claimed files into an OpenAI-format user message.

  The prompt stays a plain string when there is nothing to attach or the model
  cannot see images — a text-only request is what every model accepts. With
  image attachments on a vision model the user message becomes a parts array:
  the text first, then each image as a base64 data URI. Anything over the caps
  is named in a trailing text part rather than dropped silently, so the model
  knows it exists and can still ask for the path.

  Returns { used, content } — `used` tells the caller whether the request is
  multimodal, so it can fall back to text if the router refuses image parts.
*/
async function userMessage(prompt, attachments, model) {
  const isImage = (resource) =>
    /^image\//.test(resource?.type ?? "") ||
    /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(resource?.name ?? "");
  const images = (attachments ?? []).filter(isImage).slice(0, MAX_IMAGES_PER_TURN);
  if (images.length === 0 || !VISION_MODELS.has(model)) {
    return { used: false, content: prompt };
  }

  const EXT_MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
  };
  const parts = [{ type: "text", text: prompt }];
  const skipped = [];
  /*
    A running total, because a per-image cap alone does not bound the REQUEST.

    Two images each just under the limit are still two images, and the gateway
    counts the body, not the attachments. This is the number that has to stay
    under 1 MB, so this is where it is enforced.
  */
  let budget = MAX_IMAGE_BUDGET;
  for (const image of images) {
    try {
      const buf = await readFile(image.path);
      if (buf.length > MAX_IMAGE_BYTES) {
        skipped.push(`${image.name} (${Math.round(buf.length / 1024)} KB — over the ${Math.round(MAX_IMAGE_BYTES / 1024)} KB limit per image)`);
        continue;
      }
      // 4/3 for base64, plus the data: prefix. Checked BEFORE encoding, so an
      // oversized file is never turned into a string half the size of the wall.
      const onWire = Math.ceil((buf.length * 4) / 3) + 64;
      if (onWire > budget) {
        skipped.push(`${image.name} (would not fit in what is left of the request)`);
        continue;
      }
      budget -= onWire;
      const ext = (image.name ?? "").split(".").pop()?.toLowerCase() ?? "";
      const mime = /^image\//.test(image?.type ?? "")
        ? image.type
        : EXT_MIME[ext] ?? "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
      });
    } catch {
      skipped.push(image.name);
    }
  }
  if (parts.length === 1) {
    // Every image failed or was over the cap — nothing to show. Fall back to
    // the plain prompt rather than sending a parts array with no image in it.
    return { used: false, content: prompt };
  }
  if (skipped.length) {
    parts.push({
      type: "text",
      text: `Not attached (too large or unreadable): ${skipped.join(", ")}. Their paths are named in the prompt above.`,
    });
  }
  return { used: true, content: parts };
}

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
  /*
    Where this turn's files live, and how to ask about writing one.

    Both are already in the spec `jobs.mjs` builds for EVERY provider — `cwd` is
    the agent worktree and `onPermission` is the phone question — and this
    worker simply ignored them until it had a filesystem to use them for.
  */
  cwd,
  onPermission,
  /**
   * Whether this turn may touch files.
   *
   * Off for a delegated sub-task for the same reason tools are: a checker that
   * can write is a second actor. Off when there is no `cwd`, because a write
   * with no checkout would land wherever the server happens to be running.
   */
  useFiles = true,
  /*
    Files claimed onto this job (server/uploads.mjs). Non-image files stay in
    the prompt as paths; image files become vision parts when `model` accepts
    them — see userMessage().
  */
  attachments,
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
  /*
    Images make the user message a parts array (see userMessage). `used` arms
    the fallback in `call()`: if the router rejects image parts with a 400,
    the request is retried with this turn's plain text instead of failing.
  */
  const imageMessage = await userMessage(prompt, attachments, model || DEFAULT_MODEL);
  messages.push({ role: "user", content: imageMessage.content });
  // Keeps the replayed history honest when call() falls back to text-only.
  const dropImages = () => {
    messages[messages.length - 1] = { role: "user", content: prompt };
    onEvent("text", { text: "_This model refused the image attachment — continuing with the text-only prompt._" });
  };

  const files = Boolean(useTools && useFiles && filesEnabled && cwd);
  const tools = useTools ? toolDeclarations(groupsFor(prompt), { files }) : [];
  /*
    `budget` is turn-scoped on purpose: it lives on the ctx object built here,
    once per turn, so a long conversation gets a fresh allowance per turn while
    a single runaway turn is bounded.
  */
  const ctx = { cwd, onPermission, signal, budget: { chars: 0 } };
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
    /*
      Ten rounds answers a question; it does not finish a change.

      Read the file, edit it, run the typechecker, read the error, fix it, run
      it again is already six before anything else happens. The cap exists to
      stop a runaway rather than to bound useful work, so it moves with what the
      turn can actually do.
    */
    const maxRounds = files ? 40 : 10;
    for (; rounds < maxRounds; rounds += 1) {
      pruneHistory(messages, onEvent);
      const body = await call({
        model: model || DEFAULT_MODEL,
        messages,
        tools,
        signal,
        reasoningEffort,
        // Armed only when this turn is multimodal — see userMessage().
        ...(imageMessage.used ? { altContent: prompt, onFallback: dropImages } : {}),
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

        const isFile = FILE_TOOL_NAMES.has(name);
        onEvent("tool_use", {
          tool: name,
          /*
            A file tool's subject is its PATH, not its parameters — `write_file`
            carries a whole file in `content`, and putting that in the event log
            would render the file into the chat and into every later turn that
            replays it.
          */
          subject: isFile
            ? String(params?.path ?? params?.name ?? "")
            : redactParams(name, params),
        });
        try {
          const result = isFile
            ? await runWorkspaceTool(name, params, ctx)
            : await runAction(name, params);
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
          /*
            A WorkspaceError is the same class of thing as an ActionError: the
            model asked for something it may not have, or got a path wrong, and
            the message says precisely what. It goes back as DATA so the next
            round can correct it. A refusal by the owner arrives this way too —
            the model reads "was refused by the owner" and carries on with the
            rest of the work instead of retrying.
          */
          if (!(err instanceof ActionError) && !(err instanceof WorkspaceError)) throw err;
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
