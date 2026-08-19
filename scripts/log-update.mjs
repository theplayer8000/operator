// Log a change to the Updates changelog, from a terminal.
//
//   node scripts/log-update.mjs "What shipped" "Any detail" [--pending]
//
// Exists because `CLAUDE.md` requires every change to appear on the Updates
// page, and a rule with no mechanism is a rule that gets skipped. This is the
// mechanism: one command, no dependencies, works from a session or by hand.
//
// **Through the API, not into the file.** `data/operator.json` is held in the
// server's memory while it runs, so writing to it directly is overwritten by
// the next save. `scripts/backup.mjs` deliberately avoids the API — that is so
// a backup still works when everything is down, which does not apply here:
// there is nothing to log if nothing is running.
//
// Loopback is an authenticated caller (ADR 0010), so no token is needed on the
// machine itself. Set OPERATOR_TOKEN to run it from elsewhere.

const BASE = process.env.OPERATOR_URL ?? "http://127.0.0.1:5174";
const KEY = "updates.entries";

const args = process.argv.slice(2);
const pending = args.includes("--pending");
const [title, detail = ""] = args.filter((a) => a !== "--pending");

if (!title) {
  console.error('usage: node scripts/log-update.mjs "title" ["detail"] [--pending]');
  process.exit(2);
}

const headers = {
  "content-type": "application/json",
  ...(process.env.OPERATOR_TOKEN ? { authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } : {}),
};

/**
 * Read-modify-write, because the API stores a slice whole.
 *
 * Two writers racing would lose an entry. That is accepted rather than solved:
 * this is one person logging their own work, seconds apart at worst, and a
 * lock or an append route would be more machinery than the risk deserves.
 */
async function main() {
  const res = await fetch(`${BASE}/api/state`, { headers });
  if (!res.ok) throw new Error(`couldn't read the store — ${res.status} ${res.statusText}`);
  const store = await res.json();
  const entries = Array.isArray(store.state?.[KEY]) ? store.state[KEY] : [];

  const now = new Date();
  const dateKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-"); // local time, same as lib/time.ts — never toISOString (OPS-009)

  const entry = {
    // Matches lib/id.ts: safe without crypto.randomUUID, which is unavailable
    // over plain HTTP at a tailnet IP.
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    title,
    detail,
    status: pending ? "pending" : "done",
    ...(pending ? {} : { date: dateKey }),
  };

  const put = await fetch(`${BASE}/api/state/${encodeURIComponent(KEY)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value: [entry, ...entries] }),
  });
  if (!put.ok) throw new Error(`couldn't write — ${put.status} ${put.statusText}`);

  console.log(`logged ${pending ? "to the queue" : "as shipped"}: ${title}`);
}

main().catch((err) => {
  console.error(`log-update failed: ${err.message}`);
  console.error("Is the server running? npm run serve");
  process.exit(1);
});
