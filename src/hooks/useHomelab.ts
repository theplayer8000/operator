import { useCallback, useEffect, useState } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { hasOnServer, getStatus, load } from "@/lib/remoteStore";
import { seedHomelabServices } from "@/lib/seed";
import type { HomelabService, ServiceStatus } from "@/lib/types";

const KEY = "homelab.services";
const POLL_MS = 30_000;

/**
 * Every service is assumed to run on the same machine as Operator's storage
 * server, which is the whole point of the homelab page. So "localhost" in the
 * stored config means "wherever you reached Operator" — rewritten here to the
 * browser's current hostname, which is what makes a tile openable from the
 * phone over Tailscale as well as from the desk.
 *
 * A service on some *other* box gets its real host stored and is left alone.
 */
export function serviceUrl(service: HomelabService): string {
  const isLocal = service.host === "localhost" || service.host === "127.0.0.1";
  const host = isLocal ? window.location.hostname : service.host;
  const path = service.path.startsWith("/") ? service.path : `/${service.path}`;
  return `${service.protocol}://${host}:${service.port}${path}`;
}

export function useHomelab() {
  const [services, setServices] = useRemoteStorage<HomelabService[]>(KEY, seedHomelabServices);
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * The server probes the copy of this slice in *its* store, so a seed that
   * only ever lived in the browser would leave every tile unprobed. Push it
   * once, and only once we know the server genuinely doesn't have it — writing
   * on a failed load would clobber real data with seed data.
   */
  useEffect(() => {
    void load().then(() => {
      if (getStatus() === "online" && !hasOnServer(KEY)) setServices(seedHomelabServices);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/homelab/status", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`status → ${res.status}`);
      const body = (await res.json()) as { checkedAt: string; services: ServiceStatus[] };
      setStatuses(Object.fromEntries(body.services.map((s) => [s.id, s])));
      setCheckedAt(body.checkedAt);
    } catch {
      // The storage server is the thing that answers this. If it's down, the
      // app is already in its offline mode — leave the last known statuses up
      // rather than flipping every tile to "offline" on one failed request.
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, services.length]);

  function addService(input: Omit<HomelabService, "id">) {
    if (!input.name.trim()) return;
    setServices((prev) => [...prev, { ...input, id: generateId(), name: input.name.trim() }]);
  }

  function updateService(id: string, patch: Partial<HomelabService>) {
    setServices((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function deleteService(id: string) {
    setServices((prev) => prev.filter((s) => s.id !== id));
  }

  const online = services.filter((s) => statuses[s.id]?.online).length;

  return {
    services,
    statuses,
    checkedAt,
    checking,
    online,
    refresh,
    addService,
    updateService,
    deleteService,
  };
}
