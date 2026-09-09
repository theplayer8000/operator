import { useCallback, useEffect, useRef, useState } from "react";

export interface RunSummary {
  id: string;
  command: string;
  device: string;
  user: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  truncated: boolean;
}

export interface RunsBody {
  enabled: boolean;
  authorised?: boolean;
  canManage?: boolean;
  reason?: string;
  allowed?: string[];
  authorisedDevices?: string[];
  runs: RunSummary[];
  cwd?: string;
  you?: { device: string | null; method: string | null };
}

/**
 * Run a command on the machine, from Operator — the state and calls behind
 * `server/terminal.mjs`, factored out of `components/dev/TerminalPanel.tsx`
 * so the Sandbox Terminal quadrant (`components/dashboard/SandboxTerminal.tsx`)
 * can be the SAME capability in a much smaller space, not a second terminal
 * with its own copy of the arm/disarm dance to drift out of sync.
 *
 * Each caller gets its OWN instance — no shared/global state, matching how
 * `useJobs()` already works everywhere else in this app (ADR 0005 stands: no
 * Redux/Zustand). The Dev page's full panel and the map's compact quadrant
 * can be open at once without fighting over one `activeId`; both read the
 * same server-side run history through `/api/terminal/*`, which is where any
 * actual sharing already lives.
 *
 * There is no shell behind this — pipes and `&&` are literal text, not
 * operators, unless the command explicitly asks for one (`bash -c "…"`).
 */
export function useTerminal() {
  const [info, setInfo] = useState<RunsBody | null>(null);
  const [command, setCommand] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal/runs", { headers: { accept: "application/json" } });
      if (res.status === 401) {
        setError("This device isn't authorised. Open Operator on the Tailscale address.");
        return;
      }
      setInfo((await res.json()) as RunsBody);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Read a run's output by polling, not streaming.
   *
   * The first version used `fetch` + `response.body.getReader()`. It worked on
   * the desktop and failed on the owner's iPhone: `git status --short` ran and
   * exited 0, but no text ever arrived. A terminal whose output silently never
   * appears is worse than no terminal, and the phone is the primary client — so
   * this polls `/api/terminal/output?from=` and appends what is new.
   *
   * Polling is also what makes re-opening an old run work, and what survives the
   * phone locking mid-run: the server holds the whole buffer, so the next poll
   * catches up rather than losing the gap.
   */
  const attach = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setActiveId(id);
      setOutput("");
      setStreaming(true);
      setError(null);

      let offset = 0;
      try {
        for (;;) {
          if (controller.signal.aborted) return;
          const res = await fetch(`/api/terminal/output?id=${encodeURIComponent(id)}&from=${offset}`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
            throw new Error(body.reason ?? body.error ?? `server returned ${res.status}`);
          }
          const body = (await res.json()) as { output: string; offset: number; running: boolean };
          if (body.output) setOutput((prev) => prev + body.output);
          offset = body.offset;
          if (!body.running) break;
          await new Promise((r) => setTimeout(r, 600));
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      } finally {
        setStreaming(false);
        void refresh();
      }
    },
    [refresh],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run() {
    const line = command.trim();
    if (!line) return;
    setError(null);

    // `disarm` is handled here rather than being sent anywhere. Locking up
    // should be the fastest thing on the page — one word into the box you are
    // already typing in, rather than scrolling back to find a button. There is
    // deliberately no `arm` counterpart: arming is the direction that grants
    // execution, and it should stay a deliberate press rather than something
    // you can fire from muscle memory or a pasted line.
    if (/^(disarm|lock)$/i.test(line)) {
      setCommand("");
      await setArmed(false);
      return;
    }

    // `clear` is a real program, and running it does exactly what it is meant
    // to: emit the escape codes that tell a terminal to wipe itself. A `<pre>`
    // prints them instead. Handled here because what the command means —
    // empty the output — is something only the client can do.
    if (/^(clear|cls)$/i.test(line)) {
      setCommand("");
      abortRef.current?.abort();
      setActiveId(null);
      setOutput("");
      return;
    }
    try {
      const res = await fetch("/api/terminal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: line }),
      });
      const body = (await res.json()) as { id?: string; error?: string; reason?: string };
      if (!res.ok || !body.id) {
        setError(body.reason ?? body.error ?? `server returned ${res.status}`);
        return;
      }
      void attach(body.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Arm or disarm from the app.
   *
   * This exists because requiring an environment variable set *at the machine*
   * to enable the feature built for being *away* from it was self-defeating. The
   * device list still comes from the environment, so this switches on a
   * capability the device already has — it cannot grant itself one.
   */
  async function setArmed(next: boolean) {
    setError(null);
    try {
      const res = await fetch("/api/terminal/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = (await res.json()) as { enabled?: boolean; error?: string; reason?: string };
      if (!res.ok) {
        setError(body.reason ?? body.error ?? `server returned ${res.status}`);
        return;
      }
      if (!next) {
        abortRef.current?.abort();
        setActiveId(null);
        setOutput("");
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Restart the storage server, so it picks up changes to its own code.
   *
   * Deliberately optimistic about the failure: the connection dying *is* the
   * expected outcome, so a fetch error here means it worked. What matters is
   * telling the two apart afterwards, which the poll below does by waiting for
   * the server to answer again rather than assuming it will.
   */
  async function restartServer() {
    setError(null);
    setRestarting(true);
    try {
      await fetch("/api/restart", { method: "POST" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch("/api/health", { cache: "no-store" });
          if (res.ok) {
            setRestarting(false);
            await refresh();
            return;
          }
        } catch {
          /* still down — expected */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      setRestarting(false);
      setError("Restarted, but it hasn't come back. It may not be supervised — check the machine.");
    } catch (err) {
      setRestarting(false);
      setError((err as Error).message);
    }
  }

  async function stop() {
    if (!activeId) return;
    await fetch(`/api/terminal/stop?id=${encodeURIComponent(activeId)}`, { method: "POST" }).catch(() => {});
  }

  const canManage = info?.canManage === true;
  const armed = info?.enabled === true;
  // Listed but not armed is the normal resting state, not an error.
  const notListed = info !== null && !canManage;

  return {
    info,
    command,
    setCommand,
    activeId,
    output,
    streaming,
    error,
    restarting,
    canManage,
    armed,
    notListed,
    refresh,
    attach,
    run,
    setArmed,
    restartServer,
    stop,
  };
}
