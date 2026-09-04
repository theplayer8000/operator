// The handoff — `docs/handoffs/`, reachable as a capability action.
//
// ## Why this is here and not left to the worker's Write tool
//
// CLAUDE.md has required a live handoff since restarts became a normal part of
// editing Operator: a restart destroys every job's event log, so a note on disk
// is the only thing that survives it. Claude Code could always write that file
// itself. It mostly did not, and the three reasons are all structural rather
// than a matter of remembering harder:
//
// 1. **Only one worker has a filesystem.** `gemini`, `airouter` and `ollama`
//    run with `tools: "capability-actions"` — no Write, no shell. They finish
//    work too, and until now they had no way to leave a note about it. A rule
//    that only one of four workers can obey is not a rule.
//
// 2. **The worker writes in the wrong checkout.** Jobs run in the `agent`
//    worktree (`OPERATOR_JOB_CWD`). The Updates page renders `main`'s copy,
//    because that is where the server process lives. So a handoff written by a
//    job was invisible on his phone until someone merged a branch — which
//    defeats the one thing the file exists for. Everything here resolves from
//    THIS file's location, so it always writes the copy the app reads,
//    whatever directory the caller happens to be in.
//
// 3. **It went through a tool that asks permission.** `Write` is pre-allowed,
//    but the fold is a rename plus a reset plus a naming convention, and every
//    step of that was a judgement call made at the end of a long turn.
//    `operator-action.mjs` is already pre-allowed and already validated.
//
// ## What it will not do
//
// **No delete.** Same bargain as the Knowledge Vault: a dated handoff is the
// record of a milestone and the least recoverable thing in the folder.
//
// **`write` REPLACES.** CLAUDE.md is explicit — "it is a working note, not a
// record: overwrite it rather than appending a log". An append-only CURRENT.md
// becomes a second changelog, and there is already a changelog.
//
// No dependencies. Node built-ins only, like everything in `server/` outside
// `runner.mjs`.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, taken from where this FILE is — deliberately not
 * `process.cwd()`.
 *
 * That is the whole of point 2 above in one line. A job's process is started
 * in the agent worktree, so a cwd-relative path would write the copy nobody
 * serves, succeed, and look right.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs", "handoffs");
const CURRENT = join(DIR, "CURRENT.md");

/** Prose, not a payload. Well past any real handoff, well short of a mistake. */
const MAX_CHARS = 100_000;

const DATED = /^(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]*)\.md$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What CURRENT.md is reset to after a fold.
 *
 * Says "nothing in flight" out loud rather than being blank, because CLAUDE.md
 * asks a session that finds it empty or stale to SAY so instead of guessing —
 * and an empty file is ambiguous between "nothing is in flight" and "the last
 * session left no note", which are opposite instructions.
 */
const EMPTY = `# Current work

Nothing in flight. The last milestone was folded into a dated file in this
folder — read the newest one for what landed.

## Next

_Nothing claimed._
`;

export class HandoffError extends Error {}

function localDate() {
  // Local time, like everything else the owner reads. `toISOString()` is UTC
  // and would file a 1am handoff under yesterday — OPS-009, in a new costume.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every dated handoff, newest first. The names sort chronologically by design. */
async function dated() {
  const names = await readdir(DIR);
  return names.filter((n) => DATED.test(n)).sort().reverse();
}

async function describe(name) {
  const info = await stat(join(DIR, name));
  return { name, updatedAt: info.mtime.toISOString(), bytes: info.size };
}

/**
 * Read the working note, or one dated handoff.
 *
 * `updatedAt` is included because staleness is the thing worth knowing about
 * this file and it is invisible in the text: a confident summary reconstructed
 * from a three-week-old note is worse than "the last session left nothing".
 */
export async function readHandoff({ name } = {}) {
  if (name && name !== "CURRENT" && name !== "CURRENT.md") {
    const file = name.endsWith(".md") ? name : `${name}.md`;
    if (!DATED.test(file)) {
      throw new HandoffError(
        `"${name}" is not a handoff name — they look like 2026-09-04-short-slug. Call handoff_read with no name for the current one.`,
      );
    }
    let text;
    try {
      text = await readFile(join(DIR, file), "utf8");
    } catch {
      throw new HandoffError(`no handoff called "${file}"`);
    }
    return { name: file, text, ...(await describe(file)) };
  }

  let text = "";
  let updatedAt = null;
  try {
    text = await readFile(CURRENT, "utf8");
    updatedAt = (await stat(CURRENT)).mtime.toISOString();
  } catch {
    text = "";
  }

  const recent = await dated();
  return {
    name: "CURRENT.md",
    text,
    updatedAt,
    inFlight: text.trim() !== "" && text.trim() !== EMPTY.trim(),
    milestones: recent.slice(0, 8),
  };
}

/**
 * Replace the working note.
 *
 * Deliberately the whole file rather than a section. Sections invite a worker
 * to patch around what is already there, and the failure mode of this file is
 * not missing detail — it is a stale note that reads as current.
 */
export async function writeHandoff({ body, text }) {
  const content = String(body ?? text ?? "");
  if (!content.trim()) {
    throw new HandoffError(
      "body is required — to clear the note, fold it into a dated handoff with handoff_fold instead",
    );
  }
  if (content.length > MAX_CHARS) {
    throw new HandoffError(
      `body is ${content.length} characters; the cap is ${MAX_CHARS}. A handoff is a working note — if it is genuinely this long, fold the finished part into a dated file first.`,
    );
  }
  const normalised = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(CURRENT, normalised, "utf8");
  return { wrote: "docs/handoffs/CURRENT.md", chars: normalised.length };
}

/**
 * Close out a milestone: CURRENT.md becomes `YYYY-MM-DD-<slug>.md`, and the
 * working note resets.
 *
 * Copy-then-reset rather than a rename, so the dated file is written and
 * verified before the only copy of the text stops being CURRENT.md. A crash
 * between the two leaves the milestone filed twice, which is recoverable; the
 * other order loses it.
 */
export async function foldHandoff({ slug, date, body }) {
  if (!slug) throw new HandoffError("slug is required — a short kebab-case name for the milestone");

  /*
    Tidied, not coerced — and the line between the two is where it goes wrong.

    Whitespace and underscores are formatting, so "voice latency" quietly
    becomes "voice-latency". A path character is a different INTENT, and
    stripping it silently is how `../evil` became the perfectly ordinary
    filename `evil` in this function's first version. It could not escape the
    folder — the character class saw to that — but a caller who passed a path
    got a file somewhere else entirely and no indication that anything had been
    reinterpreted. Refuse and say which character, the same bargain every other
    validator in the capability layer strikes.
  */
  const tidied = String(slug).trim().toLowerCase().replace(/\.md$/, "").replace(/[\s_]+/g, "-");
  const offending = tidied.match(/[^a-z0-9-]/);
  if (offending) {
    throw new HandoffError(
      `a slug is a short kebab-case name — "${slug}" contains "${offending[0]}". Letters, digits and hyphens only; the date is added for you.`,
    );
  }
  const clean = tidied.replace(/^-+|-+$/g, "");
  if (!SLUG.test(clean)) throw new HandoffError(`"${slug}" has no usable letters or digits in it`);

  const day = date ? String(date).trim() : localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HandoffError(`date must be YYYY-MM-DD, got "${date}"`);

  const name = `${day}-${clean}.md`;
  const target = join(DIR, name);

  /*
    Never overwrite an existing milestone. Two folds on the same day with the
    same slug is a mistake every time — either a retry after a failure that did
    not actually fail, or two sessions naming the same work the same thing —
    and the cost of guessing wrong is a milestone record silently replaced.
  */
  try {
    await stat(target);
    throw new HandoffError(
      `docs/handoffs/${name} already exists. Pick a different slug — nothing here is overwritten.`,
    );
  } catch (err) {
    if (err instanceof HandoffError) throw err;
    // ENOENT is the good case: the name is free.
  }

  let content = body ? String(body) : "";
  if (!content.trim()) {
    try {
      content = await readFile(CURRENT, "utf8");
    } catch {
      content = "";
    }
  }
  if (!content.trim() || content.trim() === EMPTY.trim()) {
    throw new HandoffError(
      "CURRENT.md has nothing in it to fold. Write the handoff first (handoff_write), or pass `body`.",
    );
  }
  if (content.length > MAX_CHARS) {
    throw new HandoffError(`body is ${content.length} characters; the cap is ${MAX_CHARS}`);
  }

  await writeFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await writeFile(CURRENT, EMPTY, "utf8");

  return {
    folded: `docs/handoffs/${name}`,
    reset: "docs/handoffs/CURRENT.md",
    /*
      Said in the result rather than left to be discovered. The folder is
      tracked, the server writes it, and NOTHING here commits — `git add -A` is
      banned in this repo for reasons that cost a revert, so a script sweeping
      up its own file would be the same mistake with better manners.
    */
    note: "written to the main checkout and not committed — stage docs/handoffs/ by name when you commit.",
  };
}

/** Every milestone on file, newest first. */
export async function listHandoffs({ limit = 15 } = {}) {
  const names = (await dated()).slice(0, Math.max(1, Math.min(Number(limit) || 15, 100)));
  return { count: names.length, milestones: await Promise.all(names.map(describe)) };
}
