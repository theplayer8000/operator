#!/usr/bin/env node
//
// Operator store backup. Infrastructure protection, not a feature.
//
// Deliberately standalone: no dependencies, no imports from src/ or server/,
// and it never talks to the API. It reads `data/operator.json` off disk, so it
// works when the storage server is down, when Vite is down, and when the app
// has never been opened. Nothing about it relies on the Operator UI — that was
// the point of the request (2026-07-30). The manual Settings > Export stays as
// a second, independent route.
//
// Reading the file directly is safe because the server writes via temp file +
// rename (see `persist()` in server/index.mjs), which is atomic — a reader
// either sees the whole old file or the whole new one, never a half-written
// one.
//
//   node scripts/backup.mjs            take a backup if the data changed
//   node scripts/backup.mjs --list     show restore points, newest first
//   node scripts/backup.mjs --force    take one even if nothing changed
//
// Where backups go:
//   OPERATOR_BACKUP_DIR   default: <home>/OperatorBackups
//   OPERATOR_BACKUP_KEEP  default: 60
//   OPERATOR_DATA         default: <repo>/data/operator.json  (same var the server uses)
//
// The default lives **outside the repo** on purpose. A backup inside the
// project directory dies with the project directory, and would be one stray
// `git add -f` away from being committed. Point OPERATOR_BACKUP_DIR at the NAS
// when there is one — that is the whole migration.

import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = process.env.OPERATOR_DATA ?? join(ROOT, "data", "operator.json");
const BACKUP_DIR = process.env.OPERATOR_BACKUP_DIR ?? join(homedir(), "OperatorBackups");

/**
 * How many restore points to keep.
 *
 * Because an unchanged store is skipped, this is **60 distinct states of your
 * data**, not 60 slots burned by a scheduler running on a quiet weekend. That
 * is a stronger guarantee than a time window: how far back you can go depends
 * on how much you actually changed, which is the thing that matters.
 */
const KEEP = Math.max(1, Number(process.env.OPERATOR_BACKUP_KEEP ?? 60) || 60);

const PREFIX = "operator-";
const SUFFIX = ".json";

/**
 * Local time, never toISOString(). An evening backup in BST would otherwise be
 * filed under tomorrow — the same trap as OPS-009, and a backup with the wrong
 * date on it is a backup you reach for and get wrong.
 */
function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  const names = await readdir(BACKUP_DIR);
  const mine = names.filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
  // The stamp is lexicographically sortable, which is why it is shaped that
  // way — no need to stat every file just to order them.
  return mine.sort().reverse();
}

/**
 * A backup that doesn't parse is worse than no backup, because you find out
 * when you need it. Every write is read back and checked before the old ones
 * are pruned, and the shape check is the same one the server relies on.
 */
function validate(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `not valid JSON — ${err.message}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "top level is not an object";
  }
  if (!parsed.state || typeof parsed.state !== "object" || Array.isArray(parsed.state)) {
    return "no `state` object — this is not an Operator store";
  }
  if (Object.keys(parsed.state).length === 0) {
    return "`state` is empty — refusing to treat that as a good backup";
  }
  return null;
}

/**
 * Take a backup. Returns a result object rather than printing, so the storage
 * server can call this on a timer without writing to its own stdout format.
 *
 * `status` is one of: "written" | "skipped" | "refused" | "missing" | "failed".
 * Only "written" means a new restore point exists.
 */
export async function runBackup({ force = false } = {}) {
  if (!existsSync(DATA_FILE)) {
    return { status: "missing", reason: `no store at ${DATA_FILE}` };
  }

  const text = await readFile(DATA_FILE, "utf8");

  const problem = validate(text);
  if (problem) {
    // Refuse rather than propagate. If the live store is broken, the last good
    // backup is the valuable thing and must not be pruned to make room for a
    // copy of the breakage.
    return { status: "refused", reason: problem };
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const existing = await listBackups();

  // Skip an unchanged store, so restore points track real edits rather than
  // scheduler ticks.
  if (!force && existing.length > 0) {
    const newest = join(BACKUP_DIR, existing[0]);
    const previous = await readFile(newest, "utf8").catch(() => null);
    if (previous !== null && hash(previous) === hash(text)) {
      return { status: "skipped", since: existing[0] };
    }
  }

  const name = `${PREFIX}${stamp(new Date())}${SUFFIX}`;
  const target = join(BACKUP_DIR, name);
  await writeFile(target, text, "utf8");

  // Read back what actually landed on disk, not what we think we wrote.
  const readBack = await readFile(target, "utf8");
  const wrote = validate(readBack);
  if (wrote || hash(readBack) !== hash(text)) {
    await unlink(target).catch(() => {});
    return { status: "failed", reason: wrote ?? "content mismatch", name };
  }

  // Prune only after the new one is verified, so there is never a window with
  // no good copy.
  const all = await listBackups();
  const stale = all.slice(KEEP);
  for (const old of stale) {
    await unlink(join(BACKUP_DIR, old)).catch(() => {});
  }

  return {
    status: "written",
    name,
    target,
    bytes: Buffer.byteLength(text, "utf8"),
    slices: Object.keys(JSON.parse(text).state).length,
    pruned: stale.length,
    kept: Math.min(all.length, KEEP),
    dir: BACKUP_DIR,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  if (args.includes("--list")) {
    const backups = await listBackups();
    console.log(`Backup directory: ${BACKUP_DIR}`);
    console.log(`Restore points:   ${backups.length} (keeping newest ${KEEP})`);
    if (backups.length === 0) {
      console.log("\nNone yet. Run `npm run backup` to take the first one.");
      return 0;
    }
    console.log("");
    for (const [i, name] of backups.entries()) {
      const info = await stat(join(BACKUP_DIR, name));
      const kb = (info.size / 1024).toFixed(1);
      console.log(`  ${String(i + 1).padStart(3)}. ${name}  ${kb.padStart(7)} KB`);
    }
    console.log("\nTo restore: stop the server, copy the file over");
    console.log(`${DATA_FILE}, then start it again.`);
    console.log("Take a backup of the current file first if it still has anything you want.");
    return 0;
  }

  const result = await runBackup({ force });

  switch (result.status) {
    case "missing":
      console.error(`No store at ${DATA_FILE} — nothing to back up.`);
      return 1;
    case "refused":
      console.error(`Refusing to back up ${DATA_FILE}: ${result.reason}`);
      console.error("The existing restore points have been left untouched.");
      return 1;
    case "failed":
      console.error(`Backup verification failed for ${result.name}: ${result.reason}`);
      console.error("Removed the bad file and kept the previous restore points.");
      return 1;
    case "skipped":
      console.log(`No change since ${result.since} — skipped.`);
      return 0;
    default: {
      const kb = (result.bytes / 1024).toFixed(1);
      console.log(`Backed up ${kb} KB / ${result.slices} slices → ${result.target}`);
      if (result.pruned > 0) {
        console.log(`Pruned ${result.pruned} old restore point${result.pruned === 1 ? "" : "s"}.`);
      }
      console.log(`${result.kept} restore point(s) in ${result.dir}`);
      return 0;
    }
  }
}

// CLI only when run directly — importing this module (the server does) must not
// parse argv or exit the process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Backup failed: ${err.message}`);
      process.exit(1);
    });
}
