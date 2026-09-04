// Provider manager for Operator jobs.
//
// `jobs.mjs` is the orchestrator: it owns the queue, job state, resources,
// permissions and owner-facing event log. This file owns only the swappable
// worker boundary. One implementation is deliberate — writing a speculative
// Codex/OpenAI adapter would add an external integration before the owner has
// approved its host, credentials and data disclosure.

import { runTurn as runClaudeTurn } from "./runner.mjs";
import { runTurn as runGeminiTurn } from "./gemini.mjs";
import {
  runTurn as runAirouterTurn,
  configured as airouterConfigured,
  MODELS as airouterModels,
  DEFAULT_MODEL as airouterDefaultModel,
} from "./airouter.mjs";
import {
  runTurn as runOllamaTurn,
  isAvailable as ollamaAvailable,
  installedModels as installedOllamaModels,
} from "./ollama.mjs";

const CLAUDE_CODE = {
  id: "claude-code",
  label: "Claude Code",
  defaultModel: "claude-opus-5",
  models: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    // Added 2026-08-30 to be tried, not adopted. Conversational feel is judged
    // by using a model, not by reading about it, and the presence layer
    // (docs/presence-layer-design.md) needs a voice worth talking to.
    { id: "claude-fable-5", label: "Fable 5" },
  ],
  capabilities: {
    tools: true,
    attachments: "local-path",
    permissions: "interactive",
    sessions: true,
    verification: "worker-reported",
  },
  runTurn: runClaudeTurn,
};

/**
 * Gemini, approved by name 2026-08-20 (see CLAUDE.md's table).
 *
 * Its capabilities differ from Claude Code's in ways that matter, and saying
 * so here is the point of this field existing: no filesystem, no shell, no
 * mid-turn permission prompt — everything it can do is a pre-approved
 * capability action, so there is nothing to ask about. `attachments: false`
 * because uploads are passed to a worker as local paths, which is meaningless
 * to a worker that cannot read the disk.
 *
 * Only registered when a key is actually configured. A worker listed in the
 * model picker that fails on first use with "GEMINI_API_KEY is not set" is a
 * worse experience than one that isn't offered — and the server is where the
 * key's absence is knowable.
 */
const GEMINI = {
  id: "gemini",
  label: "Gemini",
  defaultModel: "gemini-flash-latest",
  models: [
    { id: "gemini-flash-latest", label: "Gemini Flash" },
    { id: "gemini-pro-latest", label: "Gemini Pro" },
  ],
  capabilities: {
    tools: "capability-actions",
    attachments: false,
    permissions: "pre-approved",
    sessions: "in-memory",
    verification: "worker-reported",
  },
  runTurn: runGeminiTurn,
};

/**
 * The local worker. Registered by `initProviders()` rather than here, because
 * "is Ollama running" is an async question and this map is built at import.
 *
 * Its models are not hardcoded: they are whatever this machine has actually
 * pulled. A picker offering `qwen2.5:3b` on a box where it was never pulled is
 * the same failure the GEMINI note above describes - a worker that is listed
 * and then fails on first use is worse than one that is not offered.
 */
const OLLAMA = {
  id: "ollama",
  label: "Local",
  defaultModel: null, // filled from what is installed
  models: [],
  capabilities: {
    tools: "capability-actions",
    attachments: false,
    permissions: "pre-approved",
    sessions: "in-memory",
    verification: "worker-reported",
    // The one capability no other worker has, and the reason this exists.
    local: true,
  },
  runTurn: runOllamaTurn,
};

/**
 * AI Router — flat-rate, Swiss-hosted, OpenAI-compatible. ADR 0016.
 *
 * Registered here rather than probed like OLLAMA because a key either exists at
 * boot or it does not; there is no service to come up late.
 *
 * **It is the local model's replacement, not Claude's.** The 3B that Ollama can
 * fit in 4GB of VRAM is measurably too weak for the verification and routing it
 * is already given, and these are 27B and 284B at a fixed monthly price. Claude
 * on the Pro subscription keeps the judgement work, where its marginal turn is
 * already free.
 *
 * **It has a filesystem as of 2026-09-04**, and that is the one place it now
 * differs from the other two non-Claude workers. The owner's reason: *"when
 * claude is down ai router is the second most capable worker"* — and a fallback
 * that can only discuss the code is not a fallback for a coding job.
 *
 * Read the three flags below together, because the distinctions are load
 * bearing and easy to collapse:
 *
 * - `tools` stays `"capability-actions"`. That value means "reaches
 *   actions.mjs", and `jobs.mjs` uses `tools === true` to mean "can run
 *   arbitrary commands as the owner" — the test its no-escalation guard depends
 *   on. This worker still cannot, so the value must not change.
 * - `files: true` is the new one. `server/workspace.mjs` gives it read, list,
 *   search, write, edit and a FIXED set of named checks — never a shell.
 *   Writes land only in the job's own worktree.
 * - `permissions` becomes `"interactive"`, because a write now suspends the
 *   turn and asks him, through the same `onPermission` channel Claude uses.
 *   Leaving it as `"pre-approved"` would tell the page nothing can ask, which
 *   stopped being true.
 */
const AIROUTER = {
  id: "airouter",
  label: "AI Router",
  defaultModel: airouterDefaultModel,
  models: airouterModels.map((id) => ({ id, label: id })),
  capabilities: {
    tools: "capability-actions",
    files: true,
    /*
      Attachments are local PATHS handed to a worker (server/uploads.mjs), which
      was meaningless to a worker that could not read a disk. It can now: since
      2026-09-04 `data/job-resources/` is carved out of workspace.mjs's `data/`
      refusal, so a claimed text file is readable, and image files become vision
      parts in `userMessage` (airouter.mjs).

      True from that date. It was left false for a few hours with a comment
      saying it should be true — the session that wrote the feature could not
      make the edit land and said so rather than claiming it had. Honest, and
      still the worst of both: a flag that contradicts the comment above it. A
      capability the page advertises and the worker cannot honour is worse than
      one it does not claim, and so is the reverse.
    */
    attachments: true,
    permissions: "interactive",
    sessions: "in-memory",
    verification: "worker-reported",
  },
  runTurn: runAirouterTurn,
};

const WORKERS = new Map([
  [CLAUDE_CODE.id, CLAUDE_CODE],
  /*
    Gemini is RETIRED, 2026-09-02. Registered only if explicitly asked for.

    Two reasons that compound. Its free tier is twenty requests a DAY, so it
    was unusable most evenings — and it was the routing classifier, which
    meant every routing decision silently fell back to the expensive worker
    exactly when it mattered. And its key was burned by being typed into
    Operator's own terminal, which logs every command it runs.

    AI Router does the same job with no daily count and no per-call cost.

    The file stays and the worker can be brought back with
    OPERATOR_ENABLE_GEMINI=1, because deleting a working provider to make a
    point is not the same as retiring it.
  */
  ...(process.env.OPERATOR_ENABLE_GEMINI && process.env.GEMINI_API_KEY
    ? [[GEMINI.id, GEMINI]]
    : []),
  ...(airouterConfigured ? [[AIROUTER.id, AIROUTER]] : []),
]);

/**
 * Keep the local worker's registration in step with reality.
 *
 * **Re-probed rather than detected once at boot**, and the reason is ordering:
 * Ollama runs continuously, but Operator is started by Task Scheduler and can
 * easily come up first. A one-shot probe would then miss a service that was
 * merely a few seconds behind, and the local worker would stay absent until
 * somebody restarted Operator for reasons they could not have guessed.
 *
 * The same loop keeps the model list honest. Pulling a model is a thing the
 * owner does at a terminal, not a thing Operator observes, so a boot-time
 * snapshot goes stale the first time he runs `ollama pull` - and a picker that
 * omits a model he can see installed is the kind of small wrongness that costs
 * an evening to explain.
 *
 * One loopback request a minute. Deliberately never throws: Ollama being absent
 * is the normal case on a fresh checkout, not an error, and it must never take
 * the storage server down with it.
 */
const OLLAMA_REPROBE_MS = 60_000;
let lastOllamaSignature = "";

async function refreshOllama({ log = () => {} } = {}) {
  try {
    const models = (await ollamaAvailable()) ? await installedOllamaModels() : [];
    // Only act when something actually changed, so this is silent in the log
    // when nothing is happening - which is almost always.
    const signature = models.join(",");
    if (signature === lastOllamaSignature) return;
    lastOllamaSignature = signature;

    if (models.length === 0) {
      if (WORKERS.delete(OLLAMA.id)) log("[operator] local worker went away");
      return;
    }
    OLLAMA.models = models.map((id) => ({ id, label: id }));
    OLLAMA.defaultModel = models[0];
    WORKERS.set(OLLAMA.id, OLLAMA);
    log(`[operator] local worker available: ${models.join(", ")}`);
  } catch {
    // A probe that fails changes nothing. The next one tries again.
  }
}

export async function initProviders({ log = () => {} } = {}) {
  await refreshOllama({ log });
  const timer = setInterval(() => void refreshOllama({ log }), OLLAMA_REPROBE_MS);
  // Don't hold the process open for a probe loop.
  timer.unref?.();
  return timer;
}

/** Safe metadata for the client. Never expose a worker implementation. */
function describe(worker) {
  return {
    id: worker.id,
    label: worker.label,
    defaultModel: worker.defaultModel,
    models: worker.models,
    capabilities: worker.capabilities,
  };
}

export const DEFAULT_PROVIDER = CLAUDE_CODE.id;

export function listProviders() {
  return [...WORKERS.values()].map(describe);
}

/** Resolve an explicit request, or the single configured default. */
export function selectWorker(providerId, modelId) {
  const worker = WORKERS.get(providerId ?? DEFAULT_PROVIDER);
  if (!worker) throw new Error(`provider is not enabled: ${providerId}`);
  const model = worker.models.find((candidate) => candidate.id === (modelId ?? worker.defaultModel));
  if (!model) throw new Error(`model is not available from ${worker.label}: ${modelId}`);
  return { worker, provider: worker.id, model: model.id };
}

/** The only dispatch point. Future providers implement this same turn contract. */
export async function runWorkerTurn(providerId, spec) {
  const worker = WORKERS.get(providerId);
  if (!worker) throw new Error(`provider is not enabled: ${providerId}`);
  return worker.runTurn(spec);
}
