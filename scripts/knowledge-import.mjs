#!/usr/bin/env node
// Fill the Knowledge Vault from documents that already exist.
//
//   node scripts/knowledge-import.mjs                 # dry run over docs/
//   node scripts/knowledge-import.mjs --write
//   node scripts/knowledge-import.mjs --from reference --write
//   node scripts/knowledge-import.mjs --file docs/known-issues.md --write
//   node scripts/knowledge-import.mjs --link --write   # connect what is already there
//
// ## Extraction, not copying
//
// The obvious version of this walks the markdown and makes one note per file.
// That produces a vault of documents, which is what the filesystem already is
// — and searching it returns "architecture.md" for every query because a long
// document mentions everything.
//
// A note is ONE thing you would want back. "The node on PATH shadows the real
// binary and fails silently" is a note. `docs/development.md` is not. So a
// model reads each document and writes the discrete, reusable facts out of it,
// which is work worth paying a model for and exactly what `delegate.mjs` is.
//
// ## Everything lands UNVERIFIED, whatever the source claims
//
// Non-negotiable, and it is the whole reason the confidence field exists. A
// model's summary of a document is a claim about a claim: the doc may be
// stale, the model may have compressed a caveat away, and neither of those is
// visible in the result. An imported note says "somebody wrote this down
// once", because that is exactly what it is.
//
// Raising it to `verified` is a human act — you re-checked it — and the field
// means nothing at all if an importer can grant itself the top value.
//
// ## Why this source first
//
// Because it needs no permission from anyone. `docs/` is the owner's own
// repository on the owner's own disk, going to a worker already approved for
// project files (ADR 0016's 2026-09-02 amendment names `delegate.mjs`
// explicitly). Importing his ChatGPT or Claude history is a genuinely
// different decision — a different host's export, years of it, most of it not
// knowledge — and it needs asking for by name before any of it moves.
//
// ## Writes go through the API, never through actions.mjs directly
//
// This got it wrong first time and the failure was silent, which is the point
// worth recording. `data/operator.json` is held in the SERVER's memory while it
// runs, so a second process importing `runAction` and calling it writes into
// its own copy — and the server's next save overwrites the file with a version
// that never saw any of it. The import printed forty happy green lines and the
// vault stayed at three notes.
//
// `CLAUDE.md` documents exactly this for `scripts/log-update.mjs` ("the script
// goes through the API on purpose"). Reading it as being about the changelog
// rather than about every out-of-process writer is how it got repeated.
//
// No dependencies.

import { readFile, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { delegate } from "../server/delegate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const BASE = process.env.OPERATOR_URL ?? "http://127.0.0.1:5174";

/**
 * Run one capability action through the running server.
 *
 * The same route `scripts/operator-action.mjs` uses, and for the same reason —
 * see the header. Loopback is trusted by `auth.mjs`, so no token is needed
 * when this runs on the box, which is the only place it makes sense to run.
 */
async function callAction(action, params = {}) {
  const res = await fetch(`${BASE}/api/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.OPERATOR_TOKEN
        ? { authorization: `Bearer ${process.env.OPERATOR_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ action, params }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `${action} failed (${res.status}) — is the server running?`);
  }
  return body?.result ?? body;
}

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const WRITE = has("--write");
const LIMIT = Number(valueOf("--limit") || 0) || Infinity;
const WORKER = valueOf("--worker");
const ONE_FILE = valueOf("--file");
const FROM = valueOf("--from") || "docs";

/**
 * The instruction, and most of the quality lives here.
 *
 * Three things it insists on, each because the obvious output is wrong:
 *
 *   - A note must stand ALONE. "This is why it was done that way" is useless
 *     out of context, and out of context is where it will be read.
 *   - No summarising the document. A summary of an architecture doc is a
 *     worse architecture doc; the vault wants the facts inside it.
 *   - Skip anything that is only true of this document's own structure.
 *     "The file has ten sections" is not knowledge.
 */
const INSTRUCTION_LINES = [
  "Extract the reusable FACTS from this document into notes for a personal knowledge vault.",
  "",
  "Return ONLY a JSON array, no prose before or after, no markdown fence. Each item:",
  '  {"title": string, "body": string, "kind": "note"|"command"|"resource", "topics": string[]}',
  "",
  "Rules:",
  "- One fact per note. A note is something worth looking up on its own.",
  "- Every note must STAND ALONE. Someone reading it a year from now has not read this",
  "  document and cannot see it. Never write 'as described above' or 'this approach'.",
  "- Title: what you would type into a search box to find it again. Not a heading.",
  "- Body: the fact, plus WHY when the why is what makes it useful. Keep the specifics —",
  "  exact commands, exact paths, exact numbers. A fact with the numbers removed is an",
  "  opinion.",
  '- kind "command" when the note is something to run. "resource" when it is a pointer',
  '  outwards. "note" otherwise.',
  "- topics: 2-4 lowercase single words.",
  "- REUSE the existing topics below wherever one fits. Inventing a near-synonym",
  "  ('storage' next to 'store', 'auth' next to 'authentication') is how a topic list",
  "  ends up longer than the note list and stops grouping anything at all.",
  "- Skip anything only true of this document's own structure, and anything that is",
  "  a to-do rather than a fact.",
  "- Prefer 3 good notes to 15 thin ones. An empty array is a valid answer.",
];

/**
 * The instruction, with the vault's CURRENT topic vocabulary appended.
 *
 * Measured after the first full import: 130 notes carrying 195 distinct topics.
 * More topics than notes means every note invented its own, which is the same
 * as having no topics — nothing groups, the filter row is unusable, and the
 * shared-topic linking below has nothing to work with.
 *
 * Showing the model what already exists is the whole fix. It costs a few
 * hundred tokens and turns a per-document vocabulary into a shared one.
 */
function instructionFor(topics) {
  if (topics.length === 0) return INSTRUCTION_LINES.join("\n");
  return [
    ...INSTRUCTION_LINES,
    "",
    "Topics already in use — prefer these over new ones:",
    topics.slice(0, 60).join(", "),
  ].join("\n");
}

/** Collect the markdown worth reading. */
async function sources() {
  if (ONE_FILE) return [ONE_FILE];

  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // Handoffs are a working note about work in progress, not knowledge —
        // and CURRENT.md is overwritten constantly, so importing it would
        // import a snapshot of something that is already stale.
        if (entry.name === "handoffs") continue;
        await walk(path);
      } else if (extname(entry.name) === ".md") {
        out.push(path);
      }
    }
  };
  await walk(FROM);
  return out.sort();
}

/**
 * Pull the JSON array out of whatever came back.
 *
 * Models add a fence or a sentence of preamble however firmly you ask them not
 * to, and failing the whole import over a stray "Here you go:" would be a bad
 * trade. Anything still unparseable after this is a real failure and is
 * reported per file rather than swallowed.
 */
function parseNotes(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;

  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Loose enough to catch a rephrasing, strict enough not to drop a real note. */
const titleKey = (title) =>
  String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .sort()
    .join(" ");

/**
 * Connect notes that clearly belong together.
 *
 * ## Why the importer cannot do this as it goes
 *
 * A note can only link to something that already exists, and extraction runs
 * one document at a time — so at the moment each note is written, most of what
 * it relates to has not been read yet. Linking has to be a second pass over
 * the finished set. That is also why it is a separate flag rather than
 * automatic: it is worth re-running after every import, not only after the
 * first.
 *
 * ## Two signals, both conservative
 *
 * **Shared topics.** Two notes carrying two or more of the same topics are
 * about the same thing. One shared topic is far too weak — "operator" appears
 * on a third of the vault — so the bar is two.
 *
 * **Same source document.** Facts extracted from one document were written
 * together by someone making a single argument, which is a real relationship
 * and the only one available for a note whose topics are unique. Capped hard,
 * because a twelve-note document would otherwise produce sixty-six edges and
 * a graph that is one solid blob.
 *
 * Nothing here invents a semantic link, and it deliberately does not ask a
 * model to. "These two feel related" from a model that has seen both titles
 * and neither body is a guess, and a wrong edge in a graph is worse than a
 * missing one — a missing edge is invisible, a wrong one is followed.
 */
async function linkPass() {
  const stateRes = await fetch(`${BASE}/api/state`);
  const state = await stateRes.json();
  const notes = (state?.state?.["knowledge.notes"] ?? []).filter((n) => !n.archived);

  if (notes.length < 2) {
    console.log("Not enough notes to link.");
    return;
  }

  /** How many edges any one note may gain here, so nothing becomes a hub. */
  const PER_NOTE = 4;
  const proposals = new Map();
  const add = (from, to) => {
    if (from === to) return;
    const list = proposals.get(from) ?? new Set();
    if (list.size >= PER_NOTE) return;
    list.add(to);
    proposals.set(from, list);
  };

  for (const note of notes) {
    const topics = new Set(note.topics ?? []);
    const already = new Set(note.links ?? []);

    const scored = notes
      .filter((other) => other.id !== note.id && !already.has(other.id))
      .map((other) => {
        const shared = (other.topics ?? []).filter((t) => topics.has(t)).length;
        const sameSource = Boolean(note.source) && note.source === other.source;
        // Topics beat provenance: two notes about the same subject from
        // different documents are a better edge than two unrelated facts that
        // happened to be written on the same page.
        return { other, score: shared >= 2 ? shared * 2 : sameSource ? 1 : 0 };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_NOTE);

    for (const { other } of scored) add(note.id, other.id);
  }

  let made = 0;
  for (const [from, targets] of proposals) {
    for (const to of targets) {
      if (!WRITE) {
        made += 1;
        continue;
      }
      try {
        await callAction("knowledge_link", { id: from, linkTo: to });
        made += 1;
      } catch (err) {
        console.warn(`  ! ${String(err?.message ?? err)}`);
      }
    }
  }

  const touched = proposals.size;
  console.log(
    `${made} link(s) across ${touched} note(s)` +
      (WRITE ? "" : " — nothing written (dry run)"),
  );
}

async function main() {
  if (has("--link")) return linkPass();

  const files = (await sources()).slice(0, LIMIT);
  if (files.length === 0) {
    console.error(`Nothing to read under ${FROM}`);
    process.exit(1);
  }

  /*
    Existing titles, so re-running is safe. An importer that duplicates its own
    output on the second run is an importer nobody runs twice.

    Read from the state endpoint rather than `knowledge_search`, which caps at
    25 — enough for a worker answering a question, not enough to dedupe against
    a full vault. Through the API either way: the server's in-memory copy is
    the only true one while it is running.
  */
  const stateRes = await fetch(`${BASE}/api/state`);
  if (!stateRes.ok) {
    throw new Error(`cannot reach the server at ${BASE} — start it first (npm run serve)`);
  }
  const state = await stateRes.json();
  const already = state?.state?.["knowledge.notes"] ?? [];
  const seen = new Set(already.map((n) => titleKey(n.title)));

  /*
    The topic vocabulary already in use, most common first, so the model can
    reuse it rather than inventing a synonym. See `instructionFor`.
  */
  const topicCounts = new Map();
  for (const note of already) {
    for (const topic of note.topics ?? []) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  }
  const vocabulary = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topic]) => topic);

  console.log(
    `${files.length} document(s) · ${seen.size} note(s) already in the vault · ` +
      `${WRITE ? "WRITING" : "dry run — pass --write to keep them"}\n`,
  );

  let proposed = 0;
  let written = 0;
  let skipped = 0;

  for (const file of files) {
    const body = await readFile(join(ROOT, file), "utf8").catch(() => "");
    // Not worth a round trip. A stub document has no facts in it.
    if (body.trim().length < 400) {
      console.log(`· ${file} — too short, skipped`);
      continue;
    }

    let result;
    try {
      result = await delegate({
        task: instructionFor(vocabulary),
        files: [join(ROOT, file)],
        worker: WORKER,
      });
    } catch (err) {
      console.warn(`! ${file} — ${String(err?.message ?? err)}`);
      continue;
    }

    const notes = parseNotes(result.text);
    if (!notes) {
      console.warn(`! ${file} — could not read a JSON array out of the reply`);
      continue;
    }

    console.log(`\n${file} — ${notes.length} note(s), ${result.ms}ms`);
    for (const note of notes) {
      if (!note?.title || typeof note.title !== "string") continue;
      const key = titleKey(note.title);
      if (seen.has(key)) {
        skipped += 1;
        console.log(`  = ${note.title}  (already have it)`);
        continue;
      }
      seen.add(key);
      proposed += 1;
      console.log(`  + ${note.title}`);

      if (WRITE) {
        try {
          await callAction("knowledge_add", {
            title: note.title,
            body: String(note.body ?? ""),
            kind: ["note", "command", "resource"].includes(note.kind) ? note.kind : "note",
            /*
              Always unverified. See the header — this is the one field an
              importer must not be able to set, because the value of the field
              is precisely that a person granted it.
            */
            confidence: "unverified",
            topics: Array.isArray(note.topics) ? note.topics.slice(0, 4) : [],
            source: relative(ROOT, join(ROOT, file)).replace(/\\/g, "/"),
          });
          written += 1;
        } catch (err) {
          console.warn(`    ! failed: ${String(err?.message ?? err)}`);
        }
      }
    }
  }

  console.log(
    `\n${proposed} new · ${skipped} already present · ` +
      (WRITE ? `${written} written` : "nothing written (dry run)"),
  );
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
