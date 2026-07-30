import { MessageSquare } from "lucide-react";
import ClaudeChat from "@/components/dev/ClaudeChat";

/**
 * Talking to Claude, as its own page rather than a panel buried under the Dev
 * tools.
 *
 * It started on `/dev` because that is where the terminal lives and the two
 * share a gate. But the owner uses this to actually work — from a phone, away
 * from the machine — and a thing you use constantly should not be three
 * scroll-lengths down a page named after something else.
 *
 * This is also the shape the owner has said he wants next: **one chat page that
 * picks a model per task**, once more than one provider exists. The page is the
 * container for that; the component below currently speaks to exactly one
 * provider, per ADR 0009 — a boundary with one implementation, not a framework
 * waiting for a second.
 */
export default function Chat() {
  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <MessageSquare size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Claude</h1>
          <p className="text-xs text-ink-500 truncate">
            Working on this project, with memory between messages.
          </p>
        </div>
      </div>

      <ClaudeChat />
    </div>
  );
}
