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
  /** Questions this job has stopped to ask. Waiting on a person, not working. */
  asking?: number;
  resources?: JobResource[];
  /**
   * Orchestrator bookkeeping from `server/providers.mjs` — always present on
   * the wire, mostly unused here. `attempts` is the one part with anything to
   * show today: a retry history. `task`/`handoff` stay untyped-in-detail
   * (`unknown`) rather than modelled fully, because their content is currently
   * identical on every job (`verification.status` is always `"not-run"`, the
   * same canned note) — there is nothing true to say about them yet beyond
   * "not implemented," and a fully-typed, empty-in-practice shape would be the
   * exact premature generality `CLAUDE.md` warns against. Revisit once a
   * verifier or a second worker gives them real content.
   */
  attempts?: JobAttempt[];
  /*
    Orchestrator bookkeeping. `verification` is the one part with anything to
    show: it was `not-run` on every job ever created until the gates started
    running, and a verdict nobody can see is the same as no verdict.
  */
  task?: {
    verification?: {
      status: "not-run" | "running" | "passed" | "failed" | "skipped" | "error";
      note?: string;
      /** Set only when status flips to "running" — lets a stuck one (a restart abandoned it mid-check) be told apart from a fresh one. */
      startedAt?: string;
      changed?: number;
      checks?: { name: string; passed: boolean; ms: number; output?: string }[];
      /** The Artifacts "Diff" pane. Absent on any job verified before this field existed, or one with nothing to build. */
      diff?: { stat: string; text: string; truncated: boolean; error?: string };
      /** The Artifacts "Build" pane's size readout — only present after a successful `npx vite build`. */
      bundle?: { files: { name: string; bytes: number }[]; totalBytes: number; error?: string };
    };
  } & Record<string, unknown>;
  handoff?: unknown;
}

/** One dispatch of a job's prompt to a worker — the retry history. */
export interface JobAttempt {
  number: number;
  provider: string;
  model: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

/** A local file attached to a Claude job; its binary never enters operator.json. */
export interface JobResource {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  createdAt: string;
}

/** Every event carries seq/at/type; the rest depends on the type. */
export interface JobEvent {
  seq: number;
  at: string;
  type:
    | "prompt"
    | "text"
    | "tool_use"
    | "tool_result"
    | "permission_request"
    | "permission_answer"
    | "routed"
    | "status"
    | "usage"
    | "accepted";
  text?: string;
  raw?: boolean;
  error?: boolean;
  tool?: string;
  subject?: string;
  description?: string;
  rule?: string;
  /*
    Present only on a **live** question — one the turn is currently suspended
    on, waiting to be answered (ADR 0012).

    Its absence is the whole distinction the UI turns on. The same event type is
    also emitted after the fact by the CLI fallback, describing a denial that
    already ended a turn; that one has no `id`, nothing is waiting for it, and
    rendering Allow/Deny buttons on it would offer a decision that resolves
    nothing. An event log replayed from before a restart is the other case: the
    question died with the process, so the buttons must not come back.
  */
  id?: string;
  pending?: boolean;
  /** The bridge's own sentence — "Claude wants to read foo.txt". */
  title?: string;
  /** On `permission_answer`: how the question ended. */
  decision?: "allowed" | "denied" | "timeout" | "cancelled" | "abandoned";
  by?: string | null;
  /** On `accepted`: what the control plane decided the moment it took the work. */
  started?: boolean;
  ahead?: number;
  concurrent?: number;
  limit?: number;
  /** On `routed`: which worker the orchestrator picked, and its reasoning. */
  provider?: string;
  label?: string;
  why?: string;
  /*
    Which kind of refusal this is — the standing profile, or an ordinary
    missing rule. Optional because an event log from before the server was
    restarted won't carry it, and the old "offer a grant" path is the right
    fallback for anything that predates the profile.
  */
  standing?: boolean;
  /*
    True on a `permission_request` that auto mode granted with nobody asked —
    the standing-consent case (server/jobs.mjs), never carries `id` since
    nothing is waiting to be answered. Distinct from an id-less event that
    predates a restart or came from the CLI fallback: those describe a denial
    or an expired question, this describes a grant. The three read very
    differently and share only "no `id`," which is why this exists rather
    than inferring the case from absence.
  */
  auto?: boolean;
  ok?: boolean;
  status?: string;
  detail?: string;
  turnUsd?: number;
  jobUsd?: number;
  spentUsd?: number;
  budgetUsd?: number | null;
}

/** A worker the server has enabled, and what it can actually do. */
export interface JobProvider {
  id: string;
  label: string;
  defaultModel: string;
  models: { id: string; label: string }[];
  capabilities?: Record<string, unknown>;
}

interface JobsList {
  jobs: JobSummary[];
  running: string | null;
  /**
   * Every job running right now, not just the first.
   *
   * `running` is kept as the first of them so nothing that already read it
   * breaks, but with OPERATOR_MAX_CONCURRENT above 1 it is no longer the whole
   * truth — a UI showing one spinner while three turns run is lying quietly.
   */
  runningIds?: string[];
  /** The ceiling, so the UI can say "3 of 4" rather than just "running". */
  maxConcurrent?: number;
  /** Every enabled worker. Only Claude Code until a key makes another possible. */
  providers?: JobProvider[];
  models?: { id: string; label: string }[];
  defaultModel?: string;
  /** The standing permission profile, named by the server rather than in prose. */
  deniedTools?: string[];
  /** What runs without asking — option C's quiet half, also named by the server. */
  allowedTools?: string[];
  /** Which runner is behind these jobs. Only "sdk" can pause to ask. */
  runner?: "sdk" | "cli";
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

  /*
    Coming back to the app should show the current state immediately rather than
    after a tick — same reasoning as the store's resume handling in M15, and now
    the same three events, which is the bit this was missing.

    **`pageshow` is the one iOS actually uses.** A backgrounded Safari tab has
    its timers suspended, so the interval above simply stops; when it comes back
    from the back-forward cache, `visibilitychange` and `focus` may never fire.
    Without this listener the page could sit for twenty minutes showing
    "working…" under a turn that had been suspended on a question the whole
    time — which is exactly what happened on 2026-08-19. `remoteStore` already
    listened for all three and says so in its own comment; the jobs poll did not.
  */
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      void refreshList();
      if (selectedRef.current) void refreshEvents(selectedRef.current);
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
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

  /**
   * Start a new job. Returns its id so the caller can select it.
   *
   * `provider` is chosen here and only here: a job holds one worker's session
   * for its whole life, and the two workers' sessions are not interchangeable
   * (Claude Code owns one on disk, Gemini's is a replayed history in the
   * server's memory). Switching worker mid-thread would silently start a new
   * conversation wearing the old one's tab, so the choice belongs at creation.
   */
  const create = useCallback(
    async (prompt: string, model?: string, resources: JobResource[] = [], provider?: string) => {
      setError(null);
      try {
        const body = await post("/api/jobs", { prompt, model, resources, provider });
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
    async (id: string, text: string, resources: JobResource[] = []) => {
      setError(null);
      try {
        await post(`/api/jobs/${encodeURIComponent(id)}/input`, { text, resources });
        await refreshEvents(id);
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshEvents, refreshList]
  );

  /** Upload raw local resources before the turn that references them starts. */
  const upload = useCallback(async (files: File[]) => {
    setError(null);
    try {
      const resources: JobResource[] = [];
      for (const file of files) {
        const res = await fetch("/api/jobs/resources", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-operator-file-name": file.name,
          },
          body: file,
        });
        const body = (await res.json().catch(() => ({}))) as { resource?: JobResource; error?: string };
        if (!res.ok || !body.resource) throw new Error(body.error ?? `couldn't upload ${file.name}`);
        resources.push(body.resource);
      }
      return resources;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

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

  /**
   * Requeue a job's last failed, blocked, or cancelled attempt.
   *
   * `server/jobs.mjs` grew this route with the attempts model; nothing on the
   * frontend called it until now. The prompt that started the attempt is kept
   * in memory only — never persisted, because it can carry owner content — so
   * a job that outlived a server restart has nothing to replay, and the server
   * says exactly that back rather than silently failing.
   */
  const retry = useCallback(
    async (id: string) => {
      try {
        await post(`/api/jobs/${encodeURIComponent(id)}/retry`);
        await refreshEvents(id);
        await refreshList();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshEvents, refreshList]
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

  /**
   * Answer a question the running turn is suspended on.
   *
   * This is the one ADR 0012 was adopted for. The turn is sitting inside a
   * `canUseTool` await on the server — not stopped, not restarted afterwards,
   * the same turn with the same context — and this settles it. The reply comes
   * back within the second, so the events are re-read immediately rather than
   * waiting for the next poll: a tap that appears to do nothing for a second
   * gets tapped again.
   *
   * `remember` stops it asking about that exact rule until the server restarts.
   */
  const answerPermission = useCallback(
    async (
      jobId: string,
      permissionId: string,
      decision: "allow" | "deny",
      remember = false
    ) => {
      try {
        const body = (await post(`/api/jobs/${encodeURIComponent(jobId)}/permission`, {
          permissionId,
          decision,
          remember,
        })) as { answered?: boolean; reason?: string };
        await refreshEvents(jobId);
        await refreshList();
        // Answered false means the question had already gone — timed out,
        // cancelled, or settled from another device. Worth saying, not worth
        // an error state.
        return body.answered === false ? (body.reason ?? "already settled") : null;
      } catch (err) {
        setError((err as Error).message);
        return (err as Error).message;
      }
    },
    [refreshEvents, refreshList]
  );

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
    providers: list?.providers ?? [],
    defaultModel: list?.defaultModel,
    deniedTools: list?.deniedTools ?? [],
    allowedTools: list?.allowedTools ?? [],
    runner: list?.runner ?? "sdk",
    runningId: list?.running ?? null,
    runningIds: list?.runningIds ?? (list?.running ? [list.running] : []),
    maxConcurrent: list?.maxConcurrent ?? 1,
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
    upload,
    cancel,
    retry,
    setModel,
    remove,
    clearAll,
    allowRule,
    answerPermission,
    refreshList,
  };
}
