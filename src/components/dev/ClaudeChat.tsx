import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Send, Plus, ShieldAlert, Loader2, Ban, Check, Power } from "lucide-react";
import Markdown from "@/components/ui/Markdown";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  error?: boolean;
  costUsd?: number | null;
  durationMs?: number | null;
  model?: string;
  denials?: Denial[];
}

interface Denial {
  tool: string;
  subject: string;
  description: string;
  rule: string;
}

interface ChatState {
  provider?: string;
  model?: string;
  models?: { id: string; label: string }[];
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
  const inFlightRef = useRef(false);
  const [allowed, setAllowed] = useState<Record<string, string>>({});

  const poll = useCallback(async () => {
    /*
      Two polls must never be in flight at once.

      Without this guard every message appeared two or three times on the
      owner's phone — React's StrictMode fires the mount effect twice, both
      polls read `sinceRef` before either had advanced it, and each appended the
      whole transcript. The screenshot showed one question and one answer
      rendered twice over, which also reads as being charged twice.
    */
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    try {
      const res = await fetch(`/api/chat?since=${sinceRef.current}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 401) {
        setError("This device isn't authorised. Open Operator on the Tailscale address.");
        return null;
      }
      const body = (await res.json()) as ChatState;
      if (body.latest) sinceRef.current = body.latest;
      setState((prev) => {
        // Append what's new, then de-duplicate by id. The guard above prevents
        // the common case; this makes a repeat impossible rather than unlikely,
        // which matters because the failure is silent and looks like a charge.
        const byId = new Map<string, ChatMessage>();
        for (const m of [...(prev?.messages ?? []), ...(body.messages ?? [])]) {
          byId.set(m.id, m);
        }
        return { ...body, messages: [...byId.values()] };
      });
      return body;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      inFlightRef.current = false;
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
      // No optimistic copy: the server records the user message synchronously
      // before spawning, so one poll shows it with the server's own id. A local
      // placeholder would carry a fake id that can't de-duplicate against it —
      // which is exactly how the triple-render happened.
      setState((prev) => (prev ? { ...prev, busy: true } : prev));
      await poll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Write the rule that would have permitted a blocked tool.
   *
   * Print mode can't stop and ask, so a denial is otherwise a dead end from a
   * phone — the approval prompt Claude refers to only exists in an interactive
   * terminal at the desk. This writes the same rule that prompt would, to the
   * same file. Nothing new is granted: an authorised device can already run
   * anything through the terminal.
   */
  async function allow(rule: string) {
    setAllowed((prev) => ({ ...prev, [rule]: "working" }));
    try {
      const res = await fetch("/api/chat/allow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule }),
      });
      const body = (await res.json()) as { added?: boolean; error?: string; reason?: string };
      setAllowed((prev) => ({
        ...prev,
        [rule]: res.ok ? (body.added ? "allowed" : (body.reason ?? "already allowed")) : (body.error ?? "failed"),
      }));
    } catch (err) {
      setAllowed((prev) => ({ ...prev, [rule]: (err as Error).message }));
    }
  }

  /**
   * Arm from here as well as from the terminal panel.
   *
   * They share one flag server-side, but the chat now lives on its own page —
   * sending someone to a different page to switch on the thing they are looking
   * at is the same mistake as requiring an env var at the machine.
   */
  async function arm() {
    setError(null);
    await fetch("/api/terminal/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    await poll();
  }

  async function chooseModel(id: string) {
    setState((prev) => (prev ? { ...prev, model: id } : prev));
    await fetch("/api/chat/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: id }),
    }).catch(() => {});
    await poll();
  }

  async function startNew() {
    setError(null);
    await fetch("/api/chat/new", { method: "POST" }).catch(() => {});
    sinceRef.current = 0;
    setState(null);
    await poll();
  }

  const notAuthorised = state !== null && state.authorised === false;
  // Listed but disarmed is fixable from here; not listed is not.
  const canArm = notAuthorised && state?.canManage === true;

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
            className="flex items-center gap-1.5 px-3 min-h-[44px] shrink-0 rounded-badge border border-base-600 text-xs text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <Plus size={14} />
            {/* Labelled at every width. As a bare "+" on a phone nobody can
                tell whether it adds a message, a file, or wipes the thread. */}
            New chat
          </button>
        )}
      </header>

      {notAuthorised && (
        <div className="p-3 rounded-badge border border-xp/30 bg-xp/5">
          <p className="flex items-start gap-2 text-xs text-ink-300 leading-relaxed mb-3">
            <ShieldAlert size={14} className="text-xp shrink-0 mt-0.5" />
            <span>
              {state?.reason}. Chat runs Claude Code with tool access, so it sits behind the same
              gate as the terminal — being a known device gets you Operator, not a shell.
            </span>
          </p>
          {canArm && (
            <button
              onClick={() => void arm()}
              className="flex items-center gap-2 px-3 min-h-[44px] rounded-badge border border-xp/40 bg-xp/10 text-xs text-xp hover:bg-xp/20 transition-colors"
            >
              <Power size={14} /> Arm it
            </button>
          )}
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
                    className={`inline-block max-w-[92%] text-left px-3 py-2 rounded-badge text-sm leading-relaxed break-words ${
                      m.role === "user"
                        ? "bg-base-700/60 text-ink-100 whitespace-pre-wrap"
                        : m.error
                          ? "border border-vital-down/40 bg-vital-down/10 text-vital-down whitespace-pre-wrap"
                          : "border border-base-600 text-ink-300"
                    }`}
                  >
                    {/* Only Claude's replies are markdown. What the owner typed
                        is shown exactly as typed — rendering his own asterisks
                        as bold would be the app editing his words. */}
                    {m.role === "assistant" && !m.error ? <Markdown text={m.text} /> : m.text}
                  </span>
                  {m.role === "assistant" && !m.error && (
                    <span
                      className="block text-[10px] font-mono text-ink-700 mt-1"
                      /* The figure Claude Code reports is the API-equivalent
                         cost. On a subscription login it is plan usage, not a
                         charge — showing "$0.4472" next to a reply read as a
                         bill, so it moves to the tooltip and says what it is. */
                      title={
                        m.costUsd != null
                          ? `≈$${m.costUsd.toFixed(4)} of equivalent API usage — counted against your plan, not billed separately`
                          : undefined
                      }
                    >
                      {m.durationMs != null && `${(m.durationMs / 1000).toFixed(1)}s`}
                      {m.model && ` · ${m.model.replace("claude-", "")}`}
                    </span>
                  )}
                  {m.role === "assistant" &&
                    m.denials?.map((d) => (
                      <div
                        key={d.rule}
                        className="mt-2 p-3 rounded-badge border border-xp/30 bg-xp/5 text-left"
                      >
                        <p className="flex items-center gap-1.5 text-[11px] text-xp mb-1">
                          <Ban size={11} className="shrink-0" />
                          Needed permission — it couldn&apos;t ask, so it stopped
                        </p>
                        <p className="text-xs text-ink-300 mb-1 break-words">
                          <span className="font-mono text-ink-500">{d.tool}</span>
                          {d.subject && <span className="font-mono"> — {d.subject}</span>}
                        </p>
                        {d.description && (
                          <p className="text-[11px] text-ink-700 mb-2">{d.description}</p>
                        )}
                        <p className="text-[10px] font-mono text-ink-700 mb-2 break-all">
                          rule: {d.rule}
                        </p>
                        {allowed[d.rule] ? (
                          <p className="flex items-center gap-1.5 text-[11px] text-vital-up">
                            <Check size={11} />
                            {allowed[d.rule]} — ask again and it&apos;ll go through
                          </p>
                        ) : (
                          <button
                            onClick={() => void allow(d.rule)}
                            className="px-3 min-h-[38px] rounded-badge border border-xp/40 bg-xp/10 text-xs text-xp hover:bg-xp/20 transition-colors"
                          >
                            Allow this
                          </button>
                        )}
                      </div>
                    ))}
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

          {(state?.models?.length ?? 0) > 1 && (
            <div className="flex items-center gap-1.5 mb-2">
              {state?.models?.map((m) => (
                <button
                  key={m.id}
                  onClick={() => void chooseModel(m.id)}
                  disabled={state?.busy}
                  className={`px-3 min-h-[38px] rounded-badge border text-xs transition-colors ${
                    state?.model === m.id
                      ? "border-xp/40 bg-xp/10 text-xp"
                      : "border-base-600 text-ink-500 hover:text-ink-300"
                  } disabled:opacity-50`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

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
            Runs Claude Code against this project and remembers across messages — the same
            conversation you can pick up at the desk. It has tool access, so it can read and change
            files, but it <strong className="font-normal text-ink-500">can&apos;t stop and ask you
            anything</strong>: print mode is one-way. When it needs a permission it stops and tells
            you which one — tap Allow to write that rule to{" "}
            <span className="font-mono">.claude/settings.local.json</span> and ask again. Transcript is in memory; Claude
            keeps the real session, so &ldquo;New chat&rdquo; starts a fresh one rather than
            deleting anything.
          </p>
        </>
      )}
    </section>
  );
}
