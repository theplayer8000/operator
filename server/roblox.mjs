// Roblox Open Cloud, through the owner's stored API key.
//
// ## Why this module exists
//
// Every other outbound call in this server goes through a fixed endpoint with
// a fixed purpose — Runway makes videos, websearch asks a search provider.
// Roblox is different: the owner wants to *toy with the API*, which means one
// action that can reach any Open Cloud endpoint, not one endpoint per
// question. So this is a deliberate passthrough — with three walls:
//
//   1. The host is fixed at apis.roblox.com and the path must start with
//      /cloud/ — which is exactly where every Open Cloud REST endpoint lives.
//      The stored key can never be aimed at a different host through this
//      action, no matter what a caller asks for.
//   2. The key is attached HERE, server-side, as the `x-api-key` header, and
//      a caller cannot set or override headers. A worker asking the action
//      for a URL therefore cannot learn the key, only what it is allowed to
//      do with it.
//   3. Method is one of GET/POST/PATCH/PUT/DELETE. The mutating verbs are
//      allowed on purpose: the owner ticked every scope when he created the
//      key, and half the point of holding it here is being able to PATCH a
//      user or write a datastore key from a worker turn without a cookie.
//
// The boundary is Roblox-only by design. This is NOT a generic "give me any
// URL" HTTP gateway — if that is wanted later (an approved-hosts model, like
// the one already sketched around Brave Search), it should be a separate
// action with its own approval conversation, not a wider door here.
//
// ## The honest caveat
//
// The `x-api-key` header and the base host come from the Open Cloud docs
// (https://create.roblox.com/docs/cloud) rather than from a call that
// succeeded — the key had not even loaded when this was written. The errors
// quote whatever Roblox itself says, so a wrong shape is diagnosable rather
// than a generic failure. First real call after the restart is the test.
//
// No dependencies.

const env = (name) => (process.env[name] ?? "").replace(/^\uFEFF/, "").trim();

const API_KEY = env("OPEN_CLOUD_API_KEY");
const BASE_URL = env("OPEN_CLOUD_BASE_URL") || "https://apis.roblox.com";

export const configured = Boolean(API_KEY);

const TIMEOUT_MS = 30_000;
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

export class RobloxError extends Error {}

function requireKey() {
  if (!API_KEY) {
    throw new RobloxError(
      "OPEN_CLOUD_API_KEY is not set — Roblox calls are unavailable until the key is stored (secret_set) and Operator has restarted.",
    );
  }
}

/**
 * One Open Cloud call. `path` is everything after the host, e.g.
 * /cloud/v2/users/{userId} — it must start with /cloud/ and may carry a
 * query string. `body` is a JSON object, sent only for the mutating verbs.
 */
export async function call({ path, method = "GET", body } = {}) {
  const p = String(path ?? "").trim();
  if (!p) throw new RobloxError('path is required — an apis.roblox.com path like /cloud/v2/users/{userId}');
  if (!p.startsWith("/cloud/")) {
    throw new RobloxError(
      `refused: path must start with /cloud/ on apis.roblox.com (got "${p}"). The key is scoped to the Open Cloud REST surface on purpose.`,
    );
  }
  if (p.includes("..")) {
    throw new RobloxError('refused: path must not contain ".."');
  }
  const m = String(method ?? "GET").toUpperCase();
  if (!METHODS.has(m)) {
    throw new RobloxError(`method must be one of: ${[...METHODS].join(", ")}`);
  }

  requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${p}`, {
      method: m,
      headers: {
        "x-api-key": API_KEY,
        "content-type": "application/json",
      },
      ...(m !== "GET" && body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Left null; the error below quotes the raw text, which is more useful
      // than "unexpected token" when a proxy or a docs page came back.
    }
    const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    const detail = errors.map((e) => e?.message ?? e?.code).filter(Boolean).join("; ") || String(text).slice(0, 200);

    if (res.status === 401 || res.status === 403) {
      throw new RobloxError(
        `Roblox refused the key (${res.status}) for ${p}. The stored OPEN_CLOUD_API_KEY or its scopes may not cover this endpoint — scopes are ticked per key at create.roblox.com/dashboard/credentials. Roblox says: ${detail}`,
      );
    }
    if (res.status === 404) {
      throw new RobloxError(
        `Roblox returned 404 for ${p} — the endpoint or an id in the path is wrong. Check create.roblox.com/docs/cloud for the current shape rather than guessing. Roblox says: ${detail}`,
      );
    }
    if (res.status === 429) {
      throw new RobloxError("Roblox rate-limited the request (429) — wait a moment and retry.");
    }
    if (!res.ok) {
      throw new RobloxError(`Roblox returned ${res.status} for ${p}: ${detail}`);
    }
    return { status: res.status, data: parsed };
  } catch (err) {
    if (err instanceof RobloxError) throw err;
    throw new RobloxError(
      controller.signal.aborted
        ? `Roblox did not answer within ${TIMEOUT_MS / 1000}s — try again, and check the endpoint rather than repeating the same call`
        : `could not reach Roblox: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
