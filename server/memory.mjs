// What Operator knows about the OWNER, as opposed to what it holds for him.
//
// Every other key in the store is feature data — missions, gym sessions,
// calendar records. None of it describes the person. Claude Code resumes a
// thread and so a *conversation* remembers, but a new tab is a stranger: it
// re-learns that he works nights, that he wants answers short, that "the box"
// means the EPYC server, and it re-learns it at the cost of a turn every time.
// This is the slice that survives the tab.
//
// ## Why it is a file on his disk and not a service
//
// Hosted memory (Honcho and the like) was refused, and not on the usual
// self-hosting principle alone. Feature data is dull if it leaks — a gym log is
// a gym log. This slice is the opposite: it is a description of a person,
// accumulated without him re-reading it, which is the most sensitive thing in
// the store. So it lives where everything else lives, in `data/operator.json`
// under `memory.facts`, written through `store.mjs` like every other writer.
// Nothing in this file makes a network call and nothing in it wants to.
//
// ## Why there is no retrieval here
//
// The obvious shape is embeddings: score every fact against the prompt, inject
// the top few. It is also the wrong shape at this size. Around thirty facts of
// one sentence each is roughly a paragraph — small enough that sending all of
// them is cheaper than the machinery to choose between them, and, more
// importantly, *deterministic*: the model sees the same picture of him on every
// turn, so its behaviour does not quietly change because a sentence happened to
// be phrased away from its own embedding. A retrieval layer that silently drops
// the one relevant fact is indistinguishable from having no memory at all, and
// far harder to notice than a slightly longer prompt.
//
// So `recallFor()` sends everything while everything fits a character budget,
// and only falls back to ordering — by plain word overlap, still no model, no
// network — when the list has outgrown it. If that fallback starts firing
// routinely, the cap is too high or the facts are too wordy; that is the signal
// to act on, not a reason to reach for vectors.
//
// ## The one thing that must not rot
//
// A fact carries **how** it was learned. An assistant that repeats a guess back
// as though he had said it is worse than one that has forgotten — the first
// costs trust, the second costs a sentence. `source` is therefore not optional
// metadata; it is rendered inline in the recall block, and the block tells the
// model in as many words to treat an inference as a guess.

import { randomUUID } from "node:crypto";
import { withState, readState } from "./store.mjs";

/** The one namespace this file owns. Nothing else should write it. */
export const MEMORY_KEY = "memory.facts";

export class MemoryError extends Error {}

/*
  Deliberately its own error type rather than `actions.mjs`'s `ActionError`.

  The natural next step is a `memory_remember` capability action, which would
  make `actions.mjs` import this file; importing it back for an error class
  would close the loop. ESM tolerates a cycle right up until one side reads a
  binding at module-evaluation time, at which point it fails as `undefined` in
  a way that reads like anything but a cycle. A caller wrapping these for the
  capability layer should catch `MemoryError` and rethrow it as `ActionError`.
*/

/**
 * How a fact was learned. Two values, because a third ("assumed", "probably")
 * would be a confidence scale, and a scale invites the model to write things
 * down at 0.4 that it should not be writing down at all.
 */
const SOURCES = new Set(["stated", "inferred"]);

/**
 * The ceiling, env-only.
 *
 * Not because the number is precious, but because a worker has Write
 * everywhere: a limit stored in the app is a limit the agent can raise on its
 * own, the same reasoning that keeps `OPERATOR_TERMINAL_DEVICES` and
 * `OPERATOR_APPS` out of the store. The default is well above the ~30 facts
 * this is expected to hold, so hitting it means something is remembering
 * indiscriminately and eviction is the symptom, not the fix.
 */
const MAX_FACTS = clamp(Number(process.env.OPERATOR_MEMORY_MAX) || 100, 10, 500);

/**
 * One fact is one sentence. Over-long text is REJECTED rather than truncated —
 * truncation is how "he trains five days a week unless he is on nights"
 * becomes a statement that is confidently wrong. Splitting it into two facts is
 * the caller's job and costs nothing.
 */
const MAX_TEXT = 240;

/** Roughly 500 tokens of system prompt. Injected on every turn, so it is a bill. */
const RECALL_CHARS = 2000;

/**
 * Two facts sharing this much of their vocabulary are treated as the same one.
 *
 * 0.8 rather than 0.75, and the difference is not cosmetic. At 0.75 a pair of
 * long sentences differing by a single content word out of seven scores exactly
 * on the line and merges — measured, and it silently ate a run of distinct
 * facts that happened to share a sentence frame. Short sentences are unaffected
 * either way ("trains on Monday" against "trains on Tuesday" scores 0.33), so
 * the only pairs this moves are the long near-identical ones, which are
 * precisely the ones where being wrong destroys the most.
 */
const DUPLICATE_THRESHOLD = 0.8;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Same reasoning as `actions.mjs`: nothing here is a browser, so no fallback. */
function generateId() {
  return randomUUID();
}

/**
 * One line, bounded, no markup.
 *
 * This text ends up inside a system prompt, and it is written by a worker
 * rather than typed by the owner. Flattening newlines and capping the length
 * is what stops a "fact" from being a paragraph of instructions wearing a
 * bullet point — a small thing, but the alternative is that whatever can call
 * `remember()` can also append to the prompt of every future turn.
 */
function flatten(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) throw new MemoryError("a fact needs some text");
  if (clean.length > MAX_TEXT) {
    throw new MemoryError(
      `a fact must be one sentence (${MAX_TEXT} characters or fewer) — split "${clean.slice(0, 60)}…" into separate facts`
    );
  }
  return clean;
}

/*
  Apostrophes are dropped rather than turned into spaces so "doesn't" becomes
  one token, "doesnt" — which is also what the owner types half the time. The
  negation list below is written in that same flattened form for exactly that
  reason.
*/
function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words carrying no distinguishing weight. Negations are conspicuously absent —
 * stripping "not" would make "he trains on Sundays" and "he does not train on
 * Sundays" look like the same sentence, which is the one collision that must
 * never happen here.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "he", "his", "him", "himself", "i", "me", "my", "owner",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "has",
  "have", "had", "of", "to", "in", "on", "at", "for", "with", "and", "or",
  "that", "this", "it", "its", "as", "by", "from", "but", "so", "very",
]);

const NEGATION = /\b(not|no|never|none|dont|doesnt|didnt|isnt|arent|wasnt|wont|cant|cannot|stopped|quit|dropped|no longer)\b/;

/**
 * Content words, crudely singularised.
 *
 * Both details here were measured rather than assumed, on 2026-09-01:
 *
 * **Digits are kept even though they are one character long.** A blanket
 * "drop anything shorter than two characters" filter deleted the numbers out of
 * "filler observation number 3", and twenty sentences that differed only by
 * their number became one fact — the dedupe swallowing nineteen real memories.
 * The number is very often the whole content of a fact about a person ("4 on 4
 * off", "5 days a week"), so it is the last thing that should be thrown away.
 *
 * **A trailing "s" comes off anything longer than three characters.** Without
 * it, "he works a 4-on-4-off shift pattern" and "he works 4 on 4 off shifts"
 * scored 0.5 and were stored twice, which is exactly the restatement this is
 * supposed to catch. A real stemmer would be a dependency; this covers plurals,
 * which is what actually differs between two phrasings of the same fact.
 */
function tokens(text) {
  return new Set(
    normalise(text)
      .split(" ")
      .filter((word) => (word.length > 1 || /\d/.test(word)) && !STOPWORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
  );
}

/** The numbers in a sentence, which are usually the part that carries it. */
function numbers(text) {
  return new Set(normalise(text).split(" ").filter((word) => /^\d+$/.test(word)));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Are these two sentences the same fact?
 *
 * Exact-match dedupe on its own does not survive contact with a language model:
 * "he drinks his coffee black" and "He takes coffee black" are the same fact
 * written twice, and both would be injected, which reads to the owner as an
 * assistant that repeats itself. So this is a set overlap (Jaccard) over
 * content words.
 *
 * **A difference in negation vetoes the match, however high the overlap.**
 * "he trains on Sundays" and "he no longer trains on Sundays" share almost
 * every word; merging them would let a correction quietly overwrite the fact it
 * contradicts, or — worse, since the newer text wins — let a coincidence do it.
 * Contradiction is not a problem this file is equipped to solve, so it does not
 * pretend to: both are stored, both are recalled with their dates, and the
 * model can see the newer one and call `forget()` on the stale one. Two dated
 * statements the reader can weigh is an honest answer; one silently chosen for
 * them is not.
 *
 * **A disagreement about numbers vetoes it for the same reason.** "He works 4
 * on 4 off" and "He works 3 on 3 off" share every other word; treating them as
 * one fact would let the newer text overwrite the older with no record that
 * they ever differed. Only when both sentences actually contain numbers — so
 * "two sisters" against "2 sisters" is not vetoed by one side having none.
 *
 * **Both vetoes are floors, not a guarantee, and the gap is worth naming.**
 * Jaccard cannot see a reversal that is neither a negation nor a number, and
 * raising the threshold does not close it, only moves it: at 0.8, a pair
 * differing by one content word in nine still merges. Measured — "…on the dev
 * build **before** they reach the live app" and the same sentence with
 * "**after**" scored 0.82 and became one fact, the newer silently replacing
 * the older. So the honest claim is narrower than "contradictions are kept":
 * negated and numeric disagreements are kept, and a long paraphrase that
 * inverts a preposition is not. If that starts mattering, the fix is shorter
 * facts — nine content words is already two facts wearing one sentence — not a
 * list of antonyms, which would be endless and would read as a guarantee it
 * could not keep.
 */
function isSameFact(a, b) {
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (NEGATION.test(left) !== NEGATION.test(right)) return false;

  const leftNumbers = numbers(a);
  const rightNumbers = numbers(b);
  if (leftNumbers.size && rightNumbers.size && !sameSet(leftNumbers, rightNumbers)) return false;

  const one = tokens(a);
  const two = tokens(b);
  if (!one.size || !two.size) return false;

  let shared = 0;
  for (const word of one) if (two.has(word)) shared += 1;
  const union = one.size + two.size - shared;
  return union > 0 && shared / union >= DUPLICATE_THRESHOLD;
}

/** Local calendar date, never `toISOString()` — that is UTC (OPS-009). */
function shortDate(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "date unknown";
  const stamp = when.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  // The year only when it is not this one — it is noise eleven months in twelve.
  return when.getFullYear() === new Date().getFullYear()
    ? stamp
    : `${stamp} ${when.getFullYear()}`;
}

function valid(fact) {
  return Boolean(fact) && typeof fact === "object" && typeof fact.text === "string" && Boolean(fact.text.trim());
}

/**
 * The stored slice, made safe to work with — on every path that writes.
 *
 * This file is not the only thing that can put something in `memory.facts`.
 * `PUT /api/state/<key>` is generic and unvalidated on purpose (the maintenance
 * backdoor), and Settings' import writes every namespace wholesale, so an entry
 * can arrive here hand-written, half-shaped, or **without an id**.
 *
 * The missing id is the one that used to be fatal. Eviction marked its victims
 * in a `Set` of ids, and `undefined === undefined`, so a single id-less fact
 * being chosen for eviction took *every* id-less fact with it: measured
 * 2026-09-01, fifteen imported facts plus one new one went in and one came out,
 * while the log line said "forgot 1 of 16". Backfilling on the way through a
 * write is the fix at the source — eviction and `forget()` by id both key on
 * it, so a fact without one is a fact that cannot be addressed or safely
 * counted. Doing it here rather than on read means the id that a caller is
 * handed is the id that is on disk.
 *
 * Entries too broken to repair are dropped, which is silent data loss by any
 * other name, so it says so on the console rather than happening quietly.
 */
function usable(current) {
  const raw = Array.isArray(current) ? current : [];
  const facts = raw
    .filter(valid)
    .map((fact) => (typeof fact.id === "string" && fact.id ? fact : { ...fact, id: generateId() }));
  const dropped = raw.length - facts.length;
  if (dropped > 0) {
    console.warn(`[operator] memory: discarded ${dropped} entr${dropped === 1 ? "y" : "ies"} with no usable text`);
  }
  return facts;
}

/**
 * Most expendable first.
 *
 * A guess goes before something he actually said, always — that ordering is the
 * whole reason `source` is recorded. Then whatever he has repeated least, then
 * whatever has gone longest without being mentioned. Eviction is a last resort
 * either way: there is no undo in this project (OPS-020), and a forgotten fact
 * is gone.
 */
function expendability(a, b) {
  const bySource = (a.source === "stated" ? 1 : 0) - (b.source === "stated" ? 1 : 0);
  if (bySource !== 0) return bySource;
  const byMentions = (a.mentions ?? 1) - (b.mentions ?? 1);
  if (byMentions !== 0) return byMentions;
  return String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? ""));
}

/*
  Victims are marked by object identity, not by id.

  Marking by id looks equivalent and is not: two entries sharing an id — or two
  sharing the *absence* of one — are one entry as far as a `Set` of ids is
  concerned, so evicting either evicted both, and the count that got logged was
  the number of ids removed rather than the number of facts lost. `usable()`
  now guarantees an id, which closes the same hole from the other side; keying
  on the object as well costs nothing and means neither guard has to be the
  only one standing.
*/
function capped(facts, keep) {
  if (facts.length <= MAX_FACTS) return facts;
  const doomed = new Set();
  for (const fact of [...facts].sort(expendability)) {
    if (facts.length - doomed.size <= MAX_FACTS) break;
    if (fact === keep) continue; // never evict the thing just written
    doomed.add(fact);
  }
  const kept = facts.filter((fact) => !doomed.has(fact));
  console.log(`[operator] memory at capacity — forgot ${facts.length - kept.length} of ${facts.length} facts`);
  return kept;
}

/**
 * Learn something about the owner, or re-learn it.
 *
 * @param {string} text     one sentence, in the third person
 * @param {object} [opts]
 * @param {"stated"|"inferred"} [opts.source="inferred"]  how it was learned
 * @param {string} [opts.job]  the job it came from, for provenance
 * @returns the stored fact
 */
export async function remember(text, opts = {}) {
  const clean = flatten(text);
  /*
    Reject a non-object `opts` rather than reading through it.

    `remember(text, "stated")` is the obvious way to get this wrong, and the
    old signature absorbed it in silence: `"stated".source` is `undefined`, so
    the fact was filed as **inferred** — a caller saying "he told me this"
    ending up as a guess is precisely the inversion the header calls the one
    thing that must not rot. `null` was worse still, throwing a bare TypeError
    that a wrapper catching `MemoryError` would not recognise as a bad
    argument.
  */
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new MemoryError('remember(text, opts) takes an options object — did you mean { source: "stated" }?');
  }
  /*
    The default under-claims on purpose. A caller that forgets to say where a
    fact came from is far more likely to have inferred it than to have been
    told it — and of the two ways to be wrong here, recording a guess as
    testimony is the one that costs trust.
  */
  const source = opts.source ?? "inferred";
  if (!SOURCES.has(source)) {
    throw new MemoryError(`source must be one of: ${[...SOURCES].join(", ")}`);
  }
  const job = opts.job ? String(opts.job).slice(0, 64) : undefined;
  const now = new Date().toISOString();

  let stored;
  await withState(MEMORY_KEY, (current) => {
    const facts = usable(current);
    const at = facts.findIndex((fact) => isSameFact(fact.text, clean));

    if (at !== -1) {
      const previous = facts[at];
      stored = {
        ...previous,
        // The newer phrasing wins: if he has restated it, that is the version
        // he would recognise. `learnedAt` is untouched — when Operator first
        // knew this is a different question from when it last heard it.
        text: clean,
        /*
          Confirmation upgrades, nothing downgrades. Being told outright what
          was previously a guess is real information; a later inference about
          something he has already said is not a reason to start doubting him.
        */
        source: previous.source === "stated" ? "stated" : source,
        mentions: (previous.mentions ?? 1) + 1,
        updatedAt: now,
        ...(job ? { job } : {}),
      };
      const next = [...facts];
      next[at] = stored;
      /*
        Capped on the update path too, even though an update cannot grow the
        list. The cap is a ceiling on what gets injected into every prompt, and
        a slice can be over it without this file having put it there — lower
        `OPERATOR_MEMORY_MAX`, or import a larger backup, and the store stayed
        stubbornly over the limit until someone happened to say something new.
        Measured at 33 facts against a cap of 15.
      */
      return capped(next, stored);
    }

    stored = {
      id: generateId(),
      text: clean,
      source,
      learnedAt: now,
      updatedAt: now,
      mentions: 1,
      ...(job ? { job } : {}),
    };
    return capped([...facts, stored], stored);
  });

  return stored;
}

/**
 * Drop a fact, by id or by its exact text.
 *
 * Text is accepted because the caller that wants to forget something is holding
 * the sentence, not a uuid, and making it list everything first to find one is a
 * round trip for nothing — the same lesson as the missing gym read action that
 * cost $0.92 to answer a question the store already knew. Matching is on the
 * *normalised exact* text only, never the fuzzy comparison `remember()` uses:
 * merging two near-identical facts is recoverable, deleting the wrong one is
 * not.
 *
 * @returns {Promise<boolean>} whether anything was actually removed
 */
export async function forget(idOrText) {
  const needle = String(idOrText ?? "").trim();
  if (!needle) throw new MemoryError("forget needs an id or the exact text of a fact");
  const key = normalise(needle);

  // Checked before writing, because `withState` persists whatever it is handed
  // — returning the unchanged array would still rewrite the store file to say
  // nothing happened.
  const facts = (await readState(MEMORY_KEY)) ?? [];
  const hit = (fact) => valid(fact) && (fact.id === needle || normalise(fact.text) === key);
  if (!Array.isArray(facts) || !facts.some(hit)) return false;

  await withState(MEMORY_KEY, (current) => usable(current).filter((fact) => !hit(fact)));
  return true;
}

/**
 * Everything known, in the order it was learned.
 *
 * Insertion order rather than newest-first: this is the list a person reads to
 * check what Operator thinks of him, and a stable order makes a new arrival
 * obvious at the bottom instead of shuffling the whole thing. Sorting is the
 * caller's business.
 */
export async function listFacts() {
  const facts = await readState(MEMORY_KEY);
  // Filtered but deliberately not run through `usable()`: this is a read, and
  // minting an id here would hand back one that is not on disk and will differ
  // on the next call — a worse answer than an absent field. An imported fact
  // without an id gets one the first time anything writes; until then it is
  // addressable by its text, which `forget()` accepts for exactly this reason.
  return (Array.isArray(facts) ? facts : []).filter(valid);
}

function render(fact) {
  const how = fact.source === "stated" ? "he said so" : "inferred";
  return `- ${fact.text} (${how}, ${shortDate(fact.learnedAt ?? fact.updatedAt)})`;
}

/**
 * Rank by plain word overlap with the prompt, most relevant first, recency
 * breaking ties.
 *
 * Only ever reached when the whole list will not fit the budget — see the
 * header. No model and no network, because a memory layer that needs a
 * provider to be up in order to remember anything is a memory layer that
 * forgets him whenever his quota does.
 */
function byRelevance(facts, prompt) {
  const asked = tokens(prompt);
  return [...facts]
    .map((fact) => {
      const words = tokens(fact.text);
      let shared = 0;
      for (const word of words) if (asked.has(word)) shared += 1;
      return { fact, shared };
    })
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        String(b.fact.updatedAt ?? "").localeCompare(String(a.fact.updatedAt ?? ""))
    )
    .map((entry) => entry.fact);
}

/**
 * The block to append to a system prompt, or `""` when there is nothing to say.
 *
 * Empty string rather than a "nothing known yet" sentence: a caller can do
 * `...(recall ? [recall] : [])` and a fresh install spends no tokens telling
 * the model that it has no memories.
 *
 * @param {string} [prompt] the turn's request — consulted ONLY when the facts
 *   do not all fit, which is the abnormal case
 */
export async function recallFor(prompt = "") {
  const facts = await listFacts();
  if (!facts.length) return "";

  const header = "What you already know about the owner (persistent memory, not from this conversation):";
  const guidance =
    'Anything marked "inferred" is Operator\'s own guess — use it to be more useful, ' +
    "but never assert it back to him as established fact. If something here is wrong or " +
    "out of date, say so plainly rather than working around it.";
  const overhead = header.length + guidance.length + 4;

  const all = facts.map(render);
  const total = all.reduce((sum, line) => sum + line.length + 1, overhead);
  if (total <= RECALL_CHARS) {
    return [header, ...all, "", guidance].join("\n");
  }

  const lines = [];
  // The partial notice below is part of the block, so its room is reserved
  // before the loop rather than added after it — appending it afterwards put
  // the block over the budget it had just been measured against.
  let used = overhead + 80;
  for (const fact of byRelevance(facts, prompt)) {
    const line = render(fact);
    if (used + line.length + 1 > RECALL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  // Say that it is partial. A model told it can see everything, when it cannot,
  // will state absences as facts — "you have never mentioned X" — and be wrong.
  lines.push(`(showing ${lines.length} of ${facts.length} — there is more he has told Operator.)`);
  return [header, ...lines, "", guidance].join("\n");
}
