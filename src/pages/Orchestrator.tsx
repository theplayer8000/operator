import { MessageSquare } from "lucide-react";
import OrchestratorChat from "@/components/orchestrator/OrchestratorChat";

/**
 * The orchestrator — was "Claude", renamed 2026-08-20.
 *
 * The rename is the milestone, not a relabel: `server/providers.mjs` now sits
 * between `jobs.mjs` and the worker that actually runs a turn, so a job is no
 * longer "a Claude conversation" — it's a task, dispatched to whichever worker
 * is enabled for it. Only one is, today. The page name says what it's *for*
 * rather than what it currently, incidentally, only does.
 *
 * The component below was `dev/ClaudeChat.tsx` until 2026-08-20, kept that way
 * on the argument that it only ever spoke to one worker. Gemini landing the
 * same day ended that argument, so it is now
 * `orchestrator/OrchestratorChat.tsx` and reads each job's provider and
 * declared capabilities rather than assuming Claude Code's — which is also
 * what stopped its footer describing behaviour the app no longer had.
 *
 * It started on `/dev` because that's where the terminal lives and the two
 * share a gate. The owner uses this to actually work — from a phone, away from
 * the machine — and a thing you use constantly should not be three
 * scroll-lengths down a page named after something else.
 */
export default function Orchestrator() {
  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <MessageSquare size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Orchestrator</h1>
          <p className="text-xs text-ink-500 truncate">
            Routes a task to a worker and keeps memory between messages.
          </p>
        </div>
      </div>

      <OrchestratorChat />
    </div>
  );
}
