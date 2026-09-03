import type { KnowledgeNote } from "@/lib/types";

/**
 * Finding a note.
 *
 * ## This is the Search Service boundary, and it is approved by name
 *
 * [ADR 0009](../../docs/decisions/0009-permitted-abstraction-boundaries.md)
 * permits exactly four abstractions, and one of them is a search service
 * described as "JSON scan → vector". This is the JSON scan. It exists as its
 * own module rather than as a filter inside `useKnowledge` so that the day it
 * becomes an embedding lookup, one file changes and no caller does.
 *
 * That ADR also warns against *extending* a permitted boundary because it is
 * already there, so the rule for this file is narrow: it answers "which of
 * these notes match this text", and it does not grow a query language, a
 * sort-order parameter, or a second entity type. A vault search that can also
 * search missions is a search service that has become a query layer.
 *
 * ## Why scoring rather than filtering
 *
 * A plain `includes()` returns everything containing the word in any position,
 * in whatever order the array happened to be in — so searching "docker" put a
 * note that mentions Docker once above the note called "Docker". Ranking is
 * most of what makes search feel like search, and it costs almost nothing at
 * this size.
 *
 * ## Honest about what it cannot do
 *
 * It matches WORDS. "How do I bring the database back up" will not find a note
 * called "restoring Postgres from a snapshot" unless they share vocabulary,
 * and no amount of tuning here fixes that — that is the vector search this
 * boundary exists to make possible later. The UI should not pretend otherwise.
 */

/** A note plus why it matched, so the UI can show the reason. */
export interface SearchHit {
  note: KnowledgeNote;
  score: number;
  /** Which field earned the highest points — shown as a hint in the results. */
  matched: "title" | "topic" | "body" | "source";
}

/**
 * Weights, ordered by how much a match in that field means.
 *
 * A title match is close to certain — nobody types a word into search hoping
 * to find a note whose title is that word by coincidence. A body match is the
 * weakest because a long note mentions many things in passing.
 */
const WEIGHT = { title: 12, topic: 7, source: 3, body: 1 } as const;

const normalise = (text: string) => text.toLowerCase().normalize("NFKD");

/**
 * Search the vault.
 *
 * @param notes  every note, archived included — the caller decides what to hide
 * @param query  what was typed
 * @param limit  how many hits to return at most
 */
export function searchNotes(notes: KnowledgeNote[], query: string, limit = 50): SearchHit[] {
  const terms = normalise(query)
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);

  // An empty query is not "no results" — it is "no filter". The vault should
  // show itself when you arrive rather than demanding a word first.
  if (terms.length === 0) {
    return notes.map((note) => ({ note, score: 0, matched: "title" as const }));
  }

  const hits: SearchHit[] = [];

  for (const note of notes) {
    const title = normalise(note.title);
    const body = normalise(note.body);
    const source = normalise(note.source ?? "");
    const topics = note.topics.map(normalise);

    let score = 0;
    let best: SearchHit["matched"] = "body";
    let bestPoints = 0;
    // Every term has to appear somewhere, so a two-word search narrows rather
    // than widens. Without this "docker restart" ranks a note about Docker
    // above one about restarting Docker, because it matched one term twice.
    let allPresent = true;

    for (const term of terms) {
      let points = 0;
      if (title.includes(term)) {
        // A whole-word title match beats a substring of one: searching "git"
        // should put "git worktrees" above "digital ocean".
        points = WEIGHT.title * (new RegExp(`\\b${term}`, "u").test(title) ? 1 : 0.5);
        if (points > bestPoints) [best, bestPoints] = ["title", points];
      }
      if (topics.some((t) => t.includes(term))) {
        const topicPoints = WEIGHT.topic;
        points += topicPoints;
        if (topicPoints > bestPoints) [best, bestPoints] = ["topic", topicPoints];
      }
      if (source.includes(term)) {
        points += WEIGHT.source;
        if (WEIGHT.source > bestPoints) [best, bestPoints] = ["source", WEIGHT.source];
      }
      if (body.includes(term)) {
        /*
          Diminishing, not linear. A note that says "docker" forty times is not
          forty times more about Docker than one that says it twice — usually
          it is just longer — and linear counting reliably floated the longest
          note in the vault to the top of every search.
        */
        const occurrences = body.split(term).length - 1;
        points += WEIGHT.body * (1 + Math.log2(occurrences));
        if (WEIGHT.body > bestPoints) [best, bestPoints] = ["body", WEIGHT.body];
      }

      if (points === 0) allPresent = false;
      score += points;
    }

    if (!allPresent || score === 0) continue;

    /*
      Verified notes rise, unverified ones sink — slightly.

      A nudge rather than a sort key. If the best answer to what you asked is a
      note you never checked, it should still be the top result and the badge
      should tell you what it is; burying it would hide the thing you came for
      behind three that merely mention the word.
    */
    if (note.confidence === "verified") score *= 1.15;
    if (note.confidence === "unverified") score *= 0.9;
    if (note.archived) score *= 0.4;

    hits.push({ note, score, matched: best });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Notes that point AT this one.
 *
 * Derived rather than stored, exactly like a mission's successors: `links` is
 * directional and the reverse edge is a filter, so there is no second copy of
 * the relationship that can fall out of step with the first.
 */
export function backlinks(notes: KnowledgeNote[], id: string): KnowledgeNote[] {
  return notes.filter((n) => !n.archived && n.links.includes(id));
}
