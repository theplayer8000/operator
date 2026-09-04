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
//   GET  /api/health         → { ok: true }. The cheap one, polled constantly —
//                              it also carries the store's `updatedAt`. Leave
//                              it cheap; the checks live one level down.
//   GET  /api/health/checks  → the verification pass (server/health.mjs)
//
// In production it also serves the built app from dist/.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import { listTree, readTextFile, repoMeta } from "./dev.mjs";
import { checkServices } from "./homelab.mjs";
import { recordRequest, noteIdentity, listClients } from "./clients.mjs";
import { claudeStatus } from "./status.mjs";
import { identify, tokenConfigured } from "./auth.mjs";
import {
  readOutput,
  isEnabled,
  setEnabled,
  deviceMayManage,
  deviceAuthorised,
  deviceMayUseCapabilities,
  describeRun,
  getRun,
  listRuns,
  startRun,
  stopRun,
  subscribe,
} from "./terminal.mjs";
import * as jobs from "./jobs.mjs";
import { resourceLimit, stageUpload } from "./uploads.mjs";
import { runBackup } from "../scripts/backup.mjs";
import { buildStatus } from "./build.mjs";
import { health, noteApiRequest } from "./health.mjs";
import {
  DATA_FILE,
  SCHEMA_VERSION,
  load,
  setState,
  mergeState,
  deleteState,
} from "./store.mjs";
import { runAction, listActions, ActionError } from "./actions.mjs";
import { listLogs, tailLog } from "./logs.mjs";
/*
  Web Push replaced ntfy on 2026-09-01. `notify.mjs` keeps the same interface,
  so nothing else in server/ changed — only who carries the message.
*/
import { configured as pushConfigured, publicKey as vapidPublicKey } from "./push.mjs";
import { add as addSubscription, remove as removeSubscription } from "./subscriptions.mjs";
import { initProviders } from "./providers.mjs";
import {
  startListening,
  stopListening,
  state as listenState,
  transcribeUpload,
} from "./listen.mjs";

/** The clap handler, held so the detector can be restarted after a stop. */
let clapCallback = null;
import { matchIntent } from "./intent.mjs";
import { runIntent } from "./intentrun.mjs";
import { matchVoiceCommand, VOICE_ARM_MS } from "./voicecommand.mjs";

import {
  synthesize,
  available as ttsAvailable,
  state as ttsState,
  warm as warmVoice,
} from "./tts.mjs";

const gzip = promisify(gzipCb);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OPERATOR_PORT ?? 5174);
const HOST = process.env.OPERATOR_HOST ?? "0.0.0.0";

const DIST_DIR = join(ROOT, "dist");
const SERVE_DIST =
  process.env.OPERATOR_SERVE_DIST === "1" || process.argv.includes("--serve-dist");

// --- store ------------------------------------------------------------------
//
// DATA_FILE, SCHEMA_VERSION, load/persist and the migrations all moved to
// store.mjs, so actions.mjs (the AI-callable capability layer) can read and
// write the same in-memory cache this file does. See that file's header.

// --- http helpers ---------------------------------------------------------

/*
  Compress API responses, not just static files.

  `serveStatic` has gzipped the bundle since the phone was slow to load it —
  "over 4G that is most of the wait" — and every JSON response went out raw the
  whole time. That was fine while the store was small. It stopped being fine
  when the Knowledge Vault arrived: `knowledge.notes` is now 78% of the store
  and `/api/state` ships **627 KB on every poll**, which gzips to 189 KB.

  The server itself is not slow — it answers in 7ms. The wait was the wire, and
  the owner felt it as "why is Operator being so slow" with pages not loading.

  Only above a threshold. Gzipping a 50-byte `{"ok":true}` costs a compression
  pass to make the payload bigger, and the health check runs constantly.
*/
const COMPRESS_OVER = 1400;

async function json(req, res, status, body) {
  const payload = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };

  const wantsGzip = /\bgzip\b/.test(req?.headers?.["accept-encoding"] ?? "");
  if (wantsGzip && Buffer.byteLength(payload) > COMPRESS_OVER) {
    try {
      const compressed = await gzip(payload);
      res.writeHead(status, {
        ...headers,
        "content-encoding": "gzip",
        "content-length": compressed.length,
        vary: "Accept-Encoding",
      });
      return res.end(compressed);
    } catch {
      // Compression failing must never fail the response. Fall through and
      // send it raw, which is exactly what happened before this existed.
    }
  }

  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(payload) });
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
    return json(req, res, 404, { error: "not built — run `npm run build` first" });
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

  /*
    How long this request took, for /api/health/checks.

    A `finish` listener rather than a wrapper around `json()`, because there are
    forty-odd `return json(...)` sites plus the static path and the streams, and
    a wrapper would measure whichever ones someone remembered. This fires once
    the response is off the socket, so nothing here is on the request path — the
    work is a subtraction and an array push into a fixed-length ring.
  */
  if (pathname.startsWith("/api/")) {
    const began = performance.now();
    res.on("finish", () => noteApiRequest(pathname, performance.now() - began, res.statusCode));
  }

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
      // The client monitor records the request before this point, because it
      // must count refused attempts too. This is where it learns the name.
      noteIdentity(req, who);

      if (pathname === "/api/auth/whoami") {
        return json(req, res, who.ok ? 200 : 401, {
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
        return json(req, res, 401, {
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
      return json(req, res, 200, {
        ...listRuns(),
        authorised: allowed.ok,
        // Whether this device may arm/disarm — the client shows the switch on
        // this, not on `authorised`, or the switch would vanish when disarmed.
        canManage: manage.ok,
        ...(allowed.ok ? {} : { reason: allowed.reason }),
        you: { device: identity?.device ?? null, method: identity?.method ?? null },
      });
    }

    // --- jobs: working with Claude Code ---
    //
    // Same gate as the terminal on purpose: `claude -p` has tool access, so this
    // is arbitrary execution by another route, not "only chat".
    //
    // A job outlives the request that made it (docs/ai-workspace-design.md), so
    // every handler here returns immediately and the client polls. Nothing waits
    // on Claude inside an HTTP request — that shape is what imposed the old
    // 10-minute cap in the first place.

    if (pathname === "/api/jobs") {
      const allowed = deviceAuthorised(identity);
      if (req.method === "POST") {
        /*
          Talking to Operator does not require an armed terminal. Reaching a
          worker that can run commands does.

          Gating all job creation on the terminal made him arm it just to ask a
          question — and bought nothing, because Gemini and the local model have
          `tools: "capability-actions"` and can therefore do exactly what an
          unarmed caller could already do by calling an action directly. Only
          `claude-code` has full tool access, and starting one of those genuinely
          IS execution.

          So the tier is decided by the WORKER rather than by the fact that it is
          a job. An unarmed but authenticated caller may start a conversation;
          `create()` then routes within the workers he can actually reach and
          says so plainly if he asked for one he cannot.
        */
        const mayUse = deviceMayUseCapabilities(identity);
        if (!mayUse.ok) {
          return json(req, res, 403, { error: "not authorised", reason: mayUse.reason });
        }
        const body = await readBody(req);
        try {
          return json(
            req,
            res,
            202,
            await jobs.create(
              body?.prompt,
              body?.model,
              identity,
              body?.resources,
              body?.provider,
              body?.taskKind,
              { executionAllowed: allowed.ok }
            )
          );
        } catch (err) {
          // 409 rather than 400 when another device holds the runner: it isn't a
          // bad request, it's a busy one, and the client shows it differently.
          const busy = /busy on/.test(err.message);
          return json(req, res, busy ? 409 : 400, { error: err.message });
        }
      }
      /*
        The tab strip. Summaries only — no events, because this is polled and a
        long build's log runs to thousands of entries.

        READABLE WITHOUT THE TERMINAL ARMED. Reading what Operator is doing is
        not execution, and hiding it produced exactly the complaint that named
        this fix: "its doing stuff but now idk what its doing". He could start
        work unarmed and then not see it — the display went blank at the moment
        it mattered most.

        `authorised` still reports whether he may reach an execution worker, so
        the UI can say what he cannot do rather than pretending he can do
        nothing.
      */
      const mayRead = deviceMayUseCapabilities(identity);
      return json(req, res, 200, {
        ...(mayRead.ok ? jobs.list() : { jobs: [], running: null }),
        authorised: allowed.ok,
        canManage: deviceMayManage(identity).ok,
        you: identity?.device ?? null,
        ...(allowed.ok ? {} : { reason: allowed.reason }),
      });
    }

    if (pathname === "/api/jobs/allow" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      const body = await readBody(req);
      try {
        return json(req, res, 200, await jobs.allowRule(body?.rule, identity));
      } catch (err) {
        return json(req, res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/jobs/clear" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      return json(req, res, 200, jobs.clear(identity));
    }

    // Raw local files are staged before a first job exists, then claimed by
    // jobs.create()/input(). This remains behind the same device gate as chat.
    if (pathname === "/api/jobs/resources" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      try {
        return json(req, res, 201, { resource: await stageUpload(req), maxBytes: resourceLimit() });
      } catch (err) {
        return json(req, res, 400, { error: err.message });
      }
    }

    // /api/jobs/:id, and /api/jobs/:id/<action>
    if (pathname.startsWith("/api/jobs/")) {
      /*
        Reading a job is tier 2; changing one is tier 3.

        GET here is the event log — what Operator said and did. Seeing that is
        not execution, and it is the whole answer to "what is it doing". Sending
        a turn, cancelling, retrying and answering a permission all still need
        the armed terminal, because each of those makes something happen.
      */
      const allowed =
        req.method === "GET" ? deviceMayUseCapabilities(identity) : deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const [id, action] = pathname.slice("/api/jobs/".length).split("/");
      if (!id) return json(req, res, 404, { error: "no such job" });

      try {
        if (!action && req.method === "GET") {
          const found = jobs.detail(id, Number(url.searchParams.get("since") ?? 0));
          if (!found) return json(req, res, 404, { error: "no such job" });
          return json(req, res, 200, found);
        }
        if (!action && req.method === "DELETE") {
          return json(req, res, 200, jobs.remove(id, identity));
        }
        if (action === "input" && req.method === "POST") {
          const body = await readBody(req);
          return json(req, res, 202, await jobs.input(id, body, identity));
        }
        if (action === "model" && req.method === "POST") {
          const body = await readBody(req);
          return json(req, res, 200, jobs.setModel(id, body?.model));
        }
        if (action === "retry" && req.method === "POST") {
          return json(req, res, 202, jobs.retry(id, identity));
        }
        /*
          Answering a permission the running turn is suspended on (ADR 0012).

          **Deliberately not behind `assertMine`**, on the same reasoning as
          cancel: the turn is stopped dead until someone answers, and refusing
          the device in the owner's hand because a different one started the job
          would strand the work rather than protect anything. Every device that
          reaches here is already authorised to run arbitrary commands through
          the terminal, so answering yes to one grants nothing new.
        */
        if (action === "permission" && req.method === "POST") {
          const body = await readBody(req);
          return json(
            req,
            res,
            200,
            jobs.answerPermission(
              body?.permissionId,
              body?.decision === "allow" ? "allow" : "deny",
              body?.remember === true,
              identity
            )
          );
        }
      } catch (err) {
        const busy = /busy on/.test(err.message);
        return json(req, res, busy ? 409 : 400, { error: err.message });
      }
      return json(req, res, 404, { error: "unknown job route" });
    }

    // Arming is a separate permission from running: a listed device may switch
    // the terminal on, but the list itself only comes from the environment.
    if (pathname === "/api/terminal/enable" && req.method === "POST") {
      const manage = deviceMayManage(identity);
      if (!manage.ok) {
        console.warn(
          `[operator] terminal arm refused for ${identity?.device ?? identity?.client}: ${manage.reason}`
        );
        return json(req, res, 403, { error: "not authorised to arm the terminal", reason: manage.reason });
      }
      const body = await readBody(req);
      const next = body?.enabled === true;
      return json(req, res, 200, { enabled: setEnabled(next, identity) });
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
      return json(req, res, 200, await buildStatus(ROOT));
    }

    /*
      The verification pass — server/health.mjs.

      **`/api/health/checks`, and NOT `/api/health`.** That name was already
      taken, by the cheapest and most-polled endpoint here: `remoteStore.ts`
      hits it on a timer to read the store's `updatedAt` and notice a change it
      did not make, and `useSettings` and the terminal panel use it as a
      liveness probe. Claiming it for this would have put a sweep that spawns a
      process per `.mjs` file onto the store's polling path — and because the
      matches are exact and this one sits earlier in the router, the old route
      would simply have stopped being reached. The app would have gone quiet
      about external changes and nothing would have errored.

      Not gated beyond the auth in front of this router, deliberately. It is
      read-only, it runs no command a caller chooses, and it exposes strictly
      less than `/api/dev/*` (which serves the repository) already does to the
      same devices. Environment variables appear by NAME with a boolean; no
      value is read anywhere in that file.

      `?fresh=1` skips the 15s cache. The expensive half — parsing every .mjs —
      is memoised on file mtime inside health.mjs, so a fresh call re-asks git
      and the registry rather than re-spawning fifty processes.
    */
    /*
      GET only. It spawns a process per .mjs, so answering a HEAD or a stray
      POST with the full sweep makes this the most expensive route in the
      server to hit by accident.
    */
    if (pathname === "/api/health/checks") {
      if (req.method !== "GET") return json(req, res, 405, { error: "GET only" });
      return json(req, res, 200, await health({ fresh: url.searchParams.get("fresh") === "1" }));
    }

    if (pathname === "/api/restart" && req.method === "POST") {
      const manage = deviceMayManage(identity);
      if (!manage.ok) {
        console.warn(
          `[operator] restart refused for ${identity?.device ?? identity?.client}: ${manage.reason}`
        );
        return json(req, res, 403, { error: "not authorised to restart", reason: manage.reason });
      }
      const supervised = process.env.OPERATOR_SUPERVISED === "1";
      /*
        `{"arm": true}` brings the terminal back armed.

        ADR 0011 disarms on every start because arming should be a human act,
        and re-arming after each restart had become friction rather than a
        decision — which erodes the rule in a different direction, by making
        people want it always on.

        This keeps the decision and drops the second trip. The caller has
        ALREADY passed `deviceMayManage` above, which is the same check arming
        itself requires, so this grants nothing that could not be had in two
        requests. The intent rides an exit code rather than a file, because a
        worker can write files — see the note in scripts/supervise.mjs.

        Unsupervised, nothing restarts at all, so promising an armed return
        would be a lie: the flag is reported back as refused rather than
        silently ignored.
      */
      const restartBody = await readBody(req).catch(() => null);
      const armAfter = restartBody?.arm === true && supervised;
      console.log(
        `[operator] restart requested by ${identity?.device ?? "local"}` +
          (armAfter ? " — coming back ARMED" : "") +
          (supervised ? "" : " — NOT supervised, this will stop the server")
      );
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ restarting: true, supervised, armed: armAfter }), () => {
        // Give the socket a moment to drain before the process goes away.
        setTimeout(() => process.exit(armAfter ? 76 : 75), 150);
      });
      return;
    }

    if (pathname === "/api/terminal/run" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        console.warn(
          `[operator] terminal refused for ${identity?.device ?? identity?.client}: ${allowed.reason}`
        );
        return json(req, res, 403, { error: "not authorised to run commands", reason: allowed.reason });
      }
      const body = await readBody(req);
      const line = typeof body?.command === "string" ? body.command.trim() : "";
      if (!line) return json(req, res, 400, { error: "expected { command: string }" });
      try {
        const run = await startRun(line, identity);
        return json(req, res, 200, describeRun(run));
      } catch (err) {
        // A rejected command is a user-facing message, not a server fault.
        return json(req, res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/terminal/stop" && req.method === "POST") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const result = stopRun(url.searchParams.get("id") ?? "");
      return json(req, res, result.ok ? 200 : 400, result);
    }

    if (pathname === "/api/terminal/output") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const run = getRun(url.searchParams.get("id") ?? "");
      if (!run) return json(req, res, 404, { error: "no such run" });
      return json(req, res, 200, readOutput(run, Number(url.searchParams.get("from") ?? 0)));
    }

    if (pathname === "/api/terminal/stream") {
      const allowed = deviceAuthorised(identity);
      if (!allowed.ok) {
        return json(req, res, 403, { error: "not authorised", reason: allowed.reason });
      }
      const run = getRun(url.searchParams.get("id") ?? "");
      if (!run) return json(req, res, 404, { error: "no such run" });

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
      return json(req, res, 200, listClients());
    }

    /*
      What the microphone is hearing, so the UI can react to a voice.

      Polled far more often than anything else here — the mission map redraws
      from it — so it is deliberately the cheapest route in the file: it reads
      four numbers already in memory and touches nothing. No store, no
      subprocess, no disk.

      Deliberately says nothing about whether Operator is SPEAKING. Speech out
      is `SpeechSynthesis` in the browser, so the server genuinely does not
      know, and a `speaking: false` here would be a confident lie in an API
      rather than an absent field. The page reads `speechSynthesis.speaking`
      directly — it is the one asking it to speak.

      That changes if Piper lands and speech moves server-side, at which point
      this is where it belongs.
    */
    /*
      Web Push registration.

      Three routes and no more: what key to subscribe with, here is my device,
      forget my device. Deliberately narrow — this is a registration surface,
      not a way to ask Operator to notify something.

      Gated like everything under /api/ by the check in front of the router, so
      only an identified caller can register a device to be notified. That
      matters: an unauthenticated POST here would let anything on the network
      attach its own phone to his notifications.
    */
    if (pathname === "/api/push/key") {
      return json(req, res, 200, { configured: pushConfigured, publicKey: vapidPublicKey || null });
    }

    if (pathname === "/api/push/subscribe" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const result = await addSubscription(
          body?.subscription,
          identity?.device ?? "a device",
        );
        console.log(`[operator] push: ${identity?.device ?? "a device"} subscribed`);
        return json(req, res, 200, result);
      } catch (err) {
        return json(req, res, 400, { error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
      try {
        const body = await readBody(req);
        return json(req, res, 200, await removeSubscription(String(body?.endpoint ?? "")));
      } catch (err) {
        return json(req, res, 400, { error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    /*
      Turn the clap detector on and off while Operator runs.

      The detector is the ALWAYS-ON layer: it reduces the stream to one number
      per chunk and cannot produce words, but it holds a microphone open and
      keeps two seconds of audio in memory so a capture is not clipped. That is
      a thing worth being able to switch off deliberately rather than only by
      not setting an environment variable at boot.

      Gated like everything under /api/ — being able to open the owner's
      microphone is not something an unidentified caller should reach.
    */
    if (pathname === "/api/listen/detector" && req.method === "POST") {
      const body = await readBody(req);
      const wanted = Boolean(body?.on);
      if (wanted) {
        if (!clapCallback) {
          return json(req, res, 409, { error: "the detector was never configured this run" });
        }
        const started = startListening(clapCallback);
        console.log(`[operator] clap detector ${started ? "ON" : "refused"} by ${identity?.device ?? "?"}`);
        return json(req, res, started ? 200 : 409, {
          listening: listenState.listening,
          reason: listenState.reason ?? null,
        });
      }
      stopListening();
      console.log(`[operator] clap detector OFF by ${identity?.device ?? "?"}`);
      return json(req, res, 200, { listening: listenState.listening, reason: null });
    }

    if (pathname === "/api/listen") {
      return json(req, res, 200, {
        listening: listenState.listening,
        device: listenState.device,
        level: Number((listenState.level ?? 0).toFixed(4)),
        threshold: Number((listenState.threshold ?? 0).toFixed(4)),
        claps: listenState.claps,
        reason: listenState.reason,
      });
    }

    /*
      Audio recorded on a phone, transcribed here.

      The phone reads its own microphone for the level meter — local and
      instant — but the WORDS were still coming from the microphone attached to
      this PC. So the owner could watch his phone's mic move the core while
      Whisper listened to a different room entirely. This closes that gap.

      Not the browser's own SpeechRecognition, which would have been a one-line
      answer: on iOS it sends the audio to APPLE. That is an external host under
      CLAUDE.md's approval rule, it is his voice rather than a prompt, and he
      has approved no such thing. This path keeps everything on his hardware —
      the phone posts to his own server over the tailnet and the same resident
      Whisper the clap gesture uses does the work.

      Tier 2: transcribing his own voice is not execution, so it does not need
      an armed terminal. Capped at 8 MB, which is minutes of Opus and far more
      than the few seconds this is for.
    */
    if (pathname === "/api/listen/transcribe" && req.method === "POST") {
      const allowed = deviceMayUseCapabilities(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });

      const chunks = [];
      let size = 0;
      let tooBig = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          tooBig = true;
          break;
        }
        chunks.push(chunk);
      }
      if (tooBig) return json(req, res, 413, { error: "audio too large" });

      try {
        const heard = await transcribeUpload(Buffer.concat(chunks));

        /*
          Same observation as the clap path, for the microphone he actually
          uses. Phone audio is where most real speech arrives, so it is where
          the intent router's phrase list gets its evidence.

          Reported to the client as well as logged, so it can be watched from
          the phone rather than only in serve.log — but the client is told
          plainly this is an observation, not an offer. Nothing acts on it.
        */
        /*
          Arming by voice, which replaces arming by clap.

          This is the one spoken thing allowed to act immediately, and the
          reasoning is that it has to be: arming is what makes everything else
          reachable, so it cannot be the thing waiting on evidence.

          Three gates, and the middle one is the important one:

          - the phrase has to match a short, closed, anchored list
          - the DEVICE has to be one that could already arm, checked exactly as
            the Dev page's button checks it. Speaking grants nothing tapping
            would not; this is a new way to ask, not a new permission
          - it expires, because Whisper does mishear and a terminal left armed
            for days by a sentence he never said is the failure worth bounding

          Works from the phone as well as the desk, deliberately — this is the
          route phone audio arrives on, and "notify me if u need anything" is
          not much use if he then has to walk to the machine to arm it.
        */
        const spoken = heard?.text ? matchVoiceCommand(heard.text) : null;

        /*
          Stop first, before anything else can happen with this sentence.

          It is checked ahead of arming, ahead of the intent router and ahead of
          creating a job, because every one of those is a thing "stop" might be
          trying to prevent. It also needs no authorisation beyond reaching this
          route: stopping is the one action that cannot make things worse, and a
          runaway has to be killable from whichever device is in his hand.
        */
        if (spoken === "stop") {
          const { stopped } = jobs.stopAll("stopped by voice");
          console.log(`[operator] voice STOP — cancelled ${stopped} job(s)`);
          return json(req, res, 200, {
            ...heard,
            command: { done: true, stop: true, stopped },
            handled: true,
            /*
              Silent when there was nothing to stop. Saying "nothing was
              running" over the top of him is the app arguing with him about
              whether he needed to interrupt it.
            */
            say: stopped ? `Stopped.` : null,
          });
        }

        /*
          An overlapped segment may contain OPERATOR'S OWN VOICE, so nothing
          but the stop above is allowed out of it.

          The client uploads these deliberately rather than discarding them —
          "stop" is said while it is talking, which is exactly when the
          self-hearing guard would have thrown the audio away. Everything else
          is dropped here, so the feedback loop stays closed.
        */
        if (req.headers["x-overlapped"] === "1") {
          console.log(
            `[operator] overlapped, not a stop — discarded ${JSON.stringify(String(heard?.text ?? "").slice(0, 80))}`,
          );
          return json(req, res, 200, { text: "", discarded: "spoken over Operator" });
        }

        let armed = null;
        if (spoken) {
          const mayArm = deviceMayManage(identity);
          if (!mayArm.ok) {
            armed = { done: false, reason: mayArm.reason };
            console.warn(`[operator] voice "${spoken}" refused: ${mayArm.reason}`);
          } else {
            const on = spoken === "arm";
            setEnabled(on, identity, on ? VOICE_ARM_MS : 0, on ? jobs.busy : null);
            armed = { done: true, enabled: on };
            console.log(`[operator] terminal ${on ? "ARMED" : "disarmed"} by voice from ${identity?.device ?? "?"}`);
          }
        }

        let intent = null;
        let acted = null;
        try {
          /*
            Match everything; gate only what reaches OUTSIDE Operator.

            This started as a blanket signal gate on the whole route, added
            because three "intent: no match" lines in the log looked like
            Whisper's known silence hallucinations. They were not — the owner
            had actually said all three, and `media_play_pause` turns out never
            to have run at all. The premise was wrong and the blanket gate it
            justified was quietly costing every one-word command.

            What survives is the narrow version, kept because the risk is real
            even though this was not an instance of it: `MEDIA` in intent.mjs
            matches a bare "play", and a single word is exactly what a bad
            transcription produces. Ticking off a gym set on a misheard sentence
            is undoable from the page it happened on. Pressing the play/pause
            key reaches into whatever else is running on the desk, and there is
            nothing in Operator to undo it with.

            So Operator's own data matches on the transcript as it always has,
            and the one action with a side effect outside Operator wants a
            transcript worth trusting.
          */
          const OUTSIDE_OPERATOR = new Set(["media_play_pause"]);

          intent = heard?.text ? matchIntent(heard.text) : null;

          if (intent && OUTSIDE_OPERATOR.has(intent.action)) {
            const confidence = Number(heard?.confidence ?? 0);
            const voicedPct = Number(heard?.voicedPct ?? 0);
            const words = String(heard?.text ?? "").split(/\s+/).filter(Boolean).length;
            if (confidence < 0.55 || voicedPct < 1.5 || words < 2) {
              console.log(
                `[operator] intent: not acting on ${JSON.stringify(heard.text.slice(0, 80))} ` +
                  `— ${intent.action} reaches outside Operator ` +
                  `(confidence ${confidence.toFixed(2)}, voiced ${voicedPct.toFixed(1)}%, ${words} word(s))`,
              );
              intent = null;
            }
          }
          if (intent) {
            /*
              Run it, and hand the result back for the page to speak.

              Unlike the clap path this one HAS a browser at the other end, so
              a spoken confirmation is possible and is the thing that makes a
              wrong match audible while it is still cheap to undo. `acted.say`
              is what gets read out; `acted.ran` is what tells the client not
              to send the sentence on to a worker as well.
            */
            acted = await runIntent(heard.text);
            console.log(
              `[operator] intent ${acted.ran ? "RAN" : "stopped"}: ${intent.action}` +
                `${intent.needs ? ` via ${intent.needs.find}` : ""} — ${acted.ran ? intent.why : acted.reason}`,
            );
          } else if (heard?.text) {
            /*
              Log the MISSES too, with what was actually said.

              This path only recorded hits, which made the observation useless
              for the thing it exists to answer. A hit proves a rule fires; a
              miss is where a real phrasing falls through, and reading those is
              the whole reason this runs before it is trusted to act. Three
              correct clock matches told me nothing about the sentences it
              silently declined.

              The transcript is his own speech on his own machine, going to his
              own log — the same place every action he takes is already
              recorded.
            */
            console.log(`[operator] intent: no match — ${JSON.stringify(heard.text.slice(0, 120))}`);
          }
        } catch (err) {
          console.warn(`[operator] intent router threw: ${err?.message ?? err}`);
        }

        return json(req, res, 200, {
          ...heard,
          wouldMatch: intent,
          command: armed,
          /*
            `handled` means the client must NOT also send this to a worker.
            True when the action ran, and ALSO true when it matched and stopped
            — an ambiguous "did you mean X or Y?" that then gets forwarded to
            Claude would have his answer treated as a fresh request.
          */
          intentAction: acted?.ran ? intent?.action ?? null : null,
          handled: Boolean(acted && (acted.ran || acted.say)),
          say: acted?.say ?? null,
        });
      } catch (err) {
        return json(req, res, 500, { error: String(err?.message ?? err).slice(0, 300) });
      }
    }

    /*
      Speech OUT, from a voice running on this machine.

      The browser's SpeechSynthesis works and is free, but it is a system voice
      — the best one installed is now picked rather than the OS default, and
      that was the free half of the fix. This is the other half: Kokoro through
      ONNX, local, no account, nothing leaving the machine. ElevenLabs and
      Deepgram were refused for exactly the reason this route exists.

      GET so an <audio> element can point straight at it, which is what lets the
      browser stream and cache it without the page holding a blob. Tier 2:
      saying a sentence out loud is not execution.

      Measured 2026-09-01: ~1s for an acknowledgement, ~2.1s for a full
      sentence, 2.5s to load the model warm. The model is released after an
      idle period, so an Operator nobody is talking to gives the memory back.
    */
    if (pathname === "/api/speak") {
      const allowed = deviceMayUseCapabilities(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });

      // Status, so a client can find out whether to use this at all before
      // committing a sentence to it.
      if (req.method === "GET" && !url.searchParams.get("text")) {
        return json(req, res, 200, { ...ttsAvailable(), state: ttsState });
      }

      const text =
        url.searchParams.get("text") ?? (req.method === "POST" ? (await readBody(req))?.text : "");
      if (!text) return json(req, res, 400, { error: "no text" });

      try {
        const spoken = await synthesize(text, { voice: url.searchParams.get("voice") ?? undefined });
        res.writeHead(200, {
          "content-type": spoken.mime,
          "content-length": spoken.audio.length,
          // Never cached: the same sentence can be asked for with a different
          // voice, and these are small enough that re-synthesising is cheaper
          // than reasoning about invalidation.
          "cache-control": "no-store",
        });
        return res.end(spoken.audio);
      } catch (err) {
        return json(req, res, 503, { error: String(err?.message ?? err).slice(0, 300) });
      }
    }

    // Owner-approved outbound call — see server/status.mjs for why it's here
    // and not in the browser.
    if (pathname === "/api/claude-status") {
      return json(req, res, 200, await claudeStatus());
    }

    /*
      The logs, readable from the app rather than only from a terminal.

      Named, from a closed set in `logs.mjs` — there is no path parameter here
      and there must not be one. `data/` holds the store, the backups and the
      push subscriptions, so a log viewer that accepted a filename would be a
      file reader wearing a smaller hat.

      Gated like everything under /api/ by the check in front of the router.
    */
    if (pathname === "/api/logs") {
      return json(req, res, 200, { logs: listLogs() });
    }

    if (pathname.startsWith("/api/logs/")) {
      const id = pathname.slice("/api/logs/".length);
      try {
        return json(req, res, 200, await tailLog(id, url.searchParams.get("lines")));
      } catch (err) {
        return json(req, res, 404, { error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    if (pathname === "/api/health") {
      /*
        `updatedAt` is here so an open page can notice a change it did not make.

        The store already stamped it on every write; nothing read it. Without
        it the client only refreshed on focus, so speaking "set the control
        plane to sixty-two percent" changed the data instantly and the map kept
        showing 60% until you navigated away and back.

        Deliberately hung off the EXISTING health route rather than a new one:
        it is already the cheapest endpoint, it does not touch disk (the store
        is in memory), and one poll answering both "is the server there" and
        "has anything changed" is one poll rather than two.
      */
      const store = await load();
      return json(req, res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        dataFile: DATA_FILE,
        updatedAt: store.updatedAt ?? null,
      });
    }

    if (pathname === "/api/state" && req.method === "GET") {
      const store = await load();
      return json(req, res, 200, store);
    }

    // Bulk write — used once by the client to migrate existing localStorage
    // data up to the server, and later by Settings > Import.
    if (pathname === "/api/state" && req.method === "PUT") {
      const body = await readBody(req);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json(req, res, 400, { error: "expected an object of { key: value }" });
      }
      await mergeState(body);
      return json(req, res, 200, { ok: true, keys: Object.keys(body).length });
    }

    if (pathname.startsWith("/api/state/") && req.method === "PUT") {
      const key = decodeURIComponent(pathname.slice("/api/state/".length));
      if (!key) return json(req, res, 400, { error: "missing key" });
      const body = await readBody(req);
      await setState(key, body?.value ?? null);
      return json(req, res, 200, { ok: true, key });
    }

    /*
      The capability layer — named, validated changes to Operator's own data.

      Same device gate as jobs and the terminal, deliberately: this writes real
      personal data, so "can reach the app" is not enough. GET is the catalogue
      (what can be called, and with what), POST runs one.

      An ActionError is the caller's mistake — a bad parameter, an id that
      doesn't exist — so it comes back as a 400 with the reason, which is what
      lets a model correct itself on the next turn rather than guessing.
    */
    if (pathname === "/api/actions") {
      /*
        Tier 2, not tier 3 — see `deviceMayUseCapabilities` in terminal.mjs.

        This used to require `deviceAuthorised`: a listed device AND an armed
        terminal. That made ticking off a gym session need the same rights as
        running arbitrary commands, while `PUT /api/state/<key>` — generic and
        unvalidated — stayed open to any authenticated device. The validated
        path was the locked one.
      */
      const allowed = deviceMayUseCapabilities(identity);
      if (!allowed.ok) return json(req, res, 403, { error: "not authorised", reason: allowed.reason });

      if (req.method === "GET") {
        return json(req, res, 200, { actions: listActions() });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          const result = await runAction(body?.action, body?.params);
          console.log(
            `[operator] action ${body?.action} by ${identity?.device ?? "unknown"}`
          );
          return json(req, res, 200, { ok: true, action: body?.action, result });
        } catch (err) {
          return json(req, res, err instanceof ActionError ? 400 : 500, { error: err.message });
        }
      }
    }

    // --- Homelab status (probes only what the store already lists) ---

    if (pathname === "/api/homelab/status" && req.method === "GET") {
      const store = await load();
      return json(req, res, 200, await checkServices(store.state["homelab.services"]));
    }

    // --- Dev browser (read-only, sandboxed to the repo — see dev.mjs) ---

    if (pathname === "/api/dev/meta") {
      return json(req, res, 200, await repoMeta(ROOT));
    }

    if (pathname === "/api/dev/tree") {
      const tree = await listTree(ROOT, url.searchParams.get("path") ?? ".");
      if (!tree) return json(req, res, 400, { error: "path not allowed" });
      return json(req, res, 200, tree);
    }

    if (pathname === "/api/dev/file") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(req, res, 400, { error: "missing path" });
      const file = await readTextFile(ROOT, rel);
      return json(req, res, file.error ? 400 : 200, file);
    }

    // Drop a single slice back to its seed. Settings > Reset will use this.
    if (pathname.startsWith("/api/state/") && req.method === "DELETE") {
      const key = decodeURIComponent(pathname.slice("/api/state/".length));
      await deleteState(key);
      return json(req, res, 200, { ok: true, key });
    }

    if (pathname.startsWith("/api/")) {
      return json(req, res, 404, { error: `no route for ${req.method} ${pathname}` });
    }

    if (SERVE_DIST) return await serveStatic(req, res, pathname);
    return json(req, res, 404, { error: "API only — the dev server serves the app" });
  } catch (err) {
    console.error("[operator]", err);
    return json(req, res, 500, { error: err.message });
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

  // Find the local worker, and keep looking. Ollama runs continuously but this
  // process is started by Task Scheduler and can beat it up, so a one-shot
  // probe would miss a service that was merely seconds behind.
  void initProviders({ log: (line) => console.log(line) });

  /*
    Listen for a clap, on the machine.

    Runs here rather than in a browser tab because the gesture only matters
    while you are looking at something else, which is exactly when a browser
    throttles a page and suspends its audio. Off unless OPERATOR_LISTEN names a
    microphone — an always-open mic is a decision, not a default.
  */
  /*
    Two claps: summon, then listen, then act on what was said.

    The owner's choice of the three shapes offered. Summon and listen run
    TOGETHER rather than in sequence — capture starts on the second clap while
    the window is still coming forward, so a sentence begun with the clap is
    caught rather than clipped. That is the whole reason the callback fires on
    the second clap rather than after the view changes.

    Nothing is spoken back and no job is started when nothing was heard: a
    misfired clap should cost a moment of listening, not an empty conversation
    in the tab strip.
  */
  const onDoubleClap = () => {
    /*
      `pause: false` — the clap no longer touches what is playing.

      The owner's call after using it: he would rather pause things himself
      than have a gesture reach into whatever has the media session. Which is
      right, and it removes the surprising half of the action — a summon that
      also silences your music is doing two things when you asked for one.

      `media_play_pause` stays as its own action, because being able to say
      "pause that" is independently useful. It is just not automatic.
    */
    /*
      The clap no longer arms anything.

      It did, briefly, bounded to twenty minutes because the detector
      false-fires. Then the detector turned out to be deaf on this machine
      entirely — the Realtek emits 895 non-zero samples in three seconds and
      digital silence for the rest — so clap-arming could never have worked
      here regardless of the window.

      His replacement is better than a fix for that would have been: arming by
      VOICE. A clap is anonymous, so any sharp sound qualifies and the window
      existed to bound the damage. A spoken sentence is identifiable, arrives
      through the browser microphone that actually works, and can be required
      to come from a device already allowed to arm. See the transcribe route.
    */
    void runAction("focus_operator").catch((err) => {
      console.warn(`[operator] clap summon failed: ${err?.message ?? err}`);
    });
    void runAction("listen_once", { seconds: 6 })
      .then(async (heardResult) => {
        const text = String(heardResult?.heard ?? "").trim();
        if (!text) {
          console.log(
            `[operator] clap: nothing heard (peak ${heardResult?.peak ?? "?"})`,
          );
          return;
        }
        /*
          A transcript is not yet a request — check it is really speech first.

          On 2026-08-31 this created about twenty jobs from nothing. Whisper
          fed near-silence emits "Thanks for watching!", "Mm-hmm", "Okay." and
          "Thank you." with high confidence, and every one of those started a
          real Claude Code turn against the usage ceiling. One got as far as
          asking permission to run git.

          Three gates, cheapest first, and all three are needed:

          - CONFIDENCE, now that `transcribe.py` reports something real. It was
            printing `language_probability` from an English-only model, a
            constant ~1.00, so this check would have passed everything.
          - VOICED FRACTION, measured from the PCM rather than the model. A
            capture that is 99% silence did not contain a sentence, whatever
            the transcriber made of it.
          - LENGTH, because "Ugh!" is not an instruction even when genuinely
            said, and acting on it costs more than ignoring it.

          Deliberately biased towards dropping: a missed command costs one more
          clap, an invented one costs money and a tab. Those are not
          symmetrical, so the threshold should not be either.
        */
        const confidence = Number(heardResult?.confidence ?? 0);
        const voicedPct = Number(heardResult?.voicedPct ?? 0);
        const words = text.split(/\s+/).filter(Boolean).length;

        if (confidence < 0.55 || voicedPct < 1.5 || words < 2) {
          console.log(
            `[operator] clap: ignoring ${JSON.stringify(text)} ` +
              `(confidence ${confidence.toFixed(2)}, voiced ${voicedPct.toFixed(1)}%, ${words} word(s))`,
          );
          return;
        }

        console.log(
          `[operator] clap heard: ${JSON.stringify(text)} ` +
            `(confidence ${confidence.toFixed(2)}, voiced ${voicedPct.toFixed(1)}%)`,
        );
        /*
          Watch what the intent router WOULD have done, without letting it.

          `server/intent.mjs` turns a spoken sentence into a capability action
          in microseconds with no model involved, and it passes 103 of its own
          tests. But every one of those phrases was invented — none came from a
          real transcript of him speaking. Shipping it live on that basis is
          exactly the guessed-clap-threshold mistake, which cost two evenings
          against a microphone that could not physically reach the number.

          So it runs and logs and changes nothing. A few days of real speech
          says whether it fires when it should, and more importantly whether it
          ever fires when it should NOT — which is the failure that matters,
          because a match writes to his data with no model and no confirmation
          in between. The same discipline semantic verification used before it
          was trusted.

          Wrapped, because a router that throws must not cost him the sentence.
        */
        const outcome = await runIntent(text);
        if (outcome.ran) {
          /*
            Handled here, and NO job is created.

            That is the entire point: "tick off bench press" cost a worker turn
            and several seconds to do something the capability layer does in
            microseconds. A rule match is not a cheaper way to reach Claude, it
            is not reaching Claude at all.
          */
          /*
            No spoken reply on THIS path, deliberately.

            This is the clap gesture: the microphone is attached to the server,
            and the server has no speaker of its own — `tts.mjs` synthesises
            audio and hands it to a browser to play. Confirmation instead comes
            from the notification `runAction` already sends on every write, so
            his phone says "Ticked off Bench Press" a second later.

            The browser path below DOES speak, because there is a page there to
            play it.
          */
          console.log(`[operator] intent: ${outcome.say}`);
          return;
        }
        if (outcome.say) {
          /*
            It matched but could not finish — ambiguous, or the thing named is
            not on today's board. Say so and stop. Falling through to a worker
            would be worse than useless: he would be asked a question, answer
            it, and have his answer treated as a fresh request.
          */
          console.log(`[operator] intent: stopped — ${outcome.say}`);
          return;
        }
        console.log(`[operator] intent: no match — going to a worker (${outcome.reason})`);

        /*
          Straight into a job, so the transcript is answered rather than
          logged. Routed with "auto" like anything else — a spoken request is
          not a different KIND of request, and hardcoding a worker here would
          send "what's my gym session" to Claude Code at Claude Code prices.

          The identity is the machine itself: this did not arrive over HTTP
          from a device, it came from a microphone attached to the server.
        */
        return jobs.create(text, undefined, { device: "this machine", method: "local" });
      })
      .catch((err) => {
        console.warn(`[operator] clap listen failed: ${err?.message ?? err}`);
      });
  };

  /*
    Exposed so the detector can be switched on and off while Operator runs.

    It used to start once at boot with no way off short of a restart. ADR 0015
    made "off by default and visibly so" a condition of the desktop shell, and
    the owner's framing is the better one: self-hosting decides who HOLDS a
    recording, not whether it should have been made. A microphone that is open
    because nobody chose to close it is a decision by default.

    The callback is captured rather than rebuilt, so restarting the detector
    cannot quietly get a different one.
  */
  clapCallback = onDoubleClap;

  if (startListening(onDoubleClap)) {
    console.log(`[operator] listening for a double clap on "${listenState.device}"`);
  } else if (listenState.reason && process.env.OPERATOR_LISTEN) {
    console.warn(`[operator] not listening: ${listenState.reason}`);
  }

  /*
    Load the voice now, rather than when he first speaks to it.

    `warm()` has existed in tts.mjs since Kokoro landed and was NEVER CALLED,
    so the model loaded lazily on the first `/api/speak` of each server run.
    Measured 2026-09-03, immediately after a restart: **17.8 seconds** for the
    first sentence, then 1.2s for every one after it.

    That is the "still very slow" the owner kept reporting, and it hid behind
    every other measurement taken today — each of those was made on a warm
    server, minutes after the restart that had already paid the cost.

    It also explains why the streaming change felt like it had not helped: 1.4s
    against 5.6s is a real improvement and completely invisible when the number
    in front of both is eighteen seconds.

    Deliberately not awaited. A server that will not answer `/api/state` for
    eighteen seconds because it is loading a speech model has traded a worse
    problem for a better one, and the app must come up whether or not there is
    a voice.
  */
  /*
    Say where the agent worktree stands, at boot.

    It drifted 183 commits behind without anything noticing, and the first
    thing to notice was Operator failing to find its own capability layer. A
    line in serve.log at startup is the cheapest possible early warning, and
    the one place someone debugging "why did the agent say that action does not
    exist" will actually look.
  */
  void import("./worktree.mjs")
    .then(({ state }) => state(process.env.OPERATOR_JOB_CWD))
    .then((tree) => {
      if (!tree?.ok) return;
      if (tree.behind > 0) {
        console.warn(
          `[operator] agent worktree is ${tree.behind} commit(s) BEHIND main` +
            (tree.dirty.length ? ` and dirty (${tree.dirty.length} file(s))` : "") +
            " — jobs will run against stale code until it is synced",
        );
      } else {
        console.log("[operator] agent worktree is level with main");
      }
    })
    .catch(() => {});

  void warmVoice()
    .then((ok) => {
      if (ok) console.log("[operator] voice warm — the first reply will not pay for the load");
    })
    .catch(() => {
      // Never fatal. No voice is a degraded Operator; no server is no Operator.
    });
});
