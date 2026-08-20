// Provider manager for Operator jobs.
//
// `jobs.mjs` is the orchestrator: it owns the queue, job state, resources,
// permissions and owner-facing event log. This file owns only the swappable
// worker boundary. One implementation is deliberate — writing a speculative
// Codex/OpenAI adapter would add an external integration before the owner has
// approved its host, credentials and data disclosure.

import { runTurn as runClaudeTurn } from "./runner.mjs";
import { runTurn as runGeminiTurn } from "./gemini.mjs";

const CLAUDE_CODE = {
  id: "claude-code",
  label: "Claude Code",
  defaultModel: "claude-opus-5",
  models: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
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

const WORKERS = new Map([
  [CLAUDE_CODE.id, CLAUDE_CODE],
  ...(process.env.GEMINI_API_KEY ? [[GEMINI.id, GEMINI]] : []),
]);

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
