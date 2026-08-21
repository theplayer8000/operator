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
// A TCP connect used to be the whole test. It is not enough, and 2026-08-21
// is why: the Darams CRM tile sat green while the site had been down for days.
// Its port 7443 belongs to *tailscaled*, which accepts the connection and then
// proxies to a backend that had exited — so every real request got a 502 while
// the probe saw a perfectly good handshake. A tile that is green when the app
// is dead is worse than no tile, because it is consulted and believed.
//
// So: any service with an http/https protocol gets an actual request, and the
// status code decides. Anything else — a database, a bare port — still gets
// the TCP connect, which remains the honest test for something that does not
// speak HTTP.
//
// What counts as up: anything under 500. A 302 to /login and a 401 both mean
// the app is there and answering; demanding a 200 would report every
// authenticated service as down. 5xx is the case this exists to catch.

import { connect } from "node:net";

const TIMEOUT_MS = 1500;
/** HTTP costs a round trip and a handshake, so it gets longer than a connect. */
const HTTP_TIMEOUT_MS = 4000;
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

/**
 * Ask the service itself, rather than asking whoever holds the port.
 *
 * `redirect: "manual"` on purpose — a redirect to a login page is a healthy
 * answer, and following it would spend a second round trip to learn nothing.
 */
async function probeHttp(service) {
  const started = Date.now();
  const path = service.path && service.path.startsWith("/") ? service.path : "/";
  const url = `${service.protocol}://${service.host}:${service.port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "operator-homelab-probe" },
    });
    return {
      online: response.status < 500,
      status: response.status,
      latencyMs: Date.now() - started,
    };
  } catch {
    // DNS failure, refused connection, TLS error, timeout — all "not up".
    return { online: false, status: null, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

function speaksHttp(service) {
  return service.protocol === "http" || service.protocol === "https";
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
  // Protocol and path are part of the key: switching a tile from a TCP check
  // to an HTTP one changes what "online" means, so it must not serve the old
  // answer.
  const key = list
    .map((s) => `${s.id}@${s.protocol ?? "tcp"}://${s.host}:${s.port}${s.path ?? ""}`)
    .join("|");
  if (cached.key === key && Date.now() - cached.at < CACHE_MS) {
    return { checkedAt: new Date(cached.at).toISOString(), services: cached.results };
  }

  const results = await Promise.all(
    list.map(async (s) => ({
      id: s.id,
      ...(speaksHttp(s) ? await probeHttp(s) : await probe(s.host, s.port)),
    }))
  );

  cached = { at: Date.now(), key, results };
  return { checkedAt: new Date(cached.at).toISOString(), services: results };
}
