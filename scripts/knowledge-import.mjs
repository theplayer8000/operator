#!/usr/bin/env node
// Fill the Knowledge Vault from documents that already exist.
//
//   node scripts/knowledge-import.mjs                 # dry run over docs/
//   node scripts/knowledge-import.mjs --write
//   node scripts/knowledge-import.mjs --from reference --write
//   node scripts/knowledge-import.mjs --file docs/known-issues.md --write
//   node scripts/knowledge-import.mjs --link --write         # connect what is there
//   node scripts/knowledge-import.mjs --tidy-topics --write  # merge spellings
//   node scripts/knowledge-import.mjs --cluster --write      # consolidate by MEANING
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


/**
 * Fold the topic list back into something that groups.
 *
 * ## The number that says it is broken
 *
 * Measured after the full import: 313 notes carrying 408 topics, 252 of them
 * used exactly ONCE. A topic used once groups nothing — it is a word attached
 * to a note, indistinguishable from the note's own text, and 252 of them in
 * the filter row is a wall you cannot read past. More topics than notes is the
 * signal; it can only mean each document invented its own vocabulary.
 *
 * ## Two passes, in this order, and the order matters
 *
 * **Merge variants first.** `commands` and `command`, `control-plane` and
 * `controlplane`, `apis` and `api` are the same topic spelled differently, and
 * merging them can lift a singleton into a real group. Doing the drop first
 * would delete exactly those before they had the chance.
 *
 * The winner is the MORE COMMON spelling, not the shorter one — the vault's
 * own usage decides, rather than a rule about plurals that gets `status` wrong.
 *
 * **Then drop what is still used once**, and only from a note that keeps at
 * least one topic. A note stripped bare is worse than a note with a useless
 * tag: it drops out of every topic filter entirely, and the link pass reads
 * topics too.
 *
 * ## Why not ask a model
 *
 * Because this is arithmetic on strings and a model would occasionally decide
 * `auth` and `authorization` are different, or that two genuinely distinct
 * topics are one. The rules below are dull and inspectable, and `--dry-run` is
 * the default so the merge list is read before it is applied.
 */
async function tidyTopics() {
  const stateRes = await fetch(`${BASE}/api/state`);
  const state = await stateRes.json();
  const notes = (state?.state?.["knowledge.notes"] ?? []).filter((n) => !n.archived);

  const count = new Map();
  for (const note of notes) {
    for (const topic of note.topics ?? []) count.set(topic, (count.get(topic) ?? 0) + 1);
  }

  /*
    The shape two spellings of one topic share. Hyphens and underscores go,
    and a trailing "s" goes — crude, and right far more often than not on a
    vocabulary of single technical words.
  */
  const shape = (topic) => {
    const joined = topic.replace(/[-_\s]/g, "");
    /*
      The plural rule only applies to words long enough for it to be safe.

      Caught in a dry run: `https` and `http` are not two spellings of one
      topic, and a blanket trailing-s strip merged them. Requiring five
      characters before the "s" blocks that (http is four) while keeping every
      case worth having — token/tokens, agent/agents, provider/providers.

      The cost is that bug/bugs stay separate. That is the right side to err
      on: two topics that should be one is untidy, one topic that should be two
      is wrong.
    */
    return joined.length >= 6 && joined.endsWith("s") ? joined.slice(0, -1) : joined;
  };

  const byShape = new Map();
  for (const [topic, n] of count) {
    const key = shape(topic);
    const list = byShape.get(key) ?? [];
    list.push([topic, n]);
    byShape.set(key, list);
  }

  /** topic → what it should become. */
  const merge = new Map();
  for (const variants of byShape.values()) {
    if (variants.length < 2) continue;
    /*
      The vault's own usage picks the winner. Ties break towards the HYPHENATED
      spelling, not the shorter one — shortest-wins turned `control-plane` into
      `controlplane` and `threat-model` into `threatmodel`, which is nobody's
      preferred spelling and reads as a typo in the filter row.
    */
    const hyphenated = (t) => (/[-_]/.test(t) ? 0 : 1);
    variants.sort(
      (a, b) => b[1] - a[1] || hyphenated(a[0]) - hyphenated(b[0]) || a[0].length - b[0].length,
    );
    const [winner] = variants[0];
    for (const [topic] of variants.slice(1)) merge.set(topic, winner);
  }

  // Recount as if the merges had happened, so a topic that only reaches two
  // uses BY merging is correctly kept.
  const merged = new Map();
  for (const [topic, n] of count) {
    const target = merge.get(topic) ?? topic;
    merged.set(target, (merged.get(target) ?? 0) + n);
  }

  const changes = [];
  for (const note of notes) {
    const before = note.topics ?? [];
    const remapped = [...new Set(before.map((t) => merge.get(t) ?? t))];
    /*
      Keep anything used more than once. Then, if that emptied the note, keep
      its single most common original topic rather than leaving it bare — a
      note with no topics falls out of every filter and out of the link pass.
    */
    let kept = remapped.filter((t) => (merged.get(t) ?? 0) > 1);
    if (kept.length === 0 && remapped.length > 0) {
      kept = [remapped.sort((a, b) => (merged.get(b) ?? 0) - (merged.get(a) ?? 0))[0]];
    }
    if (kept.length !== before.length || kept.some((t, i) => t !== before[i])) {
      changes.push({ id: note.id, title: note.title, before, after: kept });
    }
  }

  const survivors = new Set(changes.flatMap((c) => c.after));
  for (const note of notes) for (const t of note.topics ?? []) if ((merged.get(t) ?? 0) > 1) survivors.add(t);

  console.log(
    `${count.size} topics → about ${survivors.size} · ${merge.size} merged · ` +
      `${changes.length} note(s) change` +
      (WRITE ? "" : " — nothing written (dry run)"),
  );
  if (merge.size > 0) {
    console.log("\nmerges:");
    for (const [from, to] of [...merge].slice(0, 30)) console.log(`  ${from} → ${to}`);
  }

  if (!WRITE) return;

  let written = 0;
  for (const change of changes) {
    try {
      await callAction("knowledge_update", { id: change.id, topics: change.after });
      written += 1;
    } catch (err) {
      console.warn(`  ! ${change.title}: ${String(err?.message ?? err)}`);
    }
  }
  console.log(`\n${written} note(s) updated`);
}


/**
 * Consolidate topics by MEANING — map to a cluster, or drop.
 *
 * ## Why this is a model's job when `--tidy-topics` deliberately is not
 *
 * That pass merges SPELLINGS: `control-plane` and `controlplane` are the same
 * word twice, which is string arithmetic and inspectable, and a model asked to
 * do it would occasionally decide `auth` and `authorization` are different.
 *
 * This is a different question. `npmrc` and `lavamoat` are not misspellings of
 * `tooling`; deciding they belong with it is a judgment about meaning, and no
 * amount of string comparison reaches it. So the rule from the owner:
 *
 *   > a singleton that genuinely belongs nowhere shouldn't be force-merged
 *   > just to hit a number; the rule should be "maps to an existing cluster,
 *   > or it dies".
 *
 * Both halves matter. Force-merging every rare topic into its nearest neighbour
 * makes the count look good and quietly files a genuine one-off — `42crunch`,
 * say — under something it has nothing to do with, which is worse than dropping
 * it: a wrong topic is followed, a missing one is only absent.
 *
 * ## Anchors are the vault's own vocabulary, not a fixed list
 *
 * A cluster is a topic the vault ALREADY uses enough to mean something. Nothing
 * here invents a taxonomy — the candidates move towards what is already there,
 * or they go. That also makes this safe to re-run: as the vault grows, more
 * topics qualify as anchors and fewer candidates die.
 *
 * ## The cheat sheet is a head start, NOT ground truth
 *
 * The vault contains a note mapping vocabulary to clusters. It is worth passing
 * in — it is a real map of this material and costs a few hundred tokens, so the
 * model starts from it rather than rediscovering it worse.
 *
 * But **Operator wrote it, not the owner**, which was worth getting right: the
 * first version of this called it "his own judgment about his own material" and
 * told the model it was authoritative. It is a model's summary of a model's
 * notes — exactly the class of claim the `unverified` confidence level exists
 * to mark — and promoting it to ground truth inside a prompt launders a guess
 * into a rule. It is offered as a starting point and the model may disagree
 * with it.
 */
async function clusterTopics() {
  const stateRes = await fetch(`${BASE}/api/state`);
  const state = await stateRes.json();
  const notes = (state?.state?.["knowledge.notes"] ?? []).filter((n) => !n.archived);

  const count = new Map();
  for (const note of notes) {
    for (const topic of note.topics ?? []) count.set(topic, (count.get(topic) ?? 0) + 1);
  }

  /** Used enough to be a real grouping. */
  const MIN_ANCHOR = Number(valueOf("--anchor") || 5);
  /** Rare enough to be worth questioning. */
  const MAX_CANDIDATE = Number(valueOf("--rare") || 3);

  const anchors = [...count.entries()]
    .filter(([, n]) => n >= MIN_ANCHOR)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  const candidates = [...count.entries()]
    .filter(([, n]) => n <= MAX_CANDIDATE)
    .sort((a, b) => a[1] - b[1])
    .map(([t]) => t);

  if (anchors.length === 0 || candidates.length === 0) {
    console.log("Nothing to consolidate — the vault has no clear clusters yet.");
    return;
  }

  console.log(
    `${anchors.length} anchor topic(s) (used ${MIN_ANCHOR}+) · ` +
      `${candidates.length} candidate(s) (used ${MAX_CANDIDATE} or fewer)\n`,
  );

  // A prior map of this vocabulary, if the vault holds one. A starting point
  // rather than an authority — see the header. Written by Operator, unverified
  // like everything else it wrote.
  const cheatSheet = notes.find((n) => /cheat sheet/i.test(n.title));

  /** candidate → anchor, or null for "belongs nowhere". */
  const mapping = new Map();
  const CHUNK = 40;

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const batch = candidates.slice(i, i + CHUNK);
    const task = [
      "You are consolidating the topic tags of a personal knowledge vault.",
      "",
      "For each CANDIDATE topic, decide which ANCHOR topic it belongs under.",
      "",
      "Return ONLY a JSON object mapping candidate to anchor, no prose, no fence:",
      '  {"npmrc": "tooling", "42crunch": null}',
      "",
      "Rules:",
      "- The value MUST be one of the anchors listed, spelled exactly, or null.",
      "- null means it genuinely belongs under none of them. USE IT. A topic filed",
      "  under something it has nothing to do with is worse than one that is dropped:",
      "  a wrong tag gets followed, a missing one is merely absent.",
      "- Map only when the candidate is a NARROWER CASE of the anchor, or a synonym.",
      "  Do not map two things that merely appear in the same document.",
      "- Never map a candidate to another candidate.",
      "",
      cheatSheet
        ? `The owner's own vocabulary map, which is authoritative where it applies:\n${cheatSheet.body}\n`
        : "",
      `ANCHORS: ${anchors.join(", ")}`,
      "",
      `CANDIDATES: ${batch.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");

    let reply;
    try {
      reply = await delegate({ task, worker: WORKER });
    } catch (err) {
      console.warn(`! batch ${i / CHUNK + 1}: ${String(err?.message ?? err)}`);
      continue;
    }

    const text = String(reply.text ?? "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let parsed = null;
    try {
      parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      /*
        Print what actually came back.

        "Could not read a JSON object" on its own is the same dead end as every
        other silent failure this project has been bitten by — it says the
        parse failed and nothing about why, so the next step is guessing. The
        head of the reply is almost always enough: a fence, a preamble, or the
        model having answered a different question entirely.
      */
      console.warn(
        `! batch ${i / CHUNK + 1}: could not read a JSON object out of the reply.
` +
          `  got ${text.length} chars: ${JSON.stringify(text.slice(0, 400))}`,
      );
      continue;
    }

    const anchorSet = new Set(anchors);
    for (const [candidate, target] of Object.entries(parsed)) {
      if (!count.has(candidate)) continue;
      /*
        Validated against the anchor list rather than trusted. A model asked for
        one of N answers will occasionally invent an N+1th, and an invented
        anchor would create the exact fragmentation this pass exists to remove.
      */
      mapping.set(candidate, anchorSet.has(target) ? target : null);
    }
    console.log(`  batch ${i / CHUNK + 1}/${Math.ceil(candidates.length / CHUNK)} — ${reply.ms}ms`);
  }

  const mapped = [...mapping].filter(([, to]) => to);
  const dying = [...mapping].filter(([, to]) => !to).map(([from]) => from);

  console.log(`\n${mapped.length} mapped:`);
  for (const [from, to] of mapped.slice(0, 40)) console.log(`  ${from} → ${to}`);
  console.log(`\n${dying.length} belong nowhere and will be dropped:`);
  console.log(`  ${dying.join(", ")}`);

  // Apply.
  let changed = 0;
  let bare = 0;
  for (const note of notes) {
    const before = note.topics ?? [];
    const after = [
      ...new Set(
        before
          .map((t) => (mapping.has(t) ? mapping.get(t) : t))
          .filter((t) => typeof t === "string" && t.length > 0),
      ),
    ];
    if (after.length === before.length && after.every((t, i) => t === before[i])) continue;
    changed += 1;
    if (after.length === 0) bare += 1;
    if (!WRITE) continue;
    try {
      await callAction("knowledge_update", { id: note.id, topics: after });
    } catch (err) {
      console.warn(`  ! ${note.title}: ${String(err?.message ?? err)}`);
    }
  }

  /*
    Bare notes are reported, not prevented.

    `--tidy-topics` protects against them because at that point topics were the
    only way to reach a note. They are not any more: the link pass has given the
    vault 1,600+ edges, so a note with no topic is still reachable by following
    one. "Or it dies" is the owner's rule and this is where it is allowed to
    bite — but silently emptying notes is not something to discover later.
  */
  console.log(
    `\n${changed} note(s) change` +
      (bare ? `, ${bare} left with no topic (reachable by link)` : "") +
      (WRITE ? "" : " — nothing written (dry run)"),
  );
}

async function main() {
  if (has("--link")) return linkPass();
  if (has("--cluster")) return clusterTopics();
  if (has("--tidy-topics")) return tidyTopics();

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
