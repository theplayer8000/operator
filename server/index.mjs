// Operator storage server.
//
// A single-user JSON store over HTTP. No dependencies, no auth, no database —
// it exists so Operator's data lives in a file on disk (and later on the NAS)
// instead of being trapped in one browser profile. See docs/decisions/0006.
//
//   GET  /api/state          → { schemaVersion, updatedAt, state }
//   PUT  /api/state/<key>    → body is the raw value for that slice
//   PUT  /api/state          → body is a whole { key: value } map (import/migrate)
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

const gzip = promisify(gzipCb);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OPERATOR_PORT ?? 5174);
const HOST = process.env.OPERATOR_HOST ?? "0.0.0.0";

// Point this at a NAS mount when the server moves to the EPYC box.
const DATA_FILE = process.env.OPERATOR_DATA ?? join(ROOT, "data", "operator.json");
const DIST_DIR = join(ROOT, "dist");
const SERVE_DIST =
  process.env.OPERATOR_SERVE_DIST === "1" || process.argv.includes("--serve-dist");

const SCHEMA_VERSION = 2;

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
    if (pathname === "/api/clients") {
      return json(res, 200, listClients());
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

server.listen(PORT, HOST, () => {
  console.log(`[operator] storage server on http://localhost:${PORT}`);
  console.log(`[operator] data file: ${DATA_FILE}`);
  if (SERVE_DIST) console.log(`[operator] serving app from ${DIST_DIR}`);
});
