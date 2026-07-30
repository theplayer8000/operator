// Who's actually connected.
//
// HTTP is stateless, so "connected" is a judgement rather than a fact: this
// tracks every request's source and treats a client as active if it has been
// seen recently. That is enough to answer the question that actually matters
// when something breaks — "is my phone even reaching the server?" — which
// previously could only be guessed at.
//

import { resolveClientAddress } from "./auth.mjs";
// Everything here is in memory and dies with the process. It is deliberately
// not persisted: it's a live diagnostic, not history, and writing device
// fingerprints into the store would be a privacy cost with no upside on a
// single-user app.

/** A client is "active" if seen within this window. */
const ACTIVE_MS = 2 * 60 * 1000;
/** Forget a client entirely after this long, so the map can't grow forever. */
const FORGET_MS = 60 * 60 * 1000;
/** Hard cap, in case something pathological starts rotating user agents. */
const MAX_CLIENTS = 50;

/** key → { ip, userAgent, label, firstSeen, lastSeen, requests, lastPath } */
const clients = new Map();

/**
 * Turn a user-agent string into something readable at a glance. Deliberately
 * crude — the goal is "iPhone · Safari" not exact version reporting, and a
 * wrong guess here costs nothing because the raw string is kept alongside.
 */
function describe(userAgent) {
  if (!userAgent) return "Unknown";

  if (/\bcurl\//i.test(userAgent)) return "curl";
  if (/node|undici/i.test(userAgent)) return "Node";

  let device = "Desktop";
  if (/iPhone/i.test(userAgent)) device = "iPhone";
  else if (/iPad/i.test(userAgent)) device = "iPad";
  else if (/Android/i.test(userAgent)) device = "Android";
  else if (/Macintosh/i.test(userAgent)) device = "Mac";
  else if (/Windows/i.test(userAgent)) device = "Windows";
  else if (/Linux/i.test(userAgent)) device = "Linux";

  let browser = "Browser";
  // Order matters: Edge and Chrome both claim Safari, Chrome claims Safari.
  if (/Edg\//i.test(userAgent)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(userAgent)) browser = "Opera";
  else if (/Firefox\//i.test(userAgent)) browser = "Firefox";
  else if (/CriOS\//i.test(userAgent)) browser = "Chrome";
  else if (/Chrome\//i.test(userAgent)) browser = "Chrome";
  else if (/Safari\//i.test(userAgent)) browser = "Safari";

  return `${device} · ${browser}`;
}

export function recordRequest(req) {
  /*
    Attribute to the address auth judges, not the socket peer.

    This used to read `req.socket.remoteAddress`, which meant every device
    arriving through the Vite proxy was recorded as 127.0.0.1 — the owner's
    iPhone showed up as loopback on the very panel built to answer "which device
    is this?". `resolveClientAddress` applies the same trusted-from-loopback,
    rightmost-entry rule as the auth check, so the two always agree.
  */
  const ip = resolveClientAddress(req) || "unknown";
  const userAgent = req.headers["user-agent"] ?? "";
  const key = `${ip}|${userAgent}`;
  const now = Date.now();

  const existing = clients.get(key);
  if (existing) {
    existing.lastSeen = now;
    existing.requests += 1;
    existing.lastPath = req.url ?? "";
  } else {
    clients.set(key, {
      ip,
      userAgent,
      label: describe(userAgent),
      firstSeen: now,
      lastSeen: now,
      requests: 1,
      lastPath: req.url ?? "",
    });
  }

  // Prune on write rather than on a timer — no interval to leak, and the map
  // only grows when something is actually talking to us.
  for (const [k, c] of clients) {
    if (now - c.lastSeen > FORGET_MS) clients.delete(k);
  }
  if (clients.size > MAX_CLIENTS) {
    const oldest = [...clients.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [k] of oldest.slice(0, clients.size - MAX_CLIENTS)) clients.delete(k);
  }
}

export function listClients() {
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    activeWindowMs: ACTIVE_MS,
    clients: [...clients.values()]
      .map((c) => ({
        ip: c.ip,
        label: c.label,
        userAgent: c.userAgent,
        requests: c.requests,
        lastPath: c.lastPath,
        firstSeen: new Date(c.firstSeen).toISOString(),
        lastSeen: new Date(c.lastSeen).toISOString(),
        secondsAgo: Math.round((now - c.lastSeen) / 1000),
        active: now - c.lastSeen <= ACTIVE_MS,
      }))
      .sort((a, b) => a.secondsAgo - b.secondsAgo),
  };
}
