import { MessageSquare } from "lucide-react";
import ClaudeChat from "@/components/dev/ClaudeChat";

/**
 * The orchestrator — was "Claude", renamed 2026-08-20.
 *
 * The rename is the milestone, not a relabel: `server/providers.mjs` now sits
 * between `jobs.mjs` and the worker that actually runs a turn, so a job is no
 * longer "a Claude conversation" — it's a task, dispatched to whichever worker
 * is enabled for it. Only one is, today. The page name says what it's *for*
 * rather than what it currently, incidentally, only does.
 *
 * `ClaudeChat.tsx` keeps its name deliberately. It is still exactly what it
 * says: the chat surface for Claude Code, one implementation of the worker
 * contract `providers.mjs` describes. Renaming it would claim a generality the
 * component doesn't have yet — the day a second worker exists, its own
 * component earns this page's chrome (tab strip, composer, event log) the same
 * way this one does, not by this file pretending to be both.
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

      <ClaudeChat />
    </div>
  );
}
