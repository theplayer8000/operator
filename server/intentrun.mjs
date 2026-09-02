// Running a matched intent for real, instead of only logging it.
//
// `server/intent.mjs` turns a spoken sentence into a capability action and
// deliberately stops there. This is the half that was missing: the three
// resolvers it declares, and the code that actually calls `runAction`.
//
// ## Why it was observe-only, and what changed
//
// It logged and changed nothing because all 103 of its test phrases were
// invented — none came from a real transcript. The owner asked for it live on
// 2026-09-02 having seen it work, which is his call to make. The concern that
// held it back is not answered by switching it on, so it is answered here
// instead, by the three guards below.
//
// ## The three guards, in the order they matter
//
// **1. A resolver that finds nothing abandons the intent.** It never runs the
// action with what it has. "Tick off bench press" on a day with no bench press
// does nothing and says so — it does not tick the first exercise it can see.
// This is the guard that makes a wrong match harmless rather than destructive,
// and it is why `intent.mjs` has a `needs` block at all.
//
// **2. An ambiguous resolve abandons too.** Two exercises matching "press"
// equally well is a question, not a coin toss. Silence and a spoken "which
// one?" costs a repeat; guessing costs a wrong write he may not notice for
// days.
//
// **3. It cannot create and it cannot delete.** `intent.mjs` never emits those
// actions, and this file refuses them independently — a second check on the
// same rule, because the whole reason speech is allowed to touch data is that
// everything it can do is recoverable. Ticking the wrong exercise is one tap
// back. There is no undo for a delete (OPS-020).
//
// ## Everything still goes through the capability layer
//
// No new write path. `runAction` is the same function the CLI calls and the
// same one an AI worker calls, so a spoken tick is indistinguishable from a
// tapped one — same id generation, same date keys, same invariants, same
// notification to his phone. That last part matters more than it looks: every
// write this makes tells him it happened, so a wrong match is visible within
// seconds rather than discovered later.

import { matchIntent } from "./intent.mjs";
import { runAction } from "./actions.mjs";

/*
  Local dates, never `toISOString().slice(0,10)`.

  That is UTC, and it is OPS-009 in the issue register: after midnight UTC but
  before midnight here, it silently reports tomorrow. Speaking the wrong day
  back is exactly the kind of confident wrong answer a read must not give.
*/
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "2026-09-03" → "Thursday", or a date if it is further off than a week. */
const spokenDate = (key) => {
  if (!key) return "that day";
  // Noon, so a timezone offset cannot push it onto the day either side.
  const when = new Date(`${key}T12:00:00`);
  const days = Math.round((when - new Date(`${today()}T12:00:00`)) / 86_400_000);
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (Math.abs(days) <= 6) return when.toLocaleDateString("en-GB", { weekday: "long" });
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
};

/*
  Actions this will never run, whatever a rule says.

  `intent.mjs` does not emit these, so this is a second lock on the same door.
  It is deliberate duplication: the rules are one file that a future session
  might widen for a good reason, and this list is the thing that makes widening
  them safe.
*/
const NEVER = new Set([
  "mission_create",
  "mission_delete",
  "mission_archive",
  "gym_session_create",
  "gym_session_delete",
  "gym_remove_exercise",
  "calendar_create_event",
  "calendar_create_recurring",
  "calendar_create_range",
  "calendar_delete_event",
  "routine_add_task",
  "routine_delete_task",
  "memory_forget",
]);

/**
 * Normalise for comparison. Punctuation and spacing only — never stemming.
 *
 * Whisper writes "bench press." with a full stop and he says "bench press", so
 * the punctuation has to go. Stemming does not, and adding it would make
 * "press" match "presses" match "pressing", which is how a resolver starts
 * finding things that are not there.
 */
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Pick the one candidate a spoken phrase means, or nothing.
 *
 * Four passes, narrowest first, and it stops at the first pass that finds
 * EXACTLY one. Two candidates at the same level of confidence is not a
 * near-miss to be broken by ordering — it is genuinely ambiguous, and the
 * caller turns that into a question.
 *
 * @param {string} phrase what he said
 * @param {Array<{id: string, text: string, alsoText?: string}>} candidates
 * @param {boolean} many true when the caller can USE several — "my morning
 *        routine" names a section and legitimately means every step in it, so
 *        six hits is one answer rather than six competing ones. Left false and
 *        several hits is a real question.
 * @returns {{hits: object[]} | {ambiguous: string[]} | null}
 */
function pickOne(phrase, candidates, many = false) {
  const want = norm(phrase);
  if (!want) return null;

  /*
    `alsoText` is the second name a candidate answers to — a routine step is
    addressable by its own title OR by the section it sits in, because "tick
    off my morning routine" names the section and not a step.
  */
  const scored = candidates.map((c) => ({
    ...c,
    norm: norm(c.text),
    normAlso: c.alsoText ? norm(c.alsoText) : "",
  }));
  const both = (c, fn) => fn(c.norm) || (c.normAlso ? fn(c.normAlso) : false);

  const passes = [
    // Said it exactly.
    (c) => both(c, (n) => n === want),
    // "the bench press" for "bench press", or the other way round.
    (c) => both(c, (n) => n.startsWith(want) || want.startsWith(n)),
    // "press" somewhere inside "incline bench press".
    (c) => both(c, (n) => n.includes(want) || want.includes(n)),
    /*
      Every word he said appears somewhere in the candidate. The loosest pass,
      and last for that reason: "bench" and "press" both being present is real
      evidence, but only once the tighter readings have found nothing.
    */
    (c) => {
      const words = want.split(" ").filter((w) => w.length > 2);
      if (!words.length) return false;
      return both(c, (n) => words.every((w) => n.includes(w)));
    },
  ];

  for (const pass of passes) {
    const hits = scored.filter(pass);
    if (hits.length === 1) return { hits };
    if (hits.length > 1) {
      if (many) return { hits };
      /*
        Two things matching equally well is a question, not a coin toss. The
        one exception is duplicates by name, where picking either is the same
        answer.
      */
      const distinct = [...new Set(hits.map((h) => norm(h.text)))];
      if (distinct.length === 1) return { hits: [hits[0]] };
      return { ambiguous: [...new Set(hits.map((h) => h.text))] };
    }
  }
  return null;
}

/**
 * The three lookups `intent.mjs` declares in `RESOLVERS`.
 *
 * Each reads through a capability action rather than the store, so it sees
 * exactly what the page sees — recurrence expanded, `isDoneOn` applied. A
 * resolver reading `store.mjs` directly would drift from the UI the first time
 * a derived view changed, and then speech and tapping would disagree about
 * what today contains.
 */
const RESOLVE = {
  /**
   * @param {{args: object, match: string|null, each: boolean,
   *          skipDone: boolean, unique: boolean, expect: string|null}} needs
   */
  async gym_exercise(needs) {
    const day = await runAction("gym_day", needs.args ?? {});
    const session = day?.session ?? null;
    if (!session) return { fail: "no gym session today" };

    /*
      The check that stops a wrong write, and it comes first.

      "I did push day" on a leg day means one of the two is wrong, and guessing
      which is not this code's business. `intent.mjs` puts the session he NAMED
      in `expect`; if today's session is not that, abandon rather than tick off
      a session he did not do.
    */
    if (needs.expect) {
      const name = norm(session.name ?? "");
      if (!name.includes(norm(needs.expect))) {
        return { fail: `today is ${session.name}, not ${needs.expect}` };
      }
    }

    const all = (session.exercises ?? []).map((e) => ({
      id: e.id,
      text: e.name,
      done: Boolean(e.done),
    }));
    if (!all.length) return { fail: "nothing listed for today" };

    return select(all, needs, (c) => ({ exerciseId: c.id }), session.name);
  },

  async routine_step(needs) {
    const day = await runAction("routine_day", needs.args ?? {});
    /*
      Flattened with the section carried along, because the action needs BOTH
      `sectionKey` and `taskId` — a task id alone does not say where it lives.
      A step is addressable by its own title or by its section's name, so both
      go in the searchable text.
    */
    const all = [];
    for (const section of day?.sections ?? []) {
      for (const task of section.tasks ?? []) {
        all.push({
          id: task.id,
          sectionKey: section.key,
          text: task.title,
          alsoText: section.label ?? section.key,
          done: Boolean(task.done),
        });
      }
    }
    if (!all.length) return { fail: "nothing on the routine today" };

    return select(all, needs, (c) => ({ sectionKey: c.sectionKey, taskId: c.id }));
  },

  async mission(needs) {
    const list = await runAction("missions_list", needs.args ?? {});
    const all = (list?.missions ?? [])
      .filter((m) => !m.archived)
      .map((m) => ({ id: m.id, text: m.name, done: false }));
    if (!all.length) return { fail: "no missions on the board" };

    return select(all, needs, (c) => ({ id: c.id }));
  },
};

/**
 * Turn candidates plus a `needs` block into the list of calls to make.
 *
 * One function for all three resolvers, because the rules that matter are the
 * same in each and having them in one place is what stops them drifting apart.
 * The differences between the three are only WHERE the candidates come from
 * and which parameter names they fill, which is what the two callbacks are for.
 *
 * @returns {{fill: object[], labels: string[], sweep: boolean} |
 *           {ambiguous: string[]} | {fail: string}}
 */
function select(all, needs, toParams, groupLabel) {
  /*
    No name said means the whole thing: "I did push day" is a claim about the
    SESSION, not about an exercise, so every exercise on it is ticked.
  */
  if (needs.each && !needs.match) {
    /*
      Already-ticked ones are left alone, or this unticks the half he did from
      his phone at the gym. The action is a toggle by design, which makes
      "skip what is done" this layer's job, not the action's.
    */
    const todo = needs.skipDone ? all.filter((c) => !c.done) : all;
    /*
      `found` marks a failure that is actually an ANSWER.

      A chain of lookups (`needs.also`) falls through on a miss, and "already
      ticked off" is not a miss — it means the thing was located and there is
      nothing to do. Without this flag, "tick off bench press" on a day it was
      already done would fall through to the routine and report "nothing called
      bench press there", replacing a useful answer with a confusing one.
    */
    if (!todo.length) return { fail: "that was already all ticked off", found: true };
    return {
      fill: todo.map(toParams),
      labels: todo.map((c) => c.text),
      sweep: true,
      groupLabel: groupLabel ?? null,
    };
  }

  if (!needs.match) return { fail: "nothing named to look for" };

  const hit = pickOne(needs.match, all, Boolean(needs.each));
  if (!hit) return { fail: `nothing called "${needs.match}" there` };
  if (hit.ambiguous) {
    /*
      `unique` is the rule's own statement that ambiguity must abandon. It is
      true everywhere today, and honoured rather than assumed so a future rule
      can say otherwise without this silently ignoring it.
    */
    if (needs.unique !== false) return { ambiguous: hit.ambiguous };
    return { fail: "more than one of those" };
  }

  const chosen = needs.skipDone ? hit.hits.filter((c) => !c.done) : hit.hits;
  if (!chosen.length) {
    // Located, and nothing to do — an answer, so a chain stops here.
    return {
      fail:
        hit.hits.length === 1
          ? `${hit.hits[0].text} is already ticked off`
          : "that was already all ticked off",
      found: true,
    };
  }

  return {
    fill: chosen.map(toParams),
    labels: chosen.map((c) => c.text),
    sweep: chosen.length > 1,
    groupLabel: chosen.length > 1 ? needs.match : null,
  };
}

/**
 * Match a spoken sentence and run it, if it is unambiguously one thing.
 *
 * Never throws — a router or an action that fails must cost him the command,
 * not the sentence. The caller falls through to a worker on any non-`ran`
 * outcome, so the worst case is what happened before this existed.
 *
 * @returns {Promise<{ran: false, reason: string, say?: string} |
 *                   {ran: true, action: string, result: object, say: string}>}
 */
export async function runIntent(transcript) {
  let intent;
  try {
    intent = matchIntent(transcript);
  } catch (err) {
    return { ran: false, reason: `router threw: ${err?.message ?? err}` };
  }
  if (!intent) return { ran: false, reason: "no match" };

  /*
    Every action this sentence could reach, primary first.

    `intent.mjs` may attach `needs.also` — alternative lookups tried only where
    the one before found NOTHING. It exists because "tick off X" cannot be
    routed from words alone: "bench press" and "meditation" are the same
    sentence shape, and only the data knows which is on today. The routine
    resolver looks first, and where it finds nothing the gym resolver does.

    A chain never changes a sentence that already resolves, because the primary
    always runs first.
  */
  const chain = [
    // The primary IS `intent.action`; `chosen` is decided further down.
    { action: intent.action, needs: intent.needs },
    ...(intent.needs?.also ?? []).map((alt) => ({ action: alt.action, needs: alt })),
  ];

  /*
    NEVER is checked PER LINK, not once on the primary.

    That list is the second lock on create and delete — the one that holds even
    if a rule is widened later. Checking only `intent.action` would let a
    fallback route straight around it, which is exactly the kind of gap a second
    code path opens by default.
  */
  for (const link of chain) {
    if (NEVER.has(link.action)) {
      console.warn(`[operator] intent: REFUSED ${link.action} — not runnable by voice`);
      return { ran: false, reason: `${link.action} is not runnable by voice` };
    }
  }

  /*
    The calls to make, and what to call each one when speaking back.

    A LIST, not a single set of parameters. "I did push day" is one sentence
    and six writes — `needs.each` means every exercise on the session — so the
    unit here is a list of fills that happens to have one entry most of the
    time.

    Labels are carried alongside because THE ACTIONS RETURN IDS:
    `gym_toggle_exercise` answers `{date, exerciseId, done}`. Speaking back
    "ticked off 6f3a-..." would confirm nothing, and the whole point of
    speaking the result is that he can hear a wrong match without looking.
  */
  let fills = [{ ...intent.params }];
  let labels = [];
  let sweep = false;
  let groupLabel = null;

  /** Which link actually resolved. Drives the action run and the words spoken. */
  let chosen = chain[0];

  if (intent.needs) {
    /*
      The PRIMARY's failure is the one worth saying.

      When every link misses, reporting the last one is nonsense: "tick off
      meditation" on a rest day would answer "no gym session today", which is
      not what he asked about. The routine was the reading his sentence
      supported, so the routine's answer is the honest one.
    */
    let primaryFailure = null;
    let resolved = null;

    for (const link of chain) {
      const resolver = RESOLVE[link.needs.find];
      if (!resolver) {
        return { ran: false, reason: `no resolver for ${link.needs.find}` };
      }

      let outcome;
      try {
        outcome = await resolver(link.needs);
      } catch (err) {
        return { ran: false, reason: `resolving ${link.needs.find}: ${err?.message ?? err}` };
      }

      if (outcome.ambiguous) {
        /*
          Ambiguity STOPS the chain rather than falling through. Two exercises
          matching "press" is an answer — a question to ask him — and trying
          somewhere else would discard it to go looking for a worse match.

          Answered by asking rather than picking, and spoken back rather than
          logged: he is standing there, and a log he reads tomorrow cannot
          resolve a command he gave today.
        */
        const names = outcome.ambiguous.slice(0, 3).join(", or ");
        return { ran: false, reason: "ambiguous", say: `Did you mean ${names}?` };
      }

      if (outcome.fail) {
        /*
          `found` separates "it is not here" from "it is here and already done".
          Only the first is a miss. Falling through on the second would replace
          a useful answer with a confusing one.
        */
        if (outcome.found) {
          return { ran: false, reason: outcome.fail, say: `I couldn't — ${outcome.fail}.` };
        }
        if (!primaryFailure) primaryFailure = outcome.fail;
        continue;
      }

      chosen = link;
      resolved = outcome;
      break;
    }

    if (!resolved) {
      const why = primaryFailure ?? "nothing matched";
      return { ran: false, reason: why, say: `I couldn't — ${why}.` };
    }

    if (chosen !== chain[0]) {
      console.log(
        `[operator] intent: ${chain[0].action} found nothing, using ${chosen.action}`,
      );
    }

    /*
      Resolved values LAST, so a resolver always wins over whatever the rule
      guessed. The rule works from words; the resolver worked from what is
      actually on the board today.
    */
    fills = resolved.fill.map((f) => ({ ...intent.params, ...f }));
    labels = resolved.labels ?? [];
    sweep = Boolean(resolved.sweep);
    groupLabel = resolved.groupLabel ?? null;
  }

  const done = [];
  let last = null;
  for (const [i, params] of fills.entries()) {
    try {
      last = await runAction(chosen.action, params);
      done.push(labels[i] ?? null);
    } catch (err) {
      /*
        Stop at the first failure rather than pressing on.

        A sweep is one instruction, and half of one applied is the state that is
        hardest to reason about later. What already succeeded stands — these are
        toggles, all recoverable with a tap — and the spoken reply says how far
        it got instead of claiming the whole thing.
      */
      console.warn(`[operator] intent: ${chosen.action} failed — ${err?.message ?? err}`);
      if (!done.length) {
        return { ran: false, reason: `${chosen.action} failed: ${err?.message ?? err}` };
      }
      return {
        ran: true,
        action: chosen.action,
        result: last,
        say: `Got ${done.length} of ${fills.length}, then it failed.`,
      };
    }
  }

  console.log(
    `[operator] intent: RAN ${chosen.action} x${done.length} — ${intent.why}`,
  );
  return {
    ran: true,
    action: chosen.action,
    result: last,
    count: done.length,
    say: spokenResult(intent, last, { labels: done, sweep, groupLabel, action: chosen.action }),
  };
}

/**
 * What to say back, in the fewest words that confirm the right thing happened.
 *
 * Not "done" on its own. He has to be able to hear a WRONG match without
 * looking at the screen, and "done" confirms only that something happened —
 * naming what changed is what makes a mistake audible at the moment it is
 * cheap to undo.
 */
function spokenResult(intent, result, { labels, sweep, groupLabel, action }) {
  // The action that ACTUALLY ran, which is not intent.action when a fallback won.
  const a = action ?? intent.action;
  const it = labels[0] ?? "that";
  /*
    A sweep is counted, not listed. Reading six exercise names back is longer
    than the instruction was, and he already knows what is on push day — the
    number is what tells him it caught the right session.
  */
  const many = sweep
    ? `${labels.length} ${groupLabel ? `${groupLabel} ` : ""}${labels.length === 1 ? "thing" : "things"}`
    : it;

  if (a === "now") return String(result?.spoken ?? result?.time ?? "");

  /*
    A read has to be ANSWERED, not confirmed.

    Everything else here reports that something changed, and "Done." is a fine
    answer to that. A question is different: "Done." to "what's on gym today"
    is the shape of a reply with none of the content, and it would read as the
    feature being broken.

    Kept short on purpose — this is spoken, and a list of eight exercises read
    aloud is longer than looking at the page. The session's name and how much
    is left is what he actually asked.
  */
  if (a === "gym_day") {
    const day = result ?? {};
    /*
      The word starts the sentence, so it is capitalised and used bare —
      "Tomorrow is Legs" rather than "On tomorrow is Legs", which is what
      prefixing produced.
    */
    const said = day.date === today() ? "today" : spokenDate(day.date);
    const when = said.charAt(0).toUpperCase() + said.slice(1);
    if (day.restDay) return `${when} is a rest day.`;
    if (day.skipped) return `${when}'s session is marked as skipped.`;
    const session = day.session;
    if (!session) return `Nothing scheduled for ${said}.`;

    const all = session.exercises ?? [];
    const left = all.filter((e) => !e.done).length;
    const name = session.name ?? "a session";
    if (!all.length) return `${when} is ${name}, with nothing listed yet.`;
    if (left === 0) return `${when} is ${name} — all ${all.length} done.`;
    return `${when} is ${name} — ${left} of ${all.length} left.`;
  }
  if (a === "gym_toggle_exercise" || a === "routine_toggle_task") {
    return `${result?.done ? "Ticked off" : "Unticked"} ${many}.`;
  }
  if (a === "gym_skip_day") return "Marked today as a rest day.";
  if (a === "gym_unskip_day") return "Put today's session back on.";
  if (a === "mission_set_progress") {
    return `${it === "that" ? "That mission" : it} is at ${result?.progress}%.`;
  }
  if (a === "mission_set_status") {
    return `${it === "that" ? "That mission" : it} is ${String(result?.status ?? "").replace(/_/g, " ")}.`;
  }
  if (a === "memory_remember") return "Noted.";
  if (a === "media_play_pause") return "";
  if (a === "focus_operator") return "";

  return "Done.";
}
