import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Send, Plus, ShieldAlert, Loader2 } from "lucide-react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  error?: boolean;
  costUsd?: number | null;
  durationMs?: number | null;
}

interface ChatState {
  provider?: string;
  sessionId?: string | null;
  busy: boolean;
  turns?: number;
  lastError?: string | null;
  latest?: number;
  messages: ChatMessage[];
  authorised?: boolean;
  canManage?: boolean;
  reason?: string;
}

/**
 * A conversation with Claude Code that survives between messages.
 *
 * The terminal above runs one-shot commands; every `claude -p` there is a fresh
 * session that remembers nothing. This keeps the `session_id` Claude returns and
 * passes it back, so the owner can hand off from a session at his desk and carry
 * on from his phone — which is the whole point of the Embedded Claude Workspace.
 *
 * Polls rather than streams, for the reason established by the terminal: stream
 * readers deliver nothing on the owner's iPhone, and a reply that silently never
 * appears is worse than a slow one. Polls only while a turn is in flight.
 */
export default function ClaudeChat() {
  const [state, setState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef(0);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat?since=${sinceRef.current}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 401) {
        setError("This device isn't authorised. Open Operator on the Tailscale address.");
        return null;
      }
      const body = (await res.json()) as ChatState;
      setState((prev) => {
        // `since` returns only what's new, so append rather than replace —
        // otherwise every poll would redraw (and scroll) the whole transcript.
        const merged = [...(prev?.messages ?? []), ...(body.messages ?? [])];
        return { ...body, messages: merged };
      });
      if (body.latest) sinceRef.current = body.latest;
      return body;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    void poll();
  }, [poll]);

  // Only poll while Claude is actually working. An idle chat shouldn't tick.
  useEffect(() => {
    if (!state?.busy) return;
    const timer = setInterval(() => void poll(), 1500);
    return () => clearInterval(timer);
  }, [state?.busy, poll]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.messages.length, state?.busy]);

  async function send() {
    const text = draft.trim();
    if (!text || state?.busy) return;
    setDraft("");
    setError(null);
    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
        setError(body.reason ?? body.error ?? `server returned ${res.status}`);
        return;
      }
      // Show it immediately rather than waiting a poll cycle — on a phone the
      // gap reads as the app having dropped the message.
      setState((prev) =>
        prev
          ? {
              ...prev,
              busy: true,
              messages: [
                ...prev.messages,
                { id: `local-${Date.now()}`, role: "user", text, at: new Date().toISOString() },
              ],
            }
          : prev
      );
      // The optimistic copy above and the server's own will both arrive; skip
      // the server's echo of this turn by advancing past it on the next poll.
      const fresh = await poll();
      if (fresh) sinceRef.current = fresh.latest ?? sinceRef.current;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function startNew() {
    setError(null);
    await fetch("/api/chat/new", { method: "POST" }).catch(() => {});
    sinceRef.current = 0;
    setState(null);
    await poll();
  }

  const notAuthorised = state !== null && state.authorised === false;

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Claude</h2>
            <p className="text-xs text-ink-700 truncate">
              {notAuthorised
                ? state?.reason
                : state?.sessionId
                  ? `${state.turns} turn${state.turns === 1 ? "" : "s"} · session ${state.sessionId.slice(0, 8)}`
                  : "New conversation"}
            </p>
          </div>
        </div>
        {!notAuthorised && (
          <button
            onClick={() => void startNew()}
            aria-label="Start a new conversation"
            title="Start a new conversation"
            className="flex items-center gap-2 px-3 min-h-[44px] shrink-0 rounded-badge border border-base-600 text-xs text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <Plus size={14} />
            <span className="hidden sm:inline">New</span>
          </button>
        )}
      </header>

      {notAuthorised && (
        <div className="flex items-start gap-2 p-3 rounded-badge border border-xp/30 bg-xp/5">
          <ShieldAlert size={14} className="text-xp shrink-0 mt-0.5" />
          <p className="text-xs text-ink-300 leading-relaxed">
            {state?.reason}. Chat runs Claude Code with tool access, so it sits behind the same gate
            as the terminal — arm it above, on a listed device.
          </p>
        </div>
      )}

      {!notAuthorised && (
        <>
          {(state?.messages.length ?? 0) > 0 && (
            <div
              ref={listRef}
              className="space-y-3 max-h-96 overflow-auto mb-3 pr-1"
            >
              {state?.messages.map((m) => (
                <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
                  <span
                    className={`inline-block max-w-[92%] text-left px-3 py-2 rounded-badge text-sm leading-relaxed whitespace-pre-wrap break-words ${
                      m.role === "user"
                        ? "bg-base-700/60 text-ink-100"
                        : m.error
                          ? "border border-vital-down/40 bg-vital-down/10 text-vital-down"
                          : "border border-base-600 text-ink-300"
                    }`}
                  >
                    {m.text}
                  </span>
                  {m.role === "assistant" && !m.error && m.durationMs != null && (
                    <span className="block text-[10px] font-mono text-ink-700 mt-1">
                      {(m.durationMs / 1000).toFixed(1)}s
                      {m.costUsd != null && ` · $${m.costUsd.toFixed(4)}`}
                    </span>
                  )}
                </div>
              ))}
              {state?.busy && (
                <p className="flex items-center gap-2 text-xs text-ink-700">
                  <Loader2 size={13} className="animate-spin" /> Claude is working…
                </p>
              )}
            </div>
          )}

          {error && <p className="text-xs text-vital-down mb-3 break-words">{error}</p>}

          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the shape people
                // already expect from a chat box.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Ask Claude about this project…"
              aria-label="Message for Claude"
              className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 resize-none transition-colors"
            />
            <button
              onClick={() => void send()}
              disabled={draft.trim() === "" || state?.busy === true}
              aria-label="Send"
              title="Send"
              className="w-11 h-11 shrink-0 rounded-badge border border-xp/40 bg-xp/10 flex items-center justify-center text-xp hover:bg-xp/20 disabled:text-ink-700 disabled:border-base-600 disabled:bg-transparent transition-colors"
            >
              {state?.busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>

          <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
            Runs Claude Code against this project, and remembers across messages — the same
            conversation you can pick up at the desk. It has tool access, so it can read and change
            files. Transcript is held in memory; Claude keeps the real session, so &ldquo;New&rdquo;
            starts a fresh one rather than deleting anything.
          </p>
        </>
      )}
    </section>
  );
}
