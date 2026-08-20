// Provider manager for Operator jobs.
//
// `jobs.mjs` is the orchestrator: it owns the queue, job state, resources,
// permissions and owner-facing event log. This file owns only the swappable
// worker boundary. One implementation is deliberate — writing a speculative
// Codex/OpenAI adapter would add an external integration before the owner has
// approved its host, credentials and data disclosure.

import { runTurn as runClaudeTurn } from "./runner.mjs";

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

const WORKERS = new Map([[CLAUDE_CODE.id, CLAUDE_CODE]]);

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
