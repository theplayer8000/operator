// Is what you're looking at the current code?
//
// Operator is edited while it runs, so "the app" is really two things at once:
//
//   src/    → what Vite serves on the dev port, compiled per request
//   dist/   → what this server serves, a snapshot from the last `npm run build`
//
// They drift the moment anything is edited, and nothing on screen said so. The
// failure that motivated this is quiet: a change is made, the dev URL shows it,
// the live URL doesn't, and the obvious conclusion — "the change didn't work" —
// is wrong. It was never built.
//
// So this answers one question honestly: is `dist/` older than `src/`?

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import net from "node:net";

/** Directories that never affect the built output. */
const SKIP = new Set(["node_modules", ".git", "dist", "data", "backups"]);
/** Recomputed at most this often — a directory walk per poll would be rude. */
const CACHE_MS = 3_000;

let cache = null;

async function newestMtime(dir, newest = 0) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = await newestMtime(path, newest);
    } else {
      try {
        const s = await stat(path);
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {
        /* vanished mid-walk — it can't be the newest thing that matters */
      }
    }
  }
  return newest;
}

/** Is something listening? Used to tell whether the dev server is up. */
function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Is this the long-running server, or something that imported the module?
 *
 * `argv[1]` is the entry script. Only `server/index.mjs` is the process whose
 * uptime and environment describe the running Operator; anything else — a
 * `node -e` probe, a script, a test — is asking about itself without meaning
 * to. See the comment on the `server` block below.
 */
const IN_SERVER = /[\\/]server[\\/]index\.mjs$/.test(process.argv[1] ?? "");

export async function buildStatus(root, { devPort = 5173, agentPort = 5175 } = {}) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  const distIndex = join(root, "dist", "index.html");
  const built = existsSync(distIndex) ? (await stat(distIndex)).mtimeMs : 0;

  // Sources that can change the built output. `index.html` and the Tailwind and
  // Vite configs are included because editing those absolutely changes it, and
  // leaving them out would report "up to date" after a real change.
  let newest = await newestMtime(join(root, "src"));
  for (const file of ["index.html", "tailwind.config.ts", "vite.config.ts", "package.json"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const s = await stat(path);
    if (s.mtimeMs > newest) newest = s.mtimeMs;
  }

  // Server code doesn't go through the build at all — it's loaded at boot — so
  // it gets its own answer rather than being folded into a single "stale" flag
  // that would tell you to run the wrong command.
  const serverNewest = await newestMtime(join(root, "server"));

  const value = {
    checkedAt: new Date(now).toISOString(),
    live: {
      builtAt: built ? new Date(built).toISOString() : null,
      sourceChangedAt: newest ? new Date(newest).toISOString() : null,
      stale: Boolean(built && newest && newest > built),
      missing: !built,
    },
    /*
      Two of these three describe THE PROCESS ASKING, not the server.

      `process.uptime()` and `OPERATOR_SUPERVISED` are properties of whoever
      imported this module. Inside `server/index.mjs` that is exactly right and
      is the only way this ever runs in production. Imported from a shell to
      diagnose something, it silently answers about the shell — and it did:
      run out of process on 2026-09-04 it reported "no server/ file is newer
      than the process" (the importing process was seconds old) and "not under
      the supervisor" (a plain shell has no OPERATOR_SUPERVISED), and both were
      false about the server that was actually running.

      A wrong "ok" is the worse of the two. It said the server was current when
      eight files had changed under it, which is precisely the class of silent
      failure this module exists to catch, produced by the module itself.

      So `inServer` gates them, and they report `null` — "cannot answer from
      here" — rather than an answer about the wrong process. `health.mjs` turns
      null into an `unknown` row.
    */
    server: {
      inServer: IN_SERVER,
      startedAt: IN_SERVER ? new Date(now - Math.round(process.uptime() * 1000)).toISOString() : null,
      codeChangedAt: serverNewest ? new Date(serverNewest).toISOString() : null,
      stale: IN_SERVER ? Boolean(serverNewest && serverNewest > now - process.uptime() * 1000) : null,
      supervised: IN_SERVER ? process.env.OPERATOR_SUPERVISED === "1" : null,
    },
    dev: {
      port: devPort,
      running: await portOpen(devPort),
    },
    /*
      The agent's own checkout, served separately.

      `OPERATOR_JOB_CWD` sends jobs into a git worktree so Claude never edits
      the tree the running server reads. That only helps if its work is
      reachable — otherwise the branch is reviewed by reading a diff, which is
      how a half-finished migration gets waved through twice.
    */
    agent: {
      port: agentPort,
      running: await portOpen(agentPort),
      cwd: process.env.OPERATOR_JOB_CWD ?? null,
      separate: Boolean(
        process.env.OPERATOR_JOB_CWD &&
          resolve(process.env.OPERATOR_JOB_CWD) !== resolve(root)
      ),
    },
  };

  cache = { at: now, value };
  return value;
}
