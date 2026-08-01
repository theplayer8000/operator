import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The Claude workspace, as jobs rather than one conversation.
 *
 * `server/jobs.mjs` replaced the single in-memory conversation with a list of
 * jobs, each carrying an append-only event log. Two consequences shape this
 * hook:
 *
 * - **The list is summaries only.** A long build's log runs to thousands of
 *   events, and the tab strip is polled — so `GET /api/jobs` never carries
 *   them, and events arrive only for the job actually being looked at.
 * - **Events are read by offset**, exactly as the terminal reads command
 *   output. Polling is what works on the owner's phone (stream readers deliver
 *   nothing there), and an append-only log means a phone that locked mid-turn
 *   catches up on the next poll rather than losing the gap.
 *
 * Feature-hook shape per CLAUDE.md: the page never fetches `/api/jobs` itself.
 */

export interface JobSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  status: "queued" | "running" | "complete" | "failed" | "blocked" | "cancelled" | string;
  sessionId: string | null;
  device: string | null;
  createdAt: string;
  turns: number;
  costUsd: number;
  error: string | null;
  restored?: boolean;
  queued: number;
  latest: number;
}

/** Every event carries seq/at/type; the rest depends on the type. */
export interface JobEvent {
  seq: number;
  at: string;
  type: "prompt" | "text" | "tool_use" | "tool_result" | "permission_request" | "status" | "usage";
  text?: string;
  raw?: boolean;
  error?: boolean;
  tool?: string;
  subject?: string;
  description?: string;
  rule?: string;
  /*
    Which kind of refusal this is — the standing profile, or an ordinary
    missing rule. Optional because an event log from before the server was
    restarted won't carry it, and the old "offer a grant" path is the right
    fallback for anything that predates the profile.
  */
  standing?: boolean;
  ok?: boolean;
  status?: string;
  detail?: string;
  turnUsd?: number;
  jobUsd?: number;
  spentUsd?: number;
  budgetUsd?: number | null;
}

interface JobsList {
  jobs: JobSummary[];
  running: string | null;
  models?: { id: string; label: string }[];
  defaultModel?: string;
  /** The standing permission profile, named by the server rather than in prose. */
  deniedTools?: string[];
  spentUsd?: number;
  budgetUsd?: number | null;
  scope?: string;
  authorised?: boolean;
  canManage?: boolean;
  you?: string | null;
  reason?: string;
}

/** Poll fast while something is running, slowly when nothing is. */
const TICK_BUSY = 1200;
const TICK_IDLE = 8000;

export function useJobs() {
  const [list, setList] = useState<JobsList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /*
    "New chat" is a state, not the absence of one.

    Deselecting alone doesn't work: the effect below opens the newest job
    whenever nothing is selected, so clicking New chat was undone on the same
    render and you were still looking at the old conversation. This flag says
    "deliberately on a blank one" and suppresses that.
  */
  const [composing, setComposing] = useState(false);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sinceRef = useRef(0);
  const listInFlight = useRef(false);
  const eventsInFlight = useRef(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    // One request at a time. StrictMode fires mount effects twice, and two
    // polls racing each other is how the old chat rendered every message
    // three times — see the note in M15's handoff.
    if (listInFlight.current) return null;
    listInFlight.current = true;
    try {
      const res = await fetch("/api/jobs", { headers: { accept: "application/json" } });
      if (res.status === 401) {
        setError("This device isn't authorised. Open Operator on the Tailscale address.");
        return null;
      }
      const body = (await res.json()) as JobsList;
      setList(body);
      setError(null);
      return body;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      listInFlight.current = false;
    }
  }, []);

  const refreshEvents = useCallback(async (id: string, reset = false) => {
    if (eventsInFlight.current) return;
    eventsInFlight.current = true;
    try {
      const from = reset ? 0 : sinceRef.current;
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}?since=${from}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const body = (await res.json()) as JobSummary & { events: JobEvent[] };
      const incoming = body.events ?? [];
      if (incoming.length) sinceRef.current = incoming[incoming.length - 1].seq;
      setEvents((prev) => {
        const merged = reset ? incoming : [...prev, ...incoming];
        // De-duplicate by seq. The guard above makes a repeat unlikely; this
        // makes it impossible, which matters because a duplicated reply reads
        // as having been charged twice.
        const bySeq = new Map<number, JobEvent>();
        for (const e of merged) bySeq.set(e.seq, e);
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      });
    } catch {
      /* transient — the next tick retries, and the offset means nothing is lost */
    } finally {
      eventsInFlight.current = false;
    }
  }, []);

  /** Switch tabs: clear the log and re-read from the start of that job. */
  const select = useCallback(
    async (id: string | null) => {
      if (id) setComposing(false);
      setSelectedId(id);
      sinceRef.current = 0;
      setEvents([]);
      if (id) await refreshEvents(id, true);
    },
    [refreshEvents]
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Open the running job, or the newest — but never over a blank one the user
  // asked for.
  useEffect(() => {
    if (composing || selectedId || !list?.jobs?.length) return;
    void select(list.running ?? list.jobs[list.jobs.length - 1].id);
  }, [list, selectedId, composing, select]);

  const busy = list?.running !== null && list?.running !== undefined;

  useEffect(() => {
    const tick = () => {
      void refreshList();
      if (selectedRef.current) void refreshEvents(selectedRef.current);
    };
    const timer = setInterval(tick, busy ? TICK_BUSY : TICK_IDLE);
    return () => clearInterval(timer);
  }, [busy, refreshList, refreshEvents]);

  // Coming back to the app should show the current state immediately rather
  // than after a tick — same reasoning as the store's resume handling in M15.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      void refreshList();
      if (selectedRef.current) void refreshEvents(selectedRef.current);
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [refreshList, refreshEvents]);

  async function post(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as {
      error?: string;
      reason?: string;
      id?: string;
      added?: boolean;
    };
    if (!res.ok) throw new Error(parsed.reason ?? parsed.error ?? `server returned ${res.status}`);
    return parsed;
  }

  /** Start a new job. Returns its id so the caller can select it. */
  const create = useCallback(
    async (prompt: string, model?: string) => {
      setError(null);
      try {
        const body = await post("/api/jobs", { prompt, model });
        setComposing(false);
        await refreshList();
        if (body.id) await select(body.id);
        return body.id ?? null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [refreshList, select]
  );

  /** Send another turn into an existing job. */
  const send = useCallback(
    async (id: string, text: string) => {
      setError(null);
      try {
        await post(`/api/jobs/${encodeURIComponent(id)}/input`, { text });
        await refreshEvents(id);
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshEvents, refreshList]
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        await post(`/api/jobs/${encodeURIComponent(id)}/input`, { type: "cancel" });
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshList]
  );

  const setModel = useCallback(
    async (id: string, model: string) => {
      try {
        await post(`/api/jobs/${encodeURIComponent(id)}/model`, { model });
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshList]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (selectedRef.current === id) await select(null);
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshList, select]
  );

  const clearAll = useCallback(async () => {
    try {
      await post("/api/jobs/clear");
      await select(null);
      await refreshList();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refreshList, select]);

  /**
   * Write the rule that would have permitted a blocked tool.
   *
   * Print mode can't stop and ask, so a denial is otherwise a dead end from a
   * phone. This writes the same rule the interactive prompt would, to the same
   * file. Nothing new is granted — an authorised device can already run
   * anything through the terminal.
   */
  const allowRule = useCallback(async (rule: string) => {
    const body = await post("/api/jobs/allow", { rule });
    return body.added ? "allowed" : (body.reason ?? "already allowed");
  }, []);

  /** Show a blank conversation. What gets sent next starts a new job. */
  const startNew = useCallback(() => {
    setComposing(true);
    setSelectedId(null);
    sinceRef.current = 0;
    setEvents([]);
  }, []);

  const selected = list?.jobs?.find((j) => j.id === selectedId) ?? null;

  return {
    list,
    jobs: list?.jobs ?? [],
    models: list?.models ?? [],
    defaultModel: list?.defaultModel,
    deniedTools: list?.deniedTools ?? [],
    runningId: list?.running ?? null,
    authorised: list?.authorised !== false,
    canManage: list?.canManage === true,
    reason: list?.reason,
    you: list?.you ?? null,
    spentUsd: list?.spentUsd ?? 0,
    budgetUsd: list?.budgetUsd ?? null,
    selected,
    selectedId,
    composing,
    startNew,
    events,
    busy,
    error,
    setError,
    select,
    create,
    send,
    cancel,
    setModel,
    remove,
    clearAll,
    allowRule,
    refreshList,
  };
}
