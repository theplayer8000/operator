// Claude service status, read from Anthropic's public Statuspage.
//
// This is the one outbound call Operator makes to a host the owner doesn't
// control, and it exists because the owner explicitly approved it (see the
// "External applications" rule in CLAUDE.md). Anything else wanting to reach
// the internet needs the same approval first — don't add a second one here on
// the assumption that this file being here makes it fine.
//
// It is fetched **server-side** on purpose. The browser talking to
// status.claude.com directly would put the owner's phone in front of a
// third-party host on every page view, leak its IP and user-agent there, and
// break anyway when the page is loaded over plain HTTP at a tailnet IP
// (mixed-content). Going through this server means exactly one machine —
// the owner's own — ever contacts them.

const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const PAGE_URL = "https://status.claude.com";

/** Statuspage is a status page; hammering it adds nothing. One call a minute. */
const TTL_MS = 60_000;
const TIMEOUT_MS = 6_000;

/** Cap the list so an incident-heavy day can't return an unbounded payload. */
const MAX_COMPONENTS = 14;
const MAX_INCIDENTS = 5;

let cached = null; // { at: number, body: object }

/**
 * Statuspage's component list includes group headers (`group: true`) whose
 * status is just a roll-up of their children, and components flagged
 * `showcase: false` that the page itself doesn't display. Neither is worth a
 * row here.
 */
function usefulComponents(components) {
  if (!Array.isArray(components)) return [];
  return components
    .filter((c) => c && typeof c === "object" && !c.group)
    .slice(0, MAX_COMPONENTS)
    .map((c) => ({
      name: String(c.name ?? "Unknown"),
      status: String(c.status ?? "unknown"),
    }));
}

function usefulIncidents(incidents) {
  if (!Array.isArray(incidents)) return [];
  return incidents.slice(0, MAX_INCIDENTS).map((i) => ({
    name: String(i.name ?? "Incident"),
    status: String(i.status ?? "unknown"),
    impact: String(i.impact ?? "none"),
    shortlink: typeof i.shortlink === "string" ? i.shortlink : PAGE_URL,
    updatedAt: i.updated_at ?? i.created_at ?? null,
  }));
}

/**
 * Current status, cached. Never throws — a failed fetch resolves to
 * `{ ok: false, error }` so the UI can say "couldn't reach it" rather than the
 * whole Dev page erroring on an outage of the very thing it's reporting on.
 */
export async function claudeStatus() {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ...cached.body, cached: true };
  }

  try {
    const res = await fetch(SUMMARY_URL, {
      headers: { accept: "application/json", "user-agent": "operator-dashboard" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status.claude.com returned ${res.status}`);

    const summary = await res.json();
    const body = {
      ok: true,
      indicator: String(summary?.status?.indicator ?? "unknown"),
      description: String(summary?.status?.description ?? "Unknown"),
      components: usefulComponents(summary?.components),
      incidents: usefulIncidents(summary?.incidents),
      pageUrl: PAGE_URL,
      fetchedAt: new Date().toISOString(),
    };
    cached = { at: Date.now(), body };
    return body;
  } catch (err) {
    // Serve stale over nothing: a minute-old "all operational" is more useful
    // than a blank card, as long as the age is stated.
    if (cached) return { ...cached.body, cached: true, stale: true, error: err.message };
    return { ok: false, error: err.message, pageUrl: PAGE_URL, fetchedAt: new Date().toISOString() };
  }
}
