// The half of a full restart that has to outlive the server.
//
// ## Why this exists
//
// `POST /api/restart` exits with code 75 and `scripts/supervise.mjs` starts the
// child again. That reloads CODE and nothing else: the supervisor survives, and
// it hands the child the environment IT was started with. So a key set with
// `secret_set` — which writes the registry — is invisible until something
// starts the supervisor itself again. That has caught the owner out repeatedly,
// most recently with `AIROUTER_API_KEY` and the VAPID keys.
//
// A full restart therefore means: both processes stop, and the LAUNCHER
// (`scripts/operator-serve.ps1`, via Task Scheduler) starts them, because that
// is the only thing that re-reads the registry.
//
// Nothing inside the server can do the second half — it is gone by then. Hence
// a detached process that outlives it.
//
// ## The order matters, which is why this is one script and not two
//
// The owner's instinct was two shells, one down and one up. Two would race: the
// starter can win, bind the port, and then the stopper kills the thing it just
// started. This waits for the port to go quiet before starting anything.
//
// ## It does not kill anything unless it has to
//
// The server exits 0 on its own after saving; the supervisor treats any code
// but 75 as "stop", so it exits too. Both are gone without a signal. Killing is
// the FALLBACK for a server that will not go, and it is deliberately last —
// a forced kill is exactly the abandoned-mid-turn state the graceful path
// exists to avoid.
//
// No dependencies. Node built-ins only.

import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/*
  Its OWN file, not serve.log.

  Writing into the server's log seemed tidy and lost two of the three lines
  that matter: the server appends to that file at the same moment, the launcher
  may rotate it mid-restart, and the whole point of these lines is to be
  readable AFTER a restart went wrong. A trace reliably present in a small file
  beats one usually present in a big one.
*/
const LOG = join(ROOT, "data", "restart.log");

const PORT = Number(process.env.OPERATOR_PORT || 5174);
const TASK = process.env.OPERATOR_TASK_NAME || "OperatorServe";
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;

/** How long the server gets to save and go, before it is stopped by force. */
const GRACE_MS = Number(process.argv[2] || 20_000);
/** How long the launcher gets to bring it back before this gives up saying so. */
const UP_MS = 90_000;

async function say(line) {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(line);
  await appendFile(LOG, `[restart] ${stamp} ${line}\n`, "utf8").catch((err) => {
    // Swallowed once, and it cost an hour: two lines went missing and there
    // was no way to tell whether they were never written or written elsewhere.
    // A logger that hides its own failure is the wrong shape for a file whose
    // only job is to explain one.
    console.error(`[restart] could not write ${LOG}: ${err?.message ?? err}`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is anything listening? The only honest test that the old server has gone. */
function portOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ port: PORT, host: "127.0.0.1" });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function stillRunning() {
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        // Matched on the command line rather than the name: several unrelated
        // node processes are usually running, and killing one of those would
        // be a much worse outcome than a slow restart.
        "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('supervise.mjs') -or $_.CommandLine.Contains('index.mjs')) } | Select-Object -ExpandProperty ProcessId) -join ','",
      ],
      { timeout: 20_000 },
    );
    return String(stdout).trim().split(",").filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  await say(`asked for a full restart — giving the server ${GRACE_MS / 1000}s to save and exit`);

  // --- wait for it to go on its own ---------------------------------------
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!(await portOpen()) && (await stillRunning()).length === 0) break;
    await sleep(500);
  }

  const stragglers = await stillRunning();
  if (stragglers.length) {
    /*
      It did not go. Say so loudly, because a forced stop can lose a turn that
      was mid-flight and that is worth knowing about afterwards rather than
      wondering.
    */
    await say(`server did not exit within the grace period — forcing ${stragglers.join(", ")}`);
    await run("taskkill.exe", ["/F", ...stragglers.flatMap((pid) => ["/PID", pid])], {
      timeout: 20_000,
    }).catch(() => {});
    await sleep(2000);
  } else {
    await say("server exited cleanly");
  }

  // --- start it through the LAUNCHER, which is the whole point -------------
  try {
    await run("schtasks.exe", ["/Run", "/TN", TASK], { timeout: 30_000 });
    await say(`started scheduled task ${TASK}`);
  } catch (err) {
    await say(`FAILED to start ${TASK}: ${err?.message ?? err}. Start it by hand.`);
    process.exit(1);
  }

  // --- confirm, rather than assume ----------------------------------------
  const upBy = Date.now() + UP_MS;
  while (Date.now() < upBy) {
    try {
      const res = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        await say(`back up after ${Math.round((UP_MS - (upBy - Date.now())) / 1000)}s`);
        process.exit(0);
      }
    } catch {
      // Not yet. The loop is the wait.
    }
    await sleep(2000);
  }

  await say(`did NOT come back within ${UP_MS / 1000}s — run: schtasks /Run /TN ${TASK}`);
  process.exit(1);
}

main().catch(async (err) => {
  await say(`restart helper crashed: ${err?.message ?? err}`);
  process.exit(1);
});
