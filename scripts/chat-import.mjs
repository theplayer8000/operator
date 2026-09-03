#!/usr/bin/env node
// Turn the conversations you kept into vault notes.
//
//   node scripts/chat-import.mjs --manifest <manifest.json> --export <folder>
//   node scripts/chat-import.mjs --manifest m.json --export D:/Framework/… --write
//
// ## It reads `keep` and nothing else
//
// `unreviewed` is not a decision. `unsure` is a decision to decide later. Both
// are excluded, and that separation is the entire reason the triage step exists
// — importing what you had not got to yet is exactly what it was built to
// prevent.
//
// ## Running it twice is safe by construction, not by luck
//
// Every note records `source: chatgpt:<conversation_id>`, and a conversation
// whose id already appears as a source is skipped. That id comes from ChatGPT
// and is stable across exports.
//
// It deliberately does NOT dedupe on title the way `knowledge-import.mjs` does
// for documents. Extraction is non-deterministic: the same conversation
// summarised twice produces differently-worded titles that slide straight past
// a title check, so a title-keyed importer would quietly double the vault on a
// re-run. The owner flagged this before a line of it was written.
//
// ## The parser is the triage tool's own
//
// `tools/vault-triage/index.html` holds the only implementation of how a
// ChatGPT export is read, and this pulls the functions out of that file rather
// than keeping a second copy. A copy would drift — and the failure mode is
// silent, because both would still "work" while disagreeing about what a
// conversation contains.
//
// No dependencies.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { delegate } from "../server/delegate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.OPERATOR_URL ?? "http://127.0.0.1:5174";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const WRITE = has("--write");
const MANIFEST = val("--manifest");
const EXPORT = val("--export");
const LIMIT = Number(val("--limit") || 0) || Infinity;
const WORKER = val("--worker");

if (!MANIFEST || !EXPORT) {
  console.error(
    "usage: node scripts/chat-import.mjs --manifest <manifest.json> --export <export folder> [--write] [--limit N]",
  );
  process.exit(2);
}

// --- the triage tool's parser, borrowed rather than copied -------------------

async function loadParser() {
  const html = await readFile(join(ROOT, "tools/vault-triage/index.html"), "utf8");
  const grab = (name) => {
    const start = html.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`vault-triage/index.html has no ${name}()`);
    let depth = 0;
    let open = false;
    for (let i = start; i < html.length; i++) {
      if (html[i] === "{") { depth++; open = true; }
      else if (html[i] === "}") {
        depth--;
        if (open && depth === 0) return html.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated ${name}() in vault-triage/index.html`);
  };
  const src = [
    "const CONTENT_KINDS = { text: true, multimodal_text: true };",
    "const ASIDE_KINDS = { thoughts: true, reasoning_recap: true };",
    grab("isConversation"),
    grab("linearise"),
    grab("partsToText"),
    grab("parseConversation"),
    grab("extractConversations"),
    "return { parseConversation, extractConversations };",
  ].join("\n\n");
  return new Function(src)();
}

// --- the API ----------------------------------------------------------------

async function callAction(action, params = {}) {
  const res = await fetch(`${BASE}/api/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.OPERATOR_TOKEN ? { authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } : {}),
    },
    body: JSON.stringify({ action, params }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${action} failed (${res.status})`);
  return body?.result ?? body;
}

// --- chunking ---------------------------------------------------------------

/*
  How much conversation goes into one extraction call.

  AI Router's window is 262K tokens, so this is not a model limit — it is an
  ATTENTION limit. A 700-message conversation handed over whole comes back with
  four notes about the first tenth of it, because that is where the model's
  attention went. Smaller windows get the whole thing read.

  Split on message boundaries, never mid-message: half an answer produces a
  note that confidently states half a fact.
*/
const CHUNK_CHARS = 45_000;

function chunk(messages) {
  const out = [];
  let current = [];
  let size = 0;
  for (const m of messages) {
    const line = `${m.role.toUpperCase()}: ${m.text}`;
    if (size + line.length > CHUNK_CHARS && current.length) {
      out.push(current);
      /*
        Two messages of overlap.

        A fact often spans the boundary — you ask at the end of one window and
        the answer opens the next — and without overlap that fact is in neither
        chunk's view. Two is enough for a question/answer pair and cheap.
      */
      current = current.slice(-2);
      size = current.reduce((n, x) => n + x.length, 0);
    }
    current.push(line);
    size += line.length;
  }
  if (current.length) out.push(current);
  return out.map((c) => c.join("\n\n"));
}

// --- the instruction --------------------------------------------------------

const RULES = [
  "Extract durable, reusable FACTS from this conversation into notes for a personal knowledge vault.",
  "",
  "Return ONLY a JSON array, no prose, no markdown fence. Each item:",
  '  {"title": string, "body": string, "kind": "note"|"command"|"resource", "topics": string[]}',
  "",
  "Rules:",
  "- A note is something worth looking up again months later. Most of a chat is not.",
  "- Every note must STAND ALONE. The reader has not seen this conversation and cannot.",
  "  Never write 'as discussed', 'the above', or 'this approach'.",
  "- Keep the SPECIFICS — exact commands, versions, paths, numbers, model names, prices.",
  "  A fact with the numbers removed is an opinion.",
  "- Extract what was ESTABLISHED, not what was asked. A question the conversation never",
  "  answered is not knowledge.",
  "- Skip anything that was only true at the time: prices quoted in passing, 'try this and",
  "  see', debugging that led nowhere, and anything the conversation itself later corrected.",
  '- kind "command" for something to run, "resource" for a pointer outwards, "note" otherwise.',
  "- topics: 2-4 lowercase single words.",
  "- Prefer 2 good notes to 10 thin ones. An empty array is a valid and common answer —",
  "  most conversations contain nothing worth keeping, and saying so is correct.",
];

function instructionFor(vocabulary, title) {
  return [
    ...RULES,
    "",
    `This conversation was titled: ${title}`,
    vocabulary.length
      ? `\nTopics already in the vault — prefer these over inventing near-synonyms:\n${vocabulary.slice(0, 60).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseNotes(text) {
  const t = String(text ?? "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("[");
  const b = body.lastIndexOf("]");
  if (a === -1 || b <= a) return null;
  try {
    const parsed = JSON.parse(body.slice(a, b + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const titleKey = (t) =>
  String(t ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2).sort().join(" ");

// --- main -------------------------------------------------------------------

const { parseConversation, extractConversations } = await loadParser();

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const keeps = (manifest.chats || []).filter((c) => c.decision === "keep");
if (keeps.length === 0) {
  console.error("Nothing marked keep in that manifest.");
  process.exit(1);
}
const keepIds = new Map(keeps.map((c) => [c.id, c]));

// Load the conversations themselves out of the export.
const files = (await readdir(EXPORT)).filter(
  (f) => f.endsWith(".json") && !/manifest|asset_file_names/i.test(f),
);
const byId = new Map();
for (const f of files) {
  for (const raw of extractConversations(f, await readFile(join(EXPORT, f), "utf8"))) {
    const c = parseConversation(raw, f);
    if (keepIds.has(c.id)) byId.set(c.id, c);
  }
}

// What the vault already holds, so a second run is a no-op.
const state = await (await fetch(`${BASE}/api/state`)).json().catch(() => null);
if (!state) {
  console.error(`Cannot reach Operator at ${BASE} — start it first (npm run serve).`);
  process.exit(1);
}
const existing = state?.state?.["knowledge.notes"] ?? [];
const importedIds = new Set(
  existing.map((n) => n.source).filter((s) => typeof s === "string" && s.startsWith("chatgpt:")),
);
const seenTitles = new Set(existing.map((n) => titleKey(n.title)));
const topicCounts = new Map();
for (const n of existing) for (const t of n.topics ?? []) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
const vocabulary = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

const missing = keeps.filter((c) => !byId.has(c.id)).length;
const already = keeps.filter((c) => importedIds.has(`chatgpt:${c.id}`)).length;
const pending = keeps.filter((c) => byId.has(c.id) && !importedIds.has(`chatgpt:${c.id}`));
const todo = pending.slice(0, LIMIT);

/*
  Counted, not inferred.

  The first version derived "already imported" by subtracting what it was about
  to do from the total — which reported 65 already imported on a run where
  nothing had been imported at all, because `--limit 2` had truncated the list.
  A number that changes meaning when you pass a flag is not a number.
*/
console.log(
  `${keeps.length} kept · ${already} already imported · ${missing} not in the export · ` +
    `${pending.length} to do` +
    (todo.length < pending.length ? ` (limited to ${todo.length})` : "") +
    (WRITE ? "" : "  — DRY RUN, pass --write"),
);
console.log(`${existing.length} notes in the vault, ${vocabulary.length} topics\n`);

let created = 0;
let skipped = 0;

for (const [index, entry] of todo.entries()) {
  const convo = byId.get(entry.id);
  const real = convo.messages.filter((m) => !m.aside);
  const windows = chunk(real);

  console.log(
    `[${index + 1}/${todo.length}] ${convo.title}  (${real.length} msg, ${windows.length} window(s))`,
  );

  for (const [w, text] of windows.entries()) {
    let reply;
    try {
      reply = await delegate({
        task: `${instructionFor(vocabulary, convo.title)}\n\n--- CONVERSATION ---\n${text}`,
        worker: WORKER,
      });
    } catch (err) {
      console.warn(`   ! window ${w + 1}: ${String(err?.message ?? err)}`);
      continue;
    }

    const notes = parseNotes(reply.text);
    if (!notes) {
      console.warn(
        `   ! window ${w + 1}: no JSON array in the reply (${reply.text.length} chars): ` +
          JSON.stringify(reply.text.slice(0, 160)),
      );
      continue;
    }

    for (const note of notes) {
      if (!note?.title || typeof note.title !== "string") continue;
      const key = titleKey(note.title);
      if (seenTitles.has(key)) { skipped++; console.log(`   = ${note.title}`); continue; }
      seenTitles.add(key);
      console.log(`   + ${note.title}`);
      if (!WRITE) continue;
      try {
        await callAction("knowledge_add", {
          title: note.title,
          body: String(note.body ?? ""),
          kind: ["note", "command", "resource"].includes(note.kind) ? note.kind : "note",
          /*
            Unverified, always. A model's reading of a conversation you had
            months ago is two removes from checked: the conversation may have
            been wrong, and the summary may have compressed the caveat out.
          */
          confidence: "unverified",
          topics: Array.isArray(note.topics) ? note.topics.slice(0, 4) : [],
          // The idempotency key AND the provenance. Every note points back at
          // the conversation it came from.
          source: `chatgpt:${entry.id}`,
        });
        created++;
      } catch (err) {
        console.warn(`   ! failed to write: ${String(err?.message ?? err)}`);
      }
    }
  }
}

console.log(
  `\n${created} note(s) written · ${skipped} skipped as duplicates` +
    (WRITE ? "" : " — nothing written (dry run)"),
);
if (WRITE && created > 0) {
  console.log("Run `node scripts/knowledge-import.mjs --link --write` to connect them.");
}
