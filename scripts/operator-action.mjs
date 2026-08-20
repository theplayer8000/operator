// Run one capability action against Operator's own data, from a terminal.
//
//   node scripts/operator-action.mjs list
//   node scripts/operator-action.mjs gym_toggle_exercise '{"exerciseId":"bench"}'
//   node scripts/operator-action.mjs mission_set_status '{"id":"...","status":"complete"}'
//
// This is how an AI worker changes the calendar, the Mission Board, the gym log
// or the routine **without editing source code** — it produces an intent, the
// capability layer (server/actions.mjs) knows how to execute it.
//
// ## Why a CLI rather than a native SDK tool
//
// The Agent SDK's `tool()` helper builds its schemas with zod, which is not a
// declared dependency here — it exists in node_modules only as something the
// SDK itself pulled in, so relying on it would break the first time npm
// reshuffled, and declaring it needs an ADR (CLAUDE.md's stack rule).
//
// A CLI has a better property anyway: it is worker-agnostic. Claude, Gemini,
// Codex and anything with shell access call it exactly the same way, which is
// the whole point of the capability layer — the same tool surface for every
// worker, not one integration per model. `scripts/log-update.mjs` established
// this pattern and is already pre-allowed in `ALLOWED_TOOLS`.
//
// Loopback is an authenticated caller (ADR 0010), so no token is needed on the
// machine itself. Set OPERATOR_TOKEN to run it from elsewhere.

const BASE = process.env.OPERATOR_URL ?? "http://127.0.0.1:5174";

const [name, rawParams] = process.argv.slice(2);

const headers = {
  "content-type": "application/json",
  ...(process.env.OPERATOR_TOKEN ? { authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } : {}),
};

async function main() {
  if (!name || name === "list" || name === "--list") {
    const res = await fetch(`${BASE}/api/actions`, { headers });
    if (!res.ok) throw new Error(`couldn't list actions — ${res.status} ${res.statusText}`);
    const { actions } = await res.json();
    for (const action of actions) {
      console.log(`${action.name}\n  ${action.description}\n  params: ${action.params}\n`);
    }
    return;
  }

  let params = {};
  if (rawParams) {
    try {
      params = JSON.parse(rawParams);
    } catch {
      throw new Error(`params must be valid JSON — got: ${rawParams}`);
    }
  }

  const res = await fetch(`${BASE}/api/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: name, params }),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // The server's own reason, not the status code — a 400 here means the
    // action said exactly what was wrong with the call, and repeating that
    // verbatim is what lets a worker correct itself on the next turn.
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  console.log(JSON.stringify(body.result, null, 2));
}

main().catch((err) => {
  console.error(`action failed: ${err.message}`);
  console.error("Is the server running, and the terminal armed? npm run serve");
  process.exit(1);
});
