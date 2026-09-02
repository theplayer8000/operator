// The logs Operator writes, readable from Operator.
//
// ## Why this exists
//
// The owner's complaint, twice: *"move the console to somewhere entirely like a
// collective log console I guess. but truncate it"*. The first time that was
// answered by HIDING the console windows, which stopped them cluttering the
// desktop and also stopped anyone reading them. Then the desktop shell started
// writing its own file and there were two logs, neither visible.
//
// A log nobody can read is a log that only helps whoever is sitting at the
// machine with a terminal open — which is exactly the person who least needs
// it. He reviews from a phone.
//
// ## A fixed list, not a path parameter
//
// `dev.mjs` already has a sandboxed repo browser and this deliberately does not
// reuse it. These are **named** logs — a closed set, resolved here, with no
// caller-supplied path anywhere. A log viewer that takes a filename is a file
// reader wearing a smaller hat, and `data/` holds the store, the backups and
// the push subscriptions.
//
// ## Truncated, because he asked and because it is right
//
// Tail only. `serve.log` grows for as long as the server runs, and a phone
// asking for the whole thing over the tailnet would be slow in the exact moment
// something is going wrong and it is being read.
//
// No dependencies.

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every log that can be read, by name.
 *
 * Adding one is a deliberate act here rather than something a caller can do by
 * asking for a different path.
 */
const LOGS = {
  server: {
    label: "Server",
    path: join(ROOT, "data", "serve.log"),
    what: "The storage API, jobs, voice, and everything server-side.",
  },
  shell: {
    label: "Desktop shell",
    path: join(ROOT, "data", "shell.log"),
    what: "The Tauri window: hotkeys, summon, the tray. Has no console of its own.",
  },
};

/** How many lines a tail returns. Enough to see a failure, not a document. */
const DEFAULT_LINES = 120;
/**
 * How much of the end of the file to read.
 *
 * Read from the END rather than parsing the whole thing: `serve.log` runs to
 * megabytes on a long-lived server, and reading it entirely to show the last
 * hundred lines would make the viewer slowest exactly when it matters.
 */
const TAIL_BYTES = 256 * 1024;

export function listLogs() {
  return Object.entries(LOGS).map(([id, l]) => ({ id, label: l.label, what: l.what }));
}

/**
 * The last `lines` lines of one named log.
 *
 * A missing file is not an error — the shell log does not exist until the
 * desktop app has run once, and reporting that as a failure would make a normal
 * state look broken.
 */
export async function tailLog(id, lines = DEFAULT_LINES) {
  const entry = LOGS[id];
  if (!entry) throw new Error(`no log called "${id}"`);

  let size = 0;
  try {
    size = (await stat(entry.path)).size;
  } catch {
    return { id, label: entry.label, missing: true, lines: [], bytes: 0 };
  }

  const handle = await readFile(entry.path);
  const slice = handle.subarray(Math.max(0, handle.length - TAIL_BYTES)).toString("utf8");
  const all = slice.split(/\r?\n/).filter((l) => l.length > 0);
  const wanted = Math.max(1, Math.min(500, Number(lines) || DEFAULT_LINES));

  return {
    id,
    label: entry.label,
    missing: false,
    bytes: size,
    /*
      Reported so the viewer can say "showing the last 120 of 4,812" rather
      than implying this is everything. A truncated log that looks complete is
      how someone concludes a thing never happened.
    */
    totalLines: all.length,
    lines: all.slice(-wanted),
  };
}
