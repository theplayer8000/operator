// Operator storage server.
//
// A single-user JSON store over HTTP. No dependencies, no auth, no database —
// it exists so Operator's data lives in a file on disk (and later on the NAS)
// instead of being trapped in one browser profile. See docs/decisions/0006.
//
//   GET  /api/state          → { schemaVersion, updatedAt, state }
//   PUT  /api/state/<key>    → body is { "value": <the slice> } — an ENVELOPE,
//                              not the bare value. The handler reads
//                              `body?.value ?? null`, so a bare array or object
//                              silently stores **null** and wipes the slice.
//                              This comment used to say "the raw value", which
//                              is how that mistake gets made.
//   PUT  /api/state          → body is a whole { key: value } map (import/migrate),
//                              bare — no envelope. Yes, the two differ.
//   GET  /api/health         → { ok: true }
//
// In production it also serves the built app from dist/.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import { listTree, readTextFile, repoMeta } from "./dev.mjs";
import { checkServices } from "./homelab.mjs";
import { recordRequest, listClients } from "./clients.mjs";
import { claudeStatus } from "./status.mjs";
import { identify, tokenConfigured } from "./auth.mjs";
import {
  readOutput,
  isEnabled,
  setEnabled,
  deviceMayManage,
  deviceAuthorised,
  describeRun,
  getRun,
  listRuns,
  startRun,
  stopRun,
  subscribe,
} from "./terminal.mjs";
import * as chat from "./workspace.mjs";
import { runBackup } from "../scripts/backup.mjs";
import { buildStatus } from "./build.mjs";

const gzip = promisify(gzipCb);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OPERATOR_PORT ?? 5174);
const HOST = process.env.OPERATOR_HOST ?? "0.0.0.0";

// Point this at a NAS mount when the server moves to the EPYC box.
const DATA_FILE = process.env.OPERATOR_DATA ?? join(ROOT, "data", "operator.json");
const DIST_DIR = join(ROOT, "dist");
const SERVE_DIST =
  process.env.OPERATOR_SERVE_DIST === "1" || process.argv.includes("--serve-dist");

const SCHEMA_VERSION = 3;

// --- store ----------------------------------------------------------------

/** Shape on disk: { schemaVersion, updatedAt, state: { "<key>": <value> } } */
function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, state: {} };
}

/**
 * Migrations run oldest-first on load. Each entry takes the store at version
 * N and returns it at version N+1. Add one whenever a persisted shape changes
 * — this is the piece localStorage never had (OPS-003).
 */
/** Default wall-clock starts for the fixed routine sections, used by v1 → v2. */
const DEFAULT_SECTION_START = {
  morning: "06:30",
  work: "09:00",
  gym: "17:30",
  learning: "19:30",
  forex: "20:30",
  evening: "21:30",
  sleep: "23:00",
};

const MIGRATIONS = [
  // Index N takes the store from version N to N+1.

  // 0 → 1: nothing. Version 1 was the first shipped shape; stores written
  // before versioning existed are already in it.
  null,

  // 1 → 2: RoutineSection gained `startTime`. A store written before this has
  // sections with no start, which would render as "--:--" on the new timeline.
  // Backfill from the same defaults the seed uses, keyed by section — the set
  // of sections is fixed, so this is exact rather than a guess.
  (store) => {
    const sections = store.state?.["routine.sections"];
    if (!Array.isArray(sections)) return store;

    store.state["routine.sections"] = sections.map((section) =>
      section && typeof section === "object" && typeof section.startTime !== "string"
        ? { ...section, startTime: DEFAULT_SECTION_START[section.key] ?? "09:00" }
        : section
    );
    return store;
  },

  // 2 → 3: routine completions move from a `done` flag on each task to
  // `routine.completions`, keyed by local date — the shape gym.completions
  // already uses. Before this, a nightly reset flipped `done` back for every
  // repeating step, so completion was never history, only current state.
  //
  // Anything already ticked is credited to *today* rather than thrown away.
  // That is a guess about when it happened, but it is the only date the old
  // shape supports and it is right far more often than it is wrong: the reset
  // means a `done: true` can only have been set since the last local midnight.
  //
  // `done` is deliberately left as-is on the task. It stays the truth for
  // one-off (non-repeating) steps, and for repeating ones it is simply no
  // longer read — additive only, per docs/data-model.md.
  (store) => {
    const sections = store.state?.["routine.sections"];
    if (!Array.isArray(sections)) return store;

    const ticked = [];
    for (const section of sections) {
      if (!section || !Array.isArray(section.tasks)) continue;
      for (const task of section.tasks) {
        if (task && task.done === true && task.repeatDaily !== false) ticked.push(task.id);
      }
    }
    if (ticked.length === 0) return store;

    // Local date parts, never toISOString() — that is UTC and would file an
    // evening's ticks under tomorrow (OPS-009).
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

    const existing = store.state["routine.completions"];
    const completions = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
    completions[today] = [...new Set([...(completions[today] ?? []), ...ticked])];
    store.state["routine.completions"] = completions;
    return store;
  },
];

function migrate(store) {
  let current = store.schemaVersion ?? 0;
  while (current < SCHEMA_VERSION) {
    const step = MIGRATIONS[current];
    if (typeof step === "function") store = step(store);
    current += 1;
    store.schemaVersion = current;
  }
  return store;
}

let cache = null;

async function load() {
  if (cache) return cache;
  if (!existsSync(DATA_FILE)) {
    cache = emptyStore();
    return cache;
  }
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = migrate({ ...emptyStore(), ...parsed });
  } catch (err) {
    // Never destroy a file we couldn't parse — surface it and refuse to write.
    console.error(`[operator] cannot read ${DATA_FILE}:`, err.message);
    throw new Error("data file is unreadable; refusing to overwrite it");
  }
  return cache;
}

/** Write via temp file + rename so a crash mid-write can't truncate the store. */
async function persist() {
  cache.updatedAt = new Date().toISOString();
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

// --- http helpers ---------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw.length === 0 ? null : JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Text formats worth compressing. Images and woff2 are already compressed. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);

async function serveStatic(req, res, pathname) {
  // Anything that isn't a real file falls through to index.html — the app is
  // a client-side router, so /missions/<id> must not 404 on a hard refresh.
  let filePath = join(DIST_DIR, pathname);
  if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath) || extname(filePath) === "") {
    filePath = join(DIST_DIR, "index.html");
  }
  if (!existsSync(filePath)) {
    return json(res, 404, { error: "not built — run `npm run build` first" });
  }

  const ext = extname(filePath);
  const body = await readFile(filePath);
  const headers = { "content-type": MIME[ext] ?? "application/octet-stream" };

  // Cache policy, which is what makes the *second* load fast:
  //
  // Vite gives everything in /assets a content-hashed filename, so a given URL
  // can never change meaning — safe to cache for a year. index.html must never
  // be cached, or the browser would keep loading an old build's asset URLs and
  // no deploy would ever reach the phone.
  if (pathname.startsWith("/assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["cache-control"] = "no-cache";
  }

  // The JS bundle is ~720 KB raw and ~200 KB gzipped. Serving it uncompressed
  // was sending 3.6x more data than necessary, which over 4G on a phone is
  // most of the wait. Node has zlib built in, so this costs no dependency —
  // and the app is the one thing this server exists to deliver.
  const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  if (wantsGzip && COMPRESSIBLE.has(ext)) {
    const compressed = await gzip(body);
    res.writeHead(200, { ...headers, "content-encoding": "gzip", vary: "Accept-Encoding" });
    return res.end(compressed);
  }

  res.writeHead(200, headers);
  res.end(body);
}

// --- routes ---------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  // Record every request except the polling endpoint that reads this back —
  // otherwise the Dev page watching for clients would keep itself permanently
  // "active" and be the loudest thing on the list.
  if (pathname !== "/api/clients") recordRequest(req);

  try {
    /*
      Authentication gate — everything under /api/ (v19).

      Static assets are deliberately *not* gated: the browser has to be able to
      load the app before it can present a token, and the bundle carries no
      data. Every route that reads or writes the store, browses the repo, or
      probes the network sits behind this.

      /api/auth/whoami is answered either way — 200 with the identity, or 401
      with the reason — because it is how a client discovers whether it needs a
      token at all.
    */
    let identity = null;
    if (pathname.startsWith("/api/")) {
      const who = await identify(req);
      identity = who;

      if (pathname === "/api/auth/whoami") {
        return json(res, who.ok ? 200 : 401, {
          ...who,
          tokenConfigured: tokenConfigured(),
        });
      }

      if (!who.ok) {
        // Log denials — on a tailnet this should be rare enough that any entry
        // is worth reading, and it is the only record of something on the LAN
        // reaching for the store.
        console.warn(
          `[operator] refused ${req.method} ${pathname} from ${who.client ?? who.peer}: ${who.reason}`
        );
        return json(res, 401, {
          error: "not authorised",
          reason: who.reason,
          hint: "Operator answers to devices on the owner's tailnet, or to a request carrying OPERATOR_TOKEN as a bearer token.",
        });
      }
    }

    // --- terminal (ADR 0011) ---
    //
    // Authentication above got the caller this far; `deviceAuthorised` is the
    // separate question of whether *this device* may execute anything. Being a
    // known tailnet device gets you the app, not a shell.

    if (pathname === "/api/terminal/runs") {
      const manage = deviceMayManage(identity);
      const allowed = deviceAuthorised(identity);
      return json(res, 200, {
        ...listRuns(),
        authorised: allowed.ok,
        // Whether this device may arm/disarm — the client shows the switch on
        // this, not on `authorised`, or the switch would vanish when disarmed.
        canManage: manage.ok,
        ...(allowed.ok ? {} : { reason: allowed.reason }),
        you: { device: identity?.device ?? null, method: identity?.method ?? null },
      });
    }

    // --- chat with Claude Code ---
    //
    // Same gate as the terminal on purpose: `claude -p` has tool access, so this
    // is arbitrary execution by another route, not "only chat".

    if (pathname === "/api/chat") {
      const allowed = deviceAuthorised(identity);
      return json(res, 200, {
        ...(allowed.ok
          ? chat.state(Number(url.searchParams.get("since") ?? 0))
          : { messages: [], busy: false }),
        authorised: allowed.ok,
        canManage: deviceMayManage(identity).ok,
        ...(allowed.ok ? {} : { reason: allowed.reason }),
      });
    }

    if (pathname === "/api/chat/send" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const body = await readBody(req);
      try {
        // Deliberately not awaited: a reply can take a minute, well past any
        // sensible HTTP timeout on a phone. The client polls /api/chat.
        const started = chat.send(body?.text, identity);
        started.catch((err) => console.error("[operator] chat turn failed:", err.message));
        return json(res, 202, { accepted: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/chat/model" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) return json(res, 403, { error: "not authorised", reason: allowed.reason });
      const body = await readBody(req);
      return json(res, 200, { model: chat.setModel(body?.model) });
    }

    if (pathname === "/api/chat/allow" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) return json(res, 403, { error: "not authorised", reason: allowed.reason });
      const body = await readBody(req);
      try {
        return json(res, 200, await chat.allowRule(body?.rule, identity));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/chat/new" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(res, 403, { error: "not authorised", reason: allowed.reason });
      }
      return json(res, 200, chat.reset(identity));
    }

    // Arming is a separate permission from running: a listed device may switch
    // the terminal on, but the list itself only comes from the environment.
    if (pathname === "/api/terminal/enable" && req.method === "POST") {
      const manage = deviceMayManage(identity);
      if (!manage.ok) {
        console.warn(
          `[operator] terminal arm refused for ${identity?.device ?? identity?.client}: ${manage.reason}`
        );
        return json(res, 403, { error: "not authorised to arm the terminal", reason: manage.reason });
      }
      const body = await readBody(req);
      const next = body?.enabled === true;
      return json(res, 200, { enabled: setEnabled(next, identity) });
    }

    /*
      Restart the server, so it can pick up changes to its own code.

      This is what makes "Operator works on itself" true rather than half-true.
      Frontend edits already go live with `npm run build`, because dist/ is read
      from disk per request — but the agent is spawned *by* this process, so it
      could edit server/*.mjs and never make the change take effect. Nothing it
      could do from a phone would help; the process had to outlive itself.

      Exit code 75 is the signal to scripts/supervise.mjs to start a fresh one.
      Without the supervisor this is still honest: the process exits, the server
      stops, and you are told that is what will happen.

      Gated on `deviceMayManage` — the same list that may arm the terminal. A
      device that can already run arbitrary commands can obviously restart a
      process; what this must not become is something any authenticated tailnet
      device can do, since bouncing the server is a denial of service to every
      other device using it.

      The response is written and flushed *before* exiting. Exiting first would
      look identical to a crash from the client's side, and the difference
      between "restarting" and "died" is the whole message.
    */
    if (pathname === "/api/build") {
      return json(res, 200, await buildStatus(ROOT));
    }

    if (pathname === "/api/restart" && req.method === "POST") {
      const manage = deviceMayManage(identity);
      if (!manage.ok) {
        console.warn(
          `[operator] restart refused for ${identity?.device ?? identity?.client}: ${manage.reason}`
        );
        return json(res, 403, { error: "not authorised to restart", reason: manage.reason });
      }
      const supervised = process.env.OPERATOR_SUPERVISED === "1";
      console.log(
        `[operator] restart requested by ${identity?.device ?? "local"}` +
          (supervised ? "" : " — NOT supervised, this will stop the server")
      );
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ restarting: true, supervised }), () => {
        // Give the socket a moment to drain before the process goes away.
        setTimeout(() => process.exit(75), 150);
      });
      return;
    }

    if (pathname === "/api/terminal/run" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        console.warn(
          `[operator] terminal refused for ${identity?.device ?? identity?.client}: ${allowed.reason}`
        );
        return json(res, 403, { error: "not authorised to run commands", reason: allowed.reason });
      }
      const body = await readBody(req);
      const line = typeof body?.command === "string" ? body.command.trim() : "";
      if (!line) return json(res, 400, { error: "expected { command: string }" });
      try {
        const run = await startRun(line, identity);
        return json(res, 200, describeRun(run));
      } catch (err) {
        // A rejected command is a user-facing message, not a server fault.
        return json(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/terminal/stop" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const result = stopRun(url.searchParams.get("id") ?? "");
      return json(res, result.ok ? 200 : 400, result);
    }

    if (pathname === "/api/terminal/output") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const run = getRun(url.searchParams.get("id") ?? "");
      if (!run) return json(res, 404, { error: "no such run" });
      return json(res, 200, readOutput(run, Number(url.searchParams.get("from") ?? 0)));
    }

    if (pathname === "/api/terminal/stream") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const run = getRun(url.searchParams.get("id") ?? "");
      if (!run) return json(res, 404, { error: "no such run" });

      /*
        Plain chunked text, not SSE.

        The client reads this with `response.body.getReader()`, which — unlike
        EventSource — can carry an Authorization header, so the same code path
        works once this is behind a token on a real domain. Output already
        produced is replayed first, so refreshing the page or coming back after
        the phone locks does not lose the log: a stream with no replay is the
        thing that makes a mobile console frustrating.
      */
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.write(run.text);

      if (run.proc === null) {
        res.end();
        return;
      }

      const unsubscribe = subscribe(run, (chunk) => {
        if (chunk === null) res.end();
        else res.write(chunk);
      });
      req.on("close", unsubscribe);
      return;
    }

    if (pathname === "/api/clients") {
      return json(res, 200, listClients());
    }

    // Owner-approved outbound call — see server/status.mjs for why it's here
    // and not in the browser.
    if (pathname === "/api/claude-status") {
      return json(res, 200, await claudeStatus());
    }

    if (pathname === "/api/health") {
      return json(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, dataFile: DATA_FILE });
    }

    if (pathname === "/api/state" && req.method === "GET") {
      const store = await load();
      return json(res, 200, store);
    }

    // Bulk write — used once by the client to migrate existing localStorage
    // data up to the server, and later by Settings > Import.
    if (pathname === "/api/state" && req.method === "PUT") {
      const body = await readBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "expected an object of { key: value }" });
      }
      await load();
      cache.state = { ...cache.state, ...body };
      await persist();
      return json(res, 200, { ok: true, keys: Object.keys(body).length });
    }

    if (pathname.startsWith("/api/state/") && req.method === "PUT") {
      const key = decodeURIComponent(pathname.slice("/api/state/".length));
      if (!key) return json(res, 400, { error: "missing key" });
      const body = await readBody(req);
      await load();
      cache.state[key] = body?.value ?? null;
      await persist();
      return json(res, 200, { ok: true, key });
    }

    // --- Homelab status (probes only what the store already lists) ---

    if (pathname === "/api/homelab/status" && req.method === "GET") {
      const store = await load();
      return json(res, 200, await checkServices(store.state["homelab.services"]));
    }

    // --- Dev browser (read-only, sandboxed to the repo — see dev.mjs) ---

    if (pathname === "/api/dev/meta") {
      return json(res, 200, await repoMeta(ROOT));
    }

    if (pathname === "/api/dev/tree") {
      const tree = await listTree(ROOT, url.searchParams.get("path") ?? ".");
      if (!tree) return json(res, 400, { error: "path not allowed" });
      return json(res, 200, tree);
    }

    if (pathname === "/api/dev/file") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "missing path" });
      const file = await readTextFile(ROOT, rel);
      return json(res, file.error ? 400 : 200, file);
    }

    // Drop a single slice back to its seed. Settings > Reset will use this.
    if (pathname.startsWith("/api/state/") && req.method === "DELETE") {
      const key = decodeURIComponent(pathname.slice("/api/state/".length));
      await load();
      delete cache.state[key];
      await persist();
      return json(res, 200, { ok: true, key });
    }

    if (pathname.startsWith("/api/")) {
      return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
    }

    if (SERVE_DIST) return await serveStatic(req, res, pathname);
    return json(res, 404, { error: "API only — the dev server serves the app" });
  } catch (err) {
    console.error("[operator]", err);
    return json(res, 500, { error: err.message });
  }
});

// --- scheduled backups ---------------------------------------------------
//
// The owner chose "run it through the server" over registering an OS task
// (2026-07-30). That keeps the schedule with the app rather than with this
// machine, so moving to the EPYC box carries it along instead of leaving a
// `schtasks` entry behind on a PC that no longer holds the data.
//
// `scripts/backup.mjs` stays standalone and dependency-free — the import goes
// one way only (server → script, never the reverse), so `npm run backup` still
// works with the server down. That matters: a server-driven timer cannot back
// up a server that isn't running, which is exactly when you'd want a copy.
//
// Unchanged stores are skipped inside runBackup(), so a quiet hour costs one
// file read and no restore point.
const BACKUP_EVERY_MS = Math.max(
  60_000,
  Number(process.env.OPERATOR_BACKUP_INTERVAL_MS ?? 60 * 60_000) || 60 * 60_000
);

async function scheduledBackup(reason) {
  try {
    const result = await runBackup();
    if (result.status === "written") {
      console.log(
        `[operator] backup (${reason}): ${result.name} — ${result.kept} restore point(s)`
      );
    } else if (result.status !== "skipped") {
      // Refusals are the interesting case: the store is unreadable or empty and
      // the existing restore points were deliberately left alone.
      console.error(`[operator] backup (${reason}) ${result.status}: ${result.reason}`);
    }
  } catch (err) {
    // A failing backup must never take the storage server down with it.
    console.error(`[operator] backup (${reason}) threw: ${err.message}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[operator] storage server on http://localhost:${PORT}`);
  console.log(`[operator] data file: ${DATA_FILE}`);
  if (SERVE_DIST) console.log(`[operator] serving app from ${DIST_DIR}`);

  // One on boot — a restart is usually either a deploy or a crash, and both are
  // moments you want a copy from. Then on the interval.
  void scheduledBackup("startup");
  const timer = setInterval(
    () => void scheduledBackup("scheduled"),
    BACKUP_EVERY_MS
  );
  // Don't hold the event loop open on shutdown.
  timer.unref();
  console.log(
    `[operator] backups every ${Math.round(BACKUP_EVERY_MS / 60000)} min (unchanged stores skipped)`
  );
});
