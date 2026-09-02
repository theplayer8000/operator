// Who is calling the storage API.
//
// Until v19 there was no authentication anywhere, and OPS-018 accepted that on
// the stated grounds that "the tailnet is the security boundary". That premise
// was false: the server binds 0.0.0.0, Windows Firewall allows inbound Node on
// Private networks, and `curl http://<lan-ip>:5174/api/state` returned the whole
// store. Anything on the owner's LAN could read his shifts and notes and browse
// the repo through /api/dev/*. Now that Operator is used from a phone full-time
// and an embedded terminal is planned, that had to close.
//
// Three ways to be authenticated, checked in this order:
//
//   1. local     — the request came from this machine and not through a proxy
//   2. tailscale — the caller is a device on the owner's tailnet, confirmed by
//                  asking the local tailscale daemon who owns that address
//   3. token     — a bearer token matching OPERATOR_TOKEN
//
// Anything else is refused. There is deliberately no "allow any source" escape
// hatch: a caller from outside the tailnet is welcome, but it has to bring the
// token.
//
// ## The Vite proxy is why this is subtler than it looks
//
// In dev, the phone loads the app from Vite on :5173 and Vite proxies /api to
// http://localhost:5174. So **the API sees the proxy, not the phone** — every
// request arrives from loopback with the phone's real address only in
// X-Forwarded-For. A plain "trust loopback" rule would therefore authenticate
// the entire internet-facing dev server as if it were sat at the keyboard.
//
// So loopback is split in two:
//
//   - loopback with no X-Forwarded-For  → genuinely this machine. Trusted.
//   - loopback *with* X-Forwarded-For   → the Vite proxy. Identify the
//                                         forwarded address instead, and hold
//                                         it to the same rules as any peer.
//
// Trusting that header from loopback adds no exposure: anything already running
// on this machine could just call the API from loopback with no header at all
// and be trusted anyway. It is only trusted from loopback — a LAN peer setting
// its own X-Forwarded-For is ignored, which is the attack this ordering exists
// to stop.
//
// ## Read the RIGHTMOST forwarded address, never the leftmost
//
// `xfwd` **appends** to whatever X-Forwarded-For the client already sent, so a
// spoofed header survives into the chain:
//
//     client sends:  X-Forwarded-For: 100.64.25.75      (a lie)
//     Vite appends:  X-Forwarded-For: 100.64.25.75, 192.168.1.100
//                                     ^ attacker's       ^ what Vite actually saw
//
// Reading the leftmost entry authenticated a LAN peer as the owner's iPhone —
// verified against a live server before this was fixed. The rightmost entry is
// the one the trusted proxy observed, so that is the only one worth reading.
//
// **This assumes exactly one trusted hop** (Vite, on loopback). Putting a second
// proxy in front — nginx or Caddy terminating TLS for a real domain, which is
// where this is heading — makes the rightmost entry *that proxy's* view of its
// upstream rather than the real client, and this needs revisiting with an
// explicit trusted-hop count.
//
// `npm run serve` has no proxy — the app and API share one port, so the peer
// address *is* the phone and tailscale identity works directly. That is the
// better posture when away from the machine, and the faster path anyway.

import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

const TOKEN = process.env.OPERATOR_TOKEN ?? "";

/** `tailscale` resolves on PATH here; the install path is the fallback. */
const TAILSCALE_BIN =
  process.env.OPERATOR_TAILSCALE_BIN ?? "tailscale";

const WHOIS_TIMEOUT_MS = 3_000;
/** Devices don't change owner often; don't spawn a subprocess per request. */
const WHOIS_TTL_MS = 5 * 60_000;
/** Failures expire faster, so a daemon restart recovers without a bounce. */
const WHOIS_MISS_TTL_MS = 20_000;

const whoisCache = new Map(); // ip → { at, value|null }

/** Strip IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and any zone suffix. */
function normaliseIp(raw) {
  if (!raw) return "";
  let ip = String(raw).trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip.toLowerCase();
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

/**
 * Tailscale's CGNAT range is 100.64.0.0/10 — second octet 64–127 inclusive.
 * `100.128.x` and `100.63.x` are ordinary public addresses and must not match.
 * IPv6 tailnet addresses live under fd7a:115c:a1e0::/48.
 */
function isTailnet(ip) {
  if (ip.startsWith("fd7a:115c:a1e0")) return true;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Ask the local tailscale daemon who owns an address. Local call only — no
 * network egress, so this is not an external dependency in the CLAUDE.md sense.
 * Returns `{ device, user }`, or null if the address isn't a known peer.
 */
async function whois(ip) {
  const hit = whoisCache.get(ip);
  if (hit) {
    const ttl = hit.value ? WHOIS_TTL_MS : WHOIS_MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  let value = null;
  /*
    Whether the daemon actually answered — which is NOT the same as whether the
    answer was yes, and conflating them locked the owner out of his own app.

    Measured 2026-08-30: 57 refusals of `tosin-pc`, a device sitting in
    `tailscale status`, all reading "not a known peer of this tailnet". The
    cause was here. Every failure — a genuine "unknown peer", a 3s timeout, a
    busy daemon — was caught alike and cached alike, so ONE slow lookup was
    remembered as a definite no for the whole miss TTL. The app polls
    /api/jobs and /api/homelab/status continuously, so the entire window was
    refused, which is why the refusals arrived in bursts on exactly those two
    routes.

    "The daemon says this is not a peer" is an answer and worth caching.
    "I could not reach the daemon" is not an answer at all, and caching it as
    one turns a transient hiccup into a lockout that outlives it.

    So a failure to *ask* is never cached: the next request tries again. A
    thundering herd is the acceptable cost — the alternative is refusing a
    legitimate device for twenty seconds because the daemon was busy once.
  */
  let answered = true;
  try {
    const { stdout } = await run(TAILSCALE_BIN, ["whois", "--json", ip], {
      timeout: WHOIS_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout);
    // Node.Name is the full "host.tailnet.ts.net"; the leading label is enough.
    const name = parsed?.Node?.Name ?? "";
    const device = name.split(".")[0] || null;
    const user = parsed?.UserProfile?.LoginName ?? null;
    if (device) value = { device, user };
  } catch (err) {
    value = null;
    // Killed by the timeout, or the binary is missing/unrunnable. Either way
    // the daemon never gave a verdict. A numeric `code` means tailscale ran and
    // exited non-zero, which IS a verdict: that address is not a peer.
    const timedOut = err?.killed === true || Boolean(err?.signal);
    const couldNotRun = typeof err?.code === "string"; // ENOENT, EACCES, …
    if (timedOut || couldNotRun) {
      answered = false;
      console.warn(
        `[operator] could not ask tailscaled about ${ip} (${timedOut ? `timed out after ${WHOIS_TIMEOUT_MS}ms` : err.code}) — ` +
          `not caching; the next request will retry`,
      );
    }
  }

  if (answered) whoisCache.set(ip, { at: Date.now(), value });
  return value;
}

/** Constant-time compare that tolerates differing lengths. */
function tokenMatches(supplied) {
  if (!TOKEN || !supplied) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(TOKEN).digest();
  return timingSafeEqual(a, b);
}

function bearerFrom(req) {
  const header = req.headers["authorization"];
  if (typeof header === "string" && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, "").trim();
  }
  // Header only — deliberately no `?token=` query fallback. A token in a URL
  // ends up in server logs, browser history, and any Referer sent onward, and
  // the client that needs it (a future login screen) can set a header anyway.
  return "";
}

/**
 * The address the immediately-upstream proxy actually observed — the rightmost
 * entry in the chain. See the header note: the leftmost entry is client-supplied
 * and spoofable.
 */
function forwardedClient(req) {
  const raw = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(raw) ? raw.join(",") : String(raw ?? ""))
    .split(",")
    .map((part) => normaliseIp(part))
    .filter((part) => part !== "");
  return chain.length > 0 ? chain[chain.length - 1] : "";
}

/**
 * Identify the caller.
 *
 * Always resolves — never throws — so a broken tailscale install degrades to
 * "token required" rather than locking the owner out of his own data.
 */
/*
  What to call the machine Operator runs on.

  It read "this machine" for every loopback caller, which is true and useless
  on the Dev page: three rows all saying "this machine" is a list that has
  stopped distinguishing anything, and the owner asked for his PC by name.

  Defaults to the real hostname rather than a friendly guess — inventing
  "Tosin's PC" from `TOSIN-PC` is the kind of cleverness that gets it wrong on
  the next machine. `OPERATOR_DEVICE_NAME` sets whatever he prefers.

  Environment-only, like every other name that identifies a device here. A
  label an app can rewrite is a label that can be made to lie about who is
  calling, and this one sits next to the tailnet device names in the same list.
*/
const LOCAL_DEVICE =
  (process.env.OPERATOR_DEVICE_NAME ?? "").trim() || hostname() || "this machine";

export async function identify(req) {
  const peer = normaliseIp(req.socket?.remoteAddress);
  const forwarded = forwardedClient(req);
  const token = bearerFrom(req);

  // X-Forwarded-For is only meaningful from the proxy we run ourselves. From
  // any other peer it is attacker-controlled noise and is ignored entirely.
  const viaProxy = isLoopback(peer) && forwarded !== "";

  // 1. Genuinely this machine, no proxy in between.
  if (isLoopback(peer) && !viaProxy) {
    return { ok: true, method: "local", device: LOCAL_DEVICE, peer };
  }

  // The address we actually judge: what the proxy saw, otherwise the peer.
  const client = viaProxy ? forwarded : peer;

  // Loopback behind the proxy is the owner at the keyboard hitting
  // localhost:5173. Trustworthy *because* this value came from the proxy rather
  // than from the request — the rightmost-entry rule above is what makes that
  // true, and reading the leftmost entry instead would make it a bypass.
  if (viaProxy && isLoopback(client)) {
    return { ok: true, method: "local", device: LOCAL_DEVICE, peer, client };
  }

  // 2. A device on the owner's tailnet, confirmed by the local daemon.
  if (isTailnet(client)) {
    const who = await whois(client);
    if (who) {
      return {
        ok: true,
        method: "tailscale",
        device: who.device,
        user: who.user,
        peer,
        client,
      };
    }
    if (tokenMatches(token)) {
      return { ok: true, method: "token", device: "token", peer, client };
    }
    return {
      ok: false,
      reason: `tailnet address ${client} is not a known peer of this tailnet`,
      peer,
      client,
    };
  }

  // 3. Anything else — LAN, or the public internet once this is on a domain —
  //    must bring the token.
  if (tokenMatches(token)) {
    return { ok: true, method: "token", device: "token", peer, client };
  }

  return {
    ok: false,
    reason: TOKEN
      ? "not on the tailnet and no valid token"
      : "not on the tailnet, and no OPERATOR_TOKEN is configured to fall back to",
    peer,
    client,
  };
}

/** Whether a token is configured at all — surfaced by /api/auth/whoami. */
export function tokenConfigured() {
  return TOKEN.length > 0;
}

/**
 * The address a request should be *attributed* to — the same value `identify()`
 * judges, minus the judging.
 *
 * `clients.mjs` used `req.socket.remoteAddress` directly, so every device coming
 * through the Vite proxy was logged as `127.0.0.1`. On the Dev page's connected
 * clients list that showed the owner's iPhone as loopback, which is actively
 * misleading for a panel whose whole job is answering "which device is this?".
 * Same rightmost-entry, trusted-from-loopback-only rule as above — see the
 * header for why the leftmost entry must never be used.
 */
export function resolveClientAddress(req) {
  const peer = normaliseIp(req.socket?.remoteAddress);
  if (!isLoopback(peer)) return peer;
  const forwarded = forwardedClient(req);
  return forwarded === "" ? peer : forwarded;
}
