// Restart an app Operator hosts, and wait until it is actually answering.
//
// ## The cost this removes
//
// One CRM session hand-rolled the same five steps roughly a dozen times: stop
// the scheduled task, kill the process it orphans, start it, poll a URL until
// it answers, tail the error log if it does not. Twice the app was left down
// for minutes because a step was missed and nobody was watching.
//
// ## Named apps, not arbitrary execution
//
// The owner's decision, 2026-08-26. This is deliberately shaped like
// `actions.mjs` rather than like a shell: an app has a fixed name and a fixed
// set of commands, and the only thing a caller may say is *which* app to
// restart. "Restart darams-crm" is then a named capability, and there is no
// input that turns it into "run this command".
//
// That is why it does not sit behind the terminal's armed gate (ADR 0011).
// Arming exists because the terminal runs anything; this runs three commands
// the owner wrote down in advance, and nothing else.
//
// ## The registry is environment-only, and that is load-bearing
//
// `OPERATOR_APPS` holds it. **Not a file, and never `operator.json`.** A worker
// has `Write` pre-allowed for the whole tree, so a registry on disk is one the
// agent can edit — it could append an app whose "start" command is anything it
// likes and then ask to restart it. That is the same reasoning that keeps
// `OPERATOR_TERMINAL_DEVICES` out of the app: a device must not be able to
// grant itself execution, and neither must a worker.
//
// The server's environment is set at the desk, by the owner, and nothing
// running inside Operator can change it.
//
// ## Format
//
//   OPERATOR_APPS=[{"name":"darams-crm",
//                   "stop":["schtasks","/end","/tn","DaramsCRM"],
//                   "start":["schtasks","/run","/tn","DaramsCRM"],
//                   "health":"https://127.0.0.1:7443/",
//                   "log":"D:\\Apps\\darams\\logs\\error.log"}]
//
// Commands are **argv arrays, never strings** — same rule as `terminal.mjs`,
// `shell: false`. A path with a space in it is an argument, not a quoting
// problem, and there is no string for an injection to hide in.
//
// ## Why "stopped" is checked and not assumed
//
// Operator's own restart taught this: `schtasks /end` returns success while the
// process it supervises keeps holding the port, so the relaunch fails to bind
// and the *old* build carries on serving with everything looking restarted.
// So the stop step waits for health to stop answering before starting anything,
// and says so plainly when it does not.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/** A single command gets this long before it is killed. */
const COMMAND_TIMEOUT_MS = 30_000;
/** How long to wait for the app to stop answering after `stop`. */
const STOP_TIMEOUT_MS = 15_000;
/** How long to wait for it to start answering after `start`. */
const START_TIMEOUT_MS = 60_000;
/** One health request. */
const HEALTH_TIMEOUT_MS = 4_000;
/** Lines of the log shown when a restart does not come good. */
const LOG_TAIL_LINES = 40;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function parseRegistry() {
  const raw = process.env.OPERATOR_APPS;
  if (!raw || !raw.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`OPERATOR_APPS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("OPERATOR_APPS must be a JSON array");

  return parsed.map((entry, i) => {
    const where = `OPERATOR_APPS[${i}]`;
    const name = String(entry?.name ?? "");
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`${where}: name must be letters, digits, dot, dash or underscore`);
    }
    const argv = (key, required) => {
      const value = entry?.[key];
      if (value === undefined || value === null) {
        if (required) throw new Error(`${where} (${name}): "${key}" is required`);
        return null;
      }
      if (!Array.isArray(value) || value.length === 0 || !value.every((a) => typeof a === "string")) {
        throw new Error(`${where} (${name}): "${key}" must be a non-empty array of strings, not a command line`);
      }
      return value;
    };
    const health = entry?.health === undefined ? null : String(entry.health);
    if (health && !/^https?:\/\//i.test(health)) {
      throw new Error(`${where} (${name}): "health" must be an http or https URL`);
    }
    /*
      `supervised: true` — something already watches this app and relaunches it.

      Learned from Darams CRM on 2026-08-30, and it is not a special case: its
      supervisor relaunches five seconds after the worker exits, which is the
      same arrangement scripts/supervise.mjs gives Operator itself. For an app
      like that, stopping the worker IS the restart, and running `start`
      afterwards races the supervisor for the port — the loser exits
      immediately, and enough rapid failures trips the supervisor's own
      give-up guard, leaving the app running old code with nothing watching it.
      Silent, and it presents as "restart failed".

      So when this is set, `start` is skipped and the app is simply expected
      back. `start` stays required in the registry: it is what recovers the app
      when the supervisor itself is not running.
    */
    const supervised = entry?.supervised === true;
    if (supervised && !health) {
      throw new Error(`${where} (${name}): "supervised" needs a "health" URL — there is no other way to know it came back`);
    }
    return {
      name,
      start: argv("start", true),
      stop: argv("stop", false),
      health,
      supervised,
      log: entry?.log ? String(entry.log) : null,
    };
  });
}

/** Every configured app, without the commands — those are not the caller's business. */
export function listApps() {
  return parseRegistry().map((app) => ({
    name: app.name,
    health: app.health,
    hasStop: Boolean(app.stop),
    hasLog: Boolean(app.log),
  }));
}

function findApp(name) {
  const apps = parseRegistry();
  const app = apps.find((a) => a.name.toLowerCase() === String(name ?? "").toLowerCase());
  if (!app) {
    const known = apps.map((a) => a.name).join(", ") || "none configured";
    throw new Error(`no app named "${name}". Configured: ${known}`);
  }
  return app;
}

/**
 * Is it answering?
 *
 * Anything under 500 counts, for the same reason `homelab.mjs` says so: a 302
 * to a login page and a 401 both mean the app is there. Demanding a 200 would
 * report every authenticated app as down.
 */
async function healthy(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "operator-app-probe" },
    });
    return { up: response.status < 500, status: response.status };
  } catch {
    return { up: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

function run(argv) {
  return new Promise((resolveRun) => {
    // argv only, no shell — see the header.
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, output: `timed out after ${COMMAND_TIMEOUT_MS}ms` });
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ ok: false, code: null, output: e.message }));
    child.on("close", (code) =>
      finish({ ok: code === 0, code, output: `${out}${err}`.trim().slice(0, 2000) }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, want, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < until) {
    last = await healthy(url);
    if (last && last.up === want) return { reached: true, ...last };
    await sleep(1000);
  }
  return { reached: false, ...(last ?? { up: !want, status: null }) };
}

async function logTail(path) {
  if (!path) return null;
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch (err) {
    return `could not read ${path}: ${err.message}`;
  }
}

/** Current state of one app, without touching it. */
export async function appStatus(name) {
  const app = findApp(name);
  const health = await healthy(app.health);
  return {
    name: app.name,
    health: app.health,
    up: health ? health.up : null,
    status: health ? health.status : null,
  };
}

/**
 * Stop it, start it, and wait until it answers.
 *
 * Returns the whole story rather than a boolean, because "it did not come back"
 * and "it never went down" need different responses from whoever asked.
 */
export async function restartApp(name) {
  const app = findApp(name);
  const steps = [];

  if (app.stop) {
    const stopped = await run(app.stop);
    steps.push({ step: "stop", ok: stopped.ok, detail: stopped.output });

    if (app.health) {
      // The step Operator's own restart exists to warn about: a stop command
      // that reports success while the process keeps holding the port.
      const gone = await waitFor(app.health, false, STOP_TIMEOUT_MS);
      steps.push({
        step: "confirm-stopped",
        ok: gone.reached,
        detail: gone.reached
          ? "stopped answering"
          : `still answering ${gone.status ?? ""} after ${STOP_TIMEOUT_MS}ms — the stop command reported success but something is still holding the port`.trim(),
      });
      if (!gone.reached) {
        return {
          name: app.name,
          ok: false,
          steps,
          log: await logTail(app.log),
          summary: `${app.name} did not stop. Starting on top of it would fail to bind and leave the old process serving, so nothing was started.`,
        };
      }
    }
  }

  if (app.supervised) {
    // Its own supervisor is bringing it back. Starting it here would race that
    // and lose the port — see the note on `supervised` above.
    steps.push({ step: "start", ok: true, detail: "skipped — supervised, waiting for its own supervisor" });
    const back = await waitFor(app.health, true, START_TIMEOUT_MS);
    steps.push({
      step: "wait",
      ok: back.reached,
      detail: back.reached ? `answering ${back.status}` : `no answer after ${START_TIMEOUT_MS}ms`,
    });
    return {
      name: app.name,
      ok: back.reached,
      steps,
      log: back.reached ? null : await logTail(app.log),
      summary: back.reached
        ? `${app.name} is back up, answering ${back.status}.`
        : `${app.name} did not come back. Its supervisor may have given up — check the log and start it by hand.`,
    };
  }

  const started = await run(app.start);
  steps.push({ step: "start", ok: started.ok, detail: started.output });

  if (!app.health) {
    steps.push({ step: "wait", ok: false, detail: "no health URL configured — cannot confirm it came up" });
    return {
      name: app.name,
      ok: started.ok,
      steps,
      log: null,
      summary: `${app.name} was started, but there is no health URL so nobody can say whether it is serving. Add "health" to its OPERATOR_APPS entry.`,
    };
  }

  const up = await waitFor(app.health, true, START_TIMEOUT_MS);
  steps.push({
    step: "wait",
    ok: up.reached,
    detail: up.reached ? `answering ${up.status}` : `no answer after ${START_TIMEOUT_MS}ms`,
  });

  return {
    name: app.name,
    ok: up.reached,
    steps,
    log: up.reached ? null : await logTail(app.log),
    summary: up.reached
      ? `${app.name} is back up, answering ${up.status}.`
      : `${app.name} was started but is not answering ${app.health}.`,
  };
}
