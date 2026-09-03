// Hand a piece of work down to a cheaper worker, and get the answer back.
//
// ## Why this exists
//
// `routing.mjs` decides which worker takes a JOB. That is dispatch at the front
// door, and it has been there since 2026-08-31. What it cannot do is help once
// a job is already running: a Claude turn that needs to read four thousand
// lines to answer one question reads them itself, at Claude's price, into
// Claude's context.
//
// The owner's framing on 2026-09-02: *"claude opus 5 as the main bit taking in
// everything and dispatching and the other models helping so claude doesnt have
// to be the heavy worker anymore but it can be if needed."*
//
// So this is the other half. Claude stays the one holding the thread and making
// the decisions; the reading, scanning, summarising and drafting can go to a
// 27B or a 284B at a flat rate, and only the ANSWER comes back.
//
// ## What it is not
//
// **Not a capability action.** `actions.mjs` is named, validated operations on
// Operator's OWN data, and its header says so; a worker-to-worker call is a
// different thing wearing the same shape. Keeping it out also keeps the answer
// to "can a delegated worker delegate?" a plain no — only the worker holding
// the job dispatches, so there is no recursion to bound.
//
// **Not a new external host.** AI Router (ADR 0016) or the local model, both
// already approved and already registered in `providers.mjs`.
//
// ## Two things it deliberately refuses
//
// **No tools.** A delegated sub-task returns prose. One that can write to his
// gym log is a second actor rather than an assistant to the first, and nothing
// asked for that.
//
// **No files outside the project.** The caller names paths and this reads them,
// so without a root check "summarise this file" would be a way to upload
// anything on the disk. The roots are the checkout it was invoked from and the
// main checkout — the two places Operator's own source lives.
//
// No dependencies.

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/*
  How much file content one delegation may carry.

  AI Router's window is 262K tokens, so this is nowhere near the model's limit —
  it is a limit on the MISTAKE. A `--file src/**` expanded by a shell glob is
  how a helpful call becomes a megabyte, and a cap that reports itself is better
  than one that silently drops the interesting half.
*/
const MAX_CHARS = Number(process.env.OPERATOR_DELEGATE_MAX_CHARS || 400_000);

/** Long enough for a big read, short enough that a hang ends. */
/*
  Long enough for a big extraction, measured rather than guessed.

  180s was not: one 16k-character conversation took ~100 seconds on its own,
  and a 45k window is several times that. With `reasoning_effort: "none"` the
  thinking is gone and most of that latency with it — but the ceiling should
  still sit well clear of the worst case rather than just above the average,
  because exceeding it produces silence rather than an error.
*/
const TIMEOUT_MS = Number(process.env.OPERATOR_DELEGATE_TIMEOUT_MS || 420_000);

/**
 * Where a delegated read may reach.
 *
 * `OPERATOR_JOB_CWD` is the agent worktree; this file's own grandparent is the
 * checkout it is running from. Both are Operator's source. Anything else — the
 * home directory, another project, a keyfile — is refused with the path named,
 * because a silent skip would look like the file being empty.
 */
function roots() {
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  const list = [process.cwd(), process.env.OPERATOR_JOB_CWD, process.env.OPERATOR_REPO, here];
  return [...new Set(list.filter(Boolean).map((p) => resolve(p)))];
}

function inRoots(path) {
  const target = resolve(path);
  return roots().some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Which workers can take delegated work, best first. */
export function available() {
  const list = [];
  if ((process.env.AIROUTER_API_KEY ?? "").trim()) list.push("airouter");
  list.push("ollama");
  return list;
}

/**
 * Read the named files, refusing anything outside the project and stopping at
 * the character cap. Returns the blocks to attach plus what was left out.
 */
async function attachments(files) {
  const blocks = [];
  const attached = [];
  let budget = MAX_CHARS;
  let truncated = false;

  for (const path of files) {
    if (!inRoots(path)) {
      throw new Error(
        `delegate: "${path}" is outside the project — a delegated worker reads Operator's source, not the disk`,
      );
    }
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let body;
    try {
      body = await readFile(resolve(path), "utf8");
    } catch (err) {
      throw new Error(`delegate: cannot read "${path}": ${err?.message ?? err}`);
    }
    const kept = body.length > budget ? body.slice(0, budget) : body;
    if (kept.length < body.length) truncated = true;
    budget -= kept.length;
    attached.push({ path, chars: kept.length, of: body.length });
    blocks.push(
      `--- FILE: ${path}${kept.length < body.length ? " (truncated)" : ""} ---\n${kept}`,
    );
  }

  return { blocks, attached, truncated };
}

/*
  A system prompt that says what a sub-task IS.

  Without it a capable model answers as an assistant — offering to help further,
  asking what else is needed — and the caller here is another model, which
  cannot answer and will not read the offer. Short and factual: the return value
  is the entire point.
*/
const SYSTEM = [
  "You are a sub-task worker inside Operator, a personal dashboard app.",
  "Another agent is doing a job and has handed you one piece of it.",
  "Answer the task directly and completely. Your reply IS the return value:",
  "no preamble, no offers of further help, no questions back — the caller is a",
  "program and cannot answer them. If the attached files do not contain what the",
  "task needs, say exactly that and name what is missing rather than guessing.",
].join(" ");

/**
 * Run one delegated sub-task.
 *
 * @param {object}   opts
 * @param {string}   opts.task     what to do, in plain words
 * @param {string[]} [opts.files]  paths whose contents to attach
 * @param {string}   [opts.worker] "airouter" | "ollama"
 * @param {string}   [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{worker:string, model:string|null, text:string,
 *                    attached:object[], truncated:boolean, ms:number}>}
 */
export async function delegate({ task, files = [], worker, model, signal } = {}) {
  const prompt = String(task ?? "").trim();
  if (!prompt) throw new Error("delegate: nothing to do — give it a task");

  const workers = available();
  const chosen = worker || workers[0];
  if (!workers.includes(chosen)) {
    throw new Error(
      `delegate: no worker "${chosen}" — available: ${workers.join(", ") || "none"}`,
    );
  }

  const { blocks, attached, truncated } = await attachments(files);
  const full = blocks.length ? `${prompt}\n\n${blocks.join("\n\n")}` : prompt;

  const started = Date.now();
  let text = "";
  let usedModel = model || null;

  if (chosen === "airouter") {
    const { runTurn, DEFAULT_MODEL } = await import("./airouter.mjs");
    usedModel = model || DEFAULT_MODEL;

    /*
      Our own deadline, forwarded alongside the caller's.

      `airouter.mjs` has a per-REQUEST timeout; this is a per-DELEGATION one.
      They are not the same bound — a model that keeps going would sit inside
      the request timeout indefinitely, and a sub-task that never returns wedges
      the turn that asked for it.
    */
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
    signal?.addEventListener?.("abort", () => deadline.abort(), { once: true });
    try {
      const result = await runTurn({
        prompt: full,
        model: usedModel,
        appendSystemPrompt: SYSTEM,
        signal: deadline.signal,
        // See the header: a sub-task returns prose. Tools would make it an
        // actor, and would spend ~16KB of declarations it has no use for.
        useTools: false,
        /*
          No internal reasoning. A sub-task is extraction or summary, and the
          thinking is pure latency: one conversation spent 13,788 characters of
          reasoning to produce 3,454 of answer, took a hundred seconds, and hit
          the timeout — which came back as silence.
        */
        reasoningEffort: "none",
        onEvent: (type, data) => {
          if (type === "text") text += data.text;
        },
      });
      if (result?.error) throw new Error(result.error);
      /*
        An empty reply is a FAILURE, and it used to be indistinguishable from a
        model that had nothing to say.

        `runTurn` reports an abort as `error: null` — deliberately, so pressing
        Stop is not an error — and a timeout is an abort. So a request that ran
        out of time returned no text and no error, and the importer logged
        "no JSON array in the reply (0 chars)" and moved on, losing that window
        of the conversation without anything saying why.

        A sub-task that produces nothing has failed. Saying so lets the caller
        retry it instead of silently importing less than it should.
      */
      if (!text.trim()) {
        throw new Error(
          "the worker returned nothing — usually the request timed out mid-answer; " +
            "try a smaller window or a longer OPERATOR_DELEGATE_TIMEOUT_MS",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    const { ask, isAvailable, installedModels } = await import("./ollama.mjs");
    if (!(await isAvailable())) {
      throw new Error("delegate: the local model is not running (ollama serve)");
    }
    usedModel = model || (await installedModels())[0] || null;
    text = await ask({
      prompt: full,
      model: usedModel,
      system: SYSTEM,
      signal,
      // The default is 200 — a classifier's budget. A delegated read is
      // supposed to come back with something worth having.
      maxTokens: 4000,
    });
  }

  return {
    worker: chosen,
    model: usedModel,
    text: String(text ?? "").trim(),
    attached,
    truncated,
    ms: Date.now() - started,
  };
}
