// Keeps the storage server running, so it can restart itself.
//
// ## Why this exists
//
// The agent — Claude Code, via the chat or the terminal — is spawned *by* the
// storage server. That makes it a child of the thing it would need to restart,
// so it could edit `server/*.mjs` and then had no way to make the change take
// effect. From a phone that is a dead end: the code is changed, the running
// process is stale, and the only fix is a keyboard.
//
// The frontend never had this problem. `dist/` is read from disk per request,
// so `npm run build` puts a change live with no restart at all. It is only the
// server's own code that was stuck, and only because nothing outlived it.
//
// So: something has to outlive it. This is that something, and it is
// deliberately the smallest version — a parent that relaunches the child when
// it asks to be relaunched. No process manager, no config, no daemon.
//
// ## The contract
//
// Exit code 75 means "start me again". Anything else means stop, and the code
// is passed through so `npm run serve` still fails visibly when the server
// fails. 75 is EX_TEMPFAIL, which is close enough in spirit and is not a code
// Node produces by accident.
//
// ## What this is not
//
// Not a supervisor in the systemd sense, and not a crash-recovery mechanism. A
// server that dies unexpectedly stays dead, on purpose: silently resurrecting a
// process that is crash-looping turns a loud failure into a mystery. Only a
// deliberate `POST /api/restart` comes back.

import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server", "index.mjs");
const RESTART_CODE = 75;
/*
  76 is "start me again, armed" — a restart that asked for the terminal to come
  back on.

  ADR 0011 disarms the terminal on every start because arming should be a human
  act, and re-arming after each restart was becoming friction rather than a
  decision. This keeps the decision and removes the second trip: the request
  that asks for the restart is itself made by an authorised device, so a human
  did decide, once, for this restart.

  **The intent travels as an exit code, deliberately — never as a file.** A
  worker has Write across the tree, so an "arm on next boot" marker on disk
  would be one the agent could drop itself and then trigger a restart to
  collect, which is the self-granting escalation OPERATOR_TERMINAL_DEVICES is
  environment-only to prevent. Only the server process can choose its own exit
  code, and it only chooses this one for a request that already passed the
  arming check.

  It also does not persist: it arms the ONE launch that follows. The next
  ordinary restart comes back disarmed, as before.
*/
const RESTART_ARMED_CODE = 76;
let armNextStart = false;

/*
  Even a deliberate restart can loop: a bad edit to server/*.mjs that throws on
  startup, restarted by a client that keeps retrying, would spin forever and
  bury the actual error in scrollback. If restarts start arriving faster than a
  person could be asking for them, stop and say why.
*/
const LOOP_WINDOW_MS = 30_000;
const LOOP_LIMIT = 5;
const restarts = [];

const passthrough = process.argv.slice(2);
let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [SERVER, ...passthrough], {
    cwd: ROOT,
    stdio: "inherit",
    // So the server can tell the client whether a restart will actually come
    // back, rather than promising one and simply stopping.
    env: {
      ...process.env,
      OPERATOR_SUPERVISED: "1",
      // Consumed by this one launch only — cleared below the moment it is used.
      ...(armNextStart ? { OPERATOR_TERMINAL: "1" } : {}),
    },
  });
  if (armNextStart) {
    console.log("[supervisor] starting with the terminal armed, as requested");
    armNextStart = false;
  }

  child.on("exit", (code, signal) => {
    child = null;

    // Ctrl+C, or a kill from outside. Not ours to second-guess.
    if (stopping || signal) {
      process.exit(signal ? 1 : (code ?? 0));
      return;
    }

    if (code !== RESTART_CODE && code !== RESTART_ARMED_CODE) {
      process.exit(code ?? 0);
      return;
    }
    armNextStart = code === RESTART_ARMED_CODE;

    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > LOOP_WINDOW_MS) restarts.shift();
    if (restarts.length >= LOOP_LIMIT) {
      console.error(
        `[supervisor] ${restarts.length} restarts in ${LOOP_WINDOW_MS / 1000}s — stopping.\n` +
          `[supervisor] The server is most likely failing on startup. Read the error above;\n` +
          `[supervisor] it is the real one. Fix server/, then start again.`
      );
      process.exit(1);
      return;
    }

    console.log("[supervisor] restarting the server…");
    start();
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    // Let the child handle it too, so it can close its listener cleanly rather
    // than leaving the port in TIME_WAIT and failing the next bind.
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

console.log("[supervisor] managing the storage server — POST /api/restart to reload it");
start();
