// Reachability probes for the Homelab tile grid.
//
// Why this lives on the server and not in the browser:
//
//   The services are running on the same box as this process. The browser is
//   often not — it is a phone on the tailnet. A client-side fetch to
//   "localhost:5000" would probe the *phone*, and always report offline. The
//   server is the only place that can honestly answer "is that port up".
//   CORS would also block reading the response of a cross-origin probe.
//
// The probe list is read from the store's "homelab.services" slice, never from
// the request. That keeps this endpoint from becoming a general-purpose port
// scanner for anything that can reach the tailnet — a caller can ask "are my
// configured services up", not "is <arbitrary host:port> open".
//
// A TCP connect is the whole test: it answers "something is listening", which
// is the honest signal for a tile. It does not mean the app inside is healthy.

import { connect } from "node:net";

const TIMEOUT_MS = 1500;
/** Probes are cheap but not free, and tiles poll. Collapse bursts. */
const CACHE_MS = 5_000;

let cached = { at: 0, key: "", results: [] };

function probe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = connect({ host, port });

    function done(online) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ online, latencyMs: online ? Date.now() - started : null });
    }

    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function usable(service) {
  return (
    service &&
    typeof service.id === "string" &&
    typeof service.host === "string" &&
    service.host.length > 0 &&
    Number.isInteger(service.port) &&
    service.port > 0 &&
    service.port < 65536
  );
}

/**
 * @param {Array} services the stored homelab.services slice
 * @returns {Promise<{checkedAt: string, services: Array}>}
 */
export async function checkServices(services) {
  const list = Array.isArray(services) ? services.filter(usable) : [];

  // Cache on the exact set being probed, so editing a tile re-probes at once
  // rather than showing the previous set's answer for another five seconds.
  const key = list.map((s) => `${s.id}@${s.host}:${s.port}`).join("|");
  if (cached.key === key && Date.now() - cached.at < CACHE_MS) {
    return { checkedAt: new Date(cached.at).toISOString(), services: cached.results };
  }

  const results = await Promise.all(
    list.map(async (s) => ({ id: s.id, ...(await probe(s.host, s.port)) }))
  );

  cached = { at: Date.now(), key, results };
  return { checkedAt: new Date(cached.at).toISOString(), services: results };
}
