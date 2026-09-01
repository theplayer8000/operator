// Speech to a capability action, without asking a model.
//
// "I did push day" should tick the gym off. The action exists; the thing that
// turns the sentence into the action did not — that is gap 1 in the brief, and
// this is the cheap half of closing it.
//
// ## Why rules, when there is a local model sitting right there
//
// Because it is slower than the thing it would be accelerating. qwen2.5:3b runs
// at roughly 1.7 tokens/sec on this box, so a fifty-token JSON intent blob is
// about thirty seconds — the "instant" path would become the slowest path in
// the system, beaten by both hosted workers. It is also measurably unreliable
// on easier work than this: semantic verification scored 2 of 3, and once
// emitted MATCHES while its own explanation said the changes were unrelated.
//
// So this is shaped like `routing.mjs`: regex tables, a fast path, and **null
// meaning "no opinion"**. Null is the common answer and must stay cheap —
// everything it declines falls through to the router that already exists, which
// is a working system, not a failure.
//
// ## The asymmetry that decides every judgement call here
//
// A wrong route costs money. A wrong *intent* changes his data without being
// asked, in a system that has no undo (OPS-020). Those are not the same size of
// mistake, so this file is deliberately more timid than `routing.mjs`:
//
//   - **It never creates and never deletes.** Nothing here calls
//     `mission_create`, any `calendar_create_*`, `routine_add_task`, or any
//     `*_delete`. Creation invents content out of a transcript, and Whisper
//     hallucinates on silence with high confidence — "Thanks for watching!"
//     once created about twenty real, billed jobs. A hallucinated tick is
//     one tap to undo; a hallucinated record is litter with a plausible title.
//   - **Everything it does emit is reversible**: a toggle untoggles, a skip
//     unskips, a percentage is overwritten by the next one.
//   - **Ambiguity resolves to null**, not to a guess.
//
// ## Intents that cannot be filled from words alone
//
// Most of the actions worth reaching by voice are keyed by an id the speaker
// never says. `gym_toggle_exercise` wants an `exerciseId`; `mission_set_progress`
// wants a mission `id`; `routine_toggle_task` wants a `sectionKey` and a
// `taskId`. "I did push day" contains none of them.
//
// So a matched intent may carry a `needs` block: the read action that supplies
// the missing values, and how to pick them. That extra hop is not a weakness —
// **it is the guard**. If "tick off bench press" finds no routine step by that
// name, the resolver abandons and nothing is written. Which is why the rules for
// resolving intents can afford to be a little generous, while the two that run
// directly (`gym_skip_day`, `gym_unskip_day`, and the two zero-parameter device
// actions) are matched narrowly.
//
// `needs.find` is a closed set — `RESOLVERS` below — because the alternative is
// a generic path language for reaching into action results, and a generic way to
// address anything is the shape `server/actions.mjs` exists to refuse.
//
// Nothing here imports anything. It is a pure function over a string, which is
// what makes `--self-test` at the bottom a real test rather than a mock.

/** Every action name this file can emit. Checked against the real registry by
    the self-test, so a rename in actions.mjs fails loudly here. */
export const EMITTED_ACTIONS = [
  "now",
  "media_play_pause",
  "focus_operator",
  "gym_skip_day",
  "gym_unskip_day",
  "gym_toggle_exercise",
  "routine_toggle_task",
  "mission_set_progress",
  "mission_set_status",
];

/**
 * The three lookups a caller must implement to run a `needs` intent.
 *
 * One per read action, hand-written, mirroring the shape that read returns:
 *
 *   gym_exercise   read `gym_day`. Candidates are `session.exercises` (each has
 *                  `id`, `name`, `done`). Fills `exerciseId`.
 *   routine_step   read `routine_day`. Candidates are every task in every
 *                  `sections[].tasks[]` (each has `id`, `title`, `done`), and a
 *                  candidate also matches on its section's `key`/`label`. Fills
 *                  `sectionKey` and `taskId`.
 *   mission        read `missions_list`. Candidates are `missions` (each has
 *                  `id`, `name`). Fills `id`.
 */
export const RESOLVERS = ["gym_exercise", "routine_step", "mission"];

/*
  A sentence long enough to be a paragraph is conversation, not a command.

  Generous enough for the longest real instruction measured against these rules
  ("set the darams server migration mission to seventy five percent", 62
  characters) and short enough that anything discursive falls through.
*/
const MAX_LENGTH = 120;

/*
  Politeness and wake words, stripped before matching.

  Worth doing rather than pattern-matching around: he says "can you tick off my
  morning routine", and the rules below all want the verb first. Stripping is
  safe because the remainder still has to match a command — "can you tell me
  about the gym page" becomes "tell me about the gym page", which matches
  nothing and returns null exactly as it should.
*/
/*
  Widened 2026-09-02 after probing the owner's actual register.

  "yeah i did push day" matched NOTHING, because "yeah" was missing from this
  list while "ok" and "so" were in it. His real Whisper transcripts from 31
  August literally begin "Okay.", "Yeah. Okay." and "Mm-hmm" — spoken agreement
  is how he starts a sentence, and Whisper faithfully transcribes it.

  This does not widen what MATCHES. It normalises the same sentence so the rules
  below see the words carrying meaning, which is a different and far safer kind
  of change than loosening a pattern. The must-not-match set was re-run after.
*/
const FILLER = /^(hey|ok|okay|yeah|yea|yep|yup|yes|alright|all right|well|so|um+|uh+|erm+|right|now|operator|please|can you|could you|would you|will you|i want you to|i need you to|go ahead and|just)\b[\s,]*/;
const TRAILING = /[\s,]*(please|thanks|thank you|mate|cheers)$/;

/*
  Work on the app itself, which is never a capability action.

  This is NOT `routing.mjs`'s `NEEDS_CODE` reused, and the reason is a real
  collision: that table matches a bare `push`, and "push" is the single most
  important word in this file. "I did push day" would be classified as a git
  operation and dropped. Git is named here through the words that cannot mean
  training — commit, merge, rebase, branch — and `push` is left to the gym.
*/
const SOUNDS_LIKE_CODE = [
  /\b(commit|merge|rebase|branch|pull request|stash|checkout)\b/,
  /\b(git|npm|npx|tsc|vite|node|typecheck|lint|stack trace)\b/,
  /\b(fix|debug|refactor|implement|deploy|rewrite|revert)\b/,
  /\.(tsx?|jsx?|mjs|cjs|json|css|md)\b/,
  /\b(server|src|docs)\//,
  /\b(codebase|repo|repository|source code)\b/,
  /*
    One optional word in the middle, because it is almost always the feature's
    name: "the gym page", "the mission board button". Matching only the adjacent
    pair let "set the gym page to 60 percent width" through as a request to move
    a mission's progress bar — caught by the self-test, not by reading it.

    "build" is deliberately NOT in this list. It is a plausible word in a real
    mission name ("the server build"), so it is matched below only in the shapes
    that can only mean a failing compile.
  */
  /\b(the|a|my|that)\s+(\w+\s+)?(page|component|button|screen|endpoint|route|hook)\b/,
  /\bbuild (failed|failing|is broken|broke|error)\b/,
  /*
    The one phrase in this repo where "push" is not the gym, and the exception
    that proves leaving `push` to the gym was still right: "I finished the push
    notification work" matched a session guard of `push`, which on a push day
    is a guard that passes — the whole session ticked off for a sentence about
    ntfy. Named as the two words together, so a bare `push` is untouched.
  */
  /\bpush notification/,
];

/*
  A question is not an instruction.

  Deliberately not a blanket "starts with an interrogative": "did legs today" is
  a statement and "did I do legs today" is a question, and the difference is
  entirely the pronoun after the verb. Getting that backwards would either drop
  his most natural phrasing or tick a session off because he asked whether he
  had trained.

  Read intents run BEFORE this, because for them a question is the whole point.
*/
const ASKING = [
  /^(did|do|does|have|has|had|was|were)\s+(i|you|we|he|she|they|it|that|this)\b/,
  /^(is|are|am|will|shall|should|can|could|would|why|how|which|who|whose|when|where|what|whats|hows)\b/,
  /\bhow (was|did|is|are)\b/,
  /*
    The same shape over a possessive, which the pronoun rule above misses:
    "was my routine done" is a question and it was ticking his entire routine
    off. `did` is deliberately NOT in this list — "did my routine" is the same
    dropped-pronoun statement as "did legs today", which is his own phrasing
    and already passes above. Every other auxiliary in front of a possessive is
    unambiguously interrogative.
  */
  /^(was|were|has|have|had)\s+(my|your|our|the|this|that)\b/,
];

/*
  Not yet, not sure, not me.

  Future tense is the dangerous one: "I'm going to do push day later" is a plan,
  and ticking it off is a lie the owner would have to notice before he could
  correct it.
*/
const HYPOTHETICAL = [
  /\b(going to|gonna|about to|planning to|thinking about|want to|need to|have to|should|might|maybe|if i|remind me)\b/,
  /\b(later|tonight|in a bit|afterwards)\b/,
];

/*
  Two instructions in one breath. Each half may be fine; the pair is not.

  "and then" was not enough. "Skip today and mark the epyc mission as complete"
  contains no `then`, matched the skip, and dropped the second half silently —
  which is worse than declining both, because he watches the skip land and has
  no reason to check the mission. A bare `\band\b` would be simpler and wrong:
  "chest and back", "a hundred and fifty" are one instruction each. So the
  second clause is recognised by the thing that makes it a clause — an
  imperative verb of its own.
*/
const MULTI_CLAUSE = [
  /\band (then|also|after that|afterwards)\b/,
  /\band\s+(tick|check|cross|mark|set|move|bump|put|add|create|make|delete|remove|skip|open|play|pause|start|stop|send|remind|log|update|tell|show)\b/,
];

/*
  Some of it, which is not all of it.

  Both sweeping intents tick everything they find, so "I did half my routine"
  and "I did a bit of legs" wrote a completed day out of a sentence that said
  the opposite. There is no way to tick "half" — the honest answer is to
  decline and let him say which parts.
*/
const PARTIAL = /\b(half|most|some|part|bit|a few|couple|nearly|almost)\b/;

/*
  Negation, applied AFTER the skip rules and before everything else.

  "not training today" is a skip, so a blanket negation guard would throw away a
  real intent. Every other rule here means "this happened", and "I didn't do
  legs" means it did not.

  `not started` is carved out because it is not a negation at all — it is the
  literal name of a mission status, and without the exception `STATUS_WORDS`
  carried an entry that could never once fire.
*/
const NEGATED = /\b(not(?!\s+started)|no|never|didnt|dont|wasnt|havent|isnt|cant)\b/;

// --- dates -------------------------------------------------------------------

/** Local calendar day, matching `toDateKey()` — never UTC (OPS-009). */
function dayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/*
  Date references this file can read, and the far larger set it cannot.

  Everything unrecognised aborts the whole intent rather than falling back to
  today, which is the one place a silent default would be actively harmful: "I
  did legs on Monday" defaulting to today writes a tick onto the wrong day, and
  he would have to notice a tick he did not make to find it. A weekday name is
  genuinely ambiguous anyway — last Monday or next — so the model path is the
  right owner of it.
*/
const UNPARSEABLE_DATE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|last night|last week|next week|ago|this morning|\d{1,2}(st|nd|rd|th)|\d{4}-\d{2}-\d{2})\b/;

/** @returns a `YYYY-MM-DD` key, or null meaning "abandon this intent". */
function dateIn(text) {
  /*
    Two days named is two instructions. "Skip today and tomorrow" skipped only
    tomorrow — the tests below are ordered, the first one to hit wins, and which
    half of his sentence survived was an accident of that order. A request half
    carried out is worse than one declined, because the half that landed is the
    proof it was understood.
  */
  const days = text.match(/\b(today|tomorrow|yesterday)\b/g) ?? [];
  if (new Set(days).size > 1) return null;
  if (/\btomorrow\b/.test(text)) return dayKey(1);
  if (/\byesterday\b/.test(text)) return dayKey(-1);
  if (UNPARSEABLE_DATE.test(text)) return null;
  return dayKey(0);
}

/*
  A claim about something already done cannot be about a future day.

  "I did push day tomorrow" is not a sentence anyone means, but it parsed
  cleanly and wrote a tick onto tomorrow — a mishearing of "I'll do push day
  tomorrow" would land it there silently, and a tick on a day that has not
  happened is invisible until it is wrong. String comparison is safe on
  `YYYY-MM-DD` and avoids reasoning about clocks.
*/
function notFuture(date) {
  return date && date <= dayKey(0) ? date : null;
}

// --- numbers -----------------------------------------------------------------

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/** "seventy five" → 75. Null for anything it does not fully understand. */
function wordsToNumber(words) {
  let total = null;
  for (const part of words.split(/[\s-]+/).filter(Boolean)) {
    if (part === "a" || part === "and") continue;
    if (part === "hundred") total = total === null ? 100 : total * 100;
    else if (part in TENS) total = (total ?? 0) + TENS[part];
    else if (part in UNITS) total = (total ?? 0) + UNITS[part];
    else return null;
  }
  return total;
}

/*
  A percentage, digits or words.

  Whisper writes "60" sometimes and "sixty" others depending on how it was said,
  so both have to work or the same sentence succeeds and fails at random. The
  window before the unit is capped and read from the right, because the words
  immediately before "percent" are the number and everything earlier is the
  mission's name.

  Out of range returns null rather than clamping: "set it to a hundred and fifty
  percent" is a misheard sentence, not a request to write 100.
*/
function percentIn(text) {
  /*
    The word boundary belongs to the words, not to the sign. Written as
    `(?:%|percent)\b` it applied to both alternatives — and `%` is not a word
    character, so a boundary after it needs a letter next, which "45%" at the
    end of a sentence never has. The `%` branch therefore matched nothing at
    all, in any sentence, while reading as though it were supported.
  */
  const m = /(?:^|\s)([a-z0-9\s-]{1,24}?)\s*(?:%|(?:percent|per cent)\b)/.exec(text);
  if (!m) return null;
  const tail = m[1].trim().split(/\s+/).slice(-3);
  for (let i = 0; i < tail.length; i++) {
    const chunk = tail.slice(i).join(" ");
    let value = null;
    if (/^\d{1,3}$/.test(chunk)) value = Number(chunk);
    else if (chunk === "half") value = 50;
    else value = wordsToNumber(chunk);
    if (value === null) continue;
    return value >= 0 && value <= 100 ? value : null;
  }
  return null;
}

// --- names -------------------------------------------------------------------

const NAME_NOISE = /^(the|my|a|an|that|this)\s+/;
/** Words too generic to resolve against anything. A pronoun is not a name. */
const NOT_A_NAME = new Set(["it", "that", "this", "them", "one", "thing", "mission"]);

function cleanName(raw) {
  let name = String(raw ?? "").trim();
  while (NAME_NOISE.test(name)) name = name.replace(NAME_NOISE, "");
  name = name.replace(/\s+mission$/, "").trim();
  if (name.length < 3 || NOT_A_NAME.has(name)) return null;
  return name;
}

// --- read intents ------------------------------------------------------------

/*
  The clock, and nothing else.

  It is here because its absence was measured and expensive: "what time is it"
  fell through to a rate-limited classifier on 2026-08-31, landed on Claude
  Code, and cost $0.58 to shell out to `Get-Date`. `routing.mjs` already
  short-circuits it to the cheap worker; this removes the worker entirely.

  **No other read is fast-pathed, deliberately.** `now` is the one whose answer
  is already a spoken sentence — the action formats `readable` that way on
  purpose. `gym_day`, `calendar_range` and `missions_list` return structures
  that need prose written about them, and prose is what a model is for. Bypassing
  it to save a second would trade a misroute for a machine reading JSON aloud.
*/
const CLOCK = [
  /\btime is it\b/,
  /^(whats|what is|hows|how is)\s+(the\s+)?(time|date|day)\b/,
  /\bwhat (day|date) is it\b/,
  /\b(todays|today is what)\s+(date|day)\b/,
  /\b(tell|give) me the (time|date)\b/,
];

/*
  Somewhere else, or some other clock.

  `now` reports this machine's local time and nothing else. "What time is it in
  Tokyo" matched it and would have been answered confidently with the wrong
  answer — the worst kind of read, because it looks like it worked.
*/
const ELSEWHERE = /\btime is it in\b|\b(utc|gmt|est|pst|cet|time ?zone)\b/;

function matchClock(text) {
  if (ELSEWHERE.test(text)) return null;
  if (!CLOCK.some((re) => re.test(text))) return null;
  return {
    action: "now",
    params: {},
    needs: null,
    why: "asking the clock — no worker needed",
  };
}

// --- device intents ----------------------------------------------------------

/*
  Zero-parameter actions, matched against the whole utterance rather than
  anywhere inside it.

  There is nothing to get wrong in the parameters, so the only possible mistake
  is firing on a sentence that merely contains the word — "pause the build for a
  second" must not pause his music. Anchoring both ends is the whole guard.
*/
const MEDIA = /^(pause|unpause|resume|play)(\s+(the|my|some|it|that))*(\s+(music|song|track|tune|audio|video|spotify))?$/;
const SUMMON = /^(summon|wake up|bring up|bring back|show|open|focus)\s+(me\s+)?(operator|yourself|the dashboard)$/;

function matchDevice(text) {
  if (MEDIA.test(text)) {
    return {
      action: "media_play_pause",
      params: {},
      needs: null,
      why: "media key — the same signal a headset button sends",
    };
  }
  if (SUMMON.test(text) || text === "summon") {
    return {
      action: "focus_operator",
      params: {},
      needs: null,
      why: "bringing Operator's window to the front",
    };
  }
  return null;
}

// --- gym ---------------------------------------------------------------------

/*
  Skip and rest, which are the only writes here that run with no lookup at all.

  They can afford to: the date is the only parameter, `gym_skip_day` is idempotent,
  and the undo is one action away. Everything else that writes goes through a read
  first.

  The negations are part of the pattern rather than a problem for the negation
  guard — "not training today" and "no gym today" are the natural ways to say it,
  and they mean the same as "rest day".
*/
const SKIP = [
  /^skip (today|it|the gym|training|my session)\b/,
  /^(im |i am |having )?(a )?rest day\b/,
  /*
    Anchored, unlike its first draft. Loose in the middle of a sentence, "no
    gym" marked the day skipped for "there is no gym near me" and "no gym
    motivation today" — a write onto his data from a sentence that was not
    addressed to it. As a whole utterance the phrase can only mean the skip.
  */
  /^(im |i am |its |it is |todays |today is )?(a )?(not training|no gym|no training)( today| tomorrow)?$/,
  /\bskip(ped|ping) (the )?(gym|training|my session|todays session)\b/,
];
const UNSKIP = [/^un-?skip\b/, /\bundo (the )?(rest day|skip)\b/];

function matchGymSkip(text) {
  const unskip = UNSKIP.some((re) => re.test(text));
  if (!unskip && !SKIP.some((re) => re.test(text))) return null;
  const date = dateIn(text);
  if (!date) return null;
  return {
    action: unskip ? "gym_unskip_day" : "gym_skip_day",
    params: { date },
    needs: null,
    why: unskip ? "putting the session back on" : "marking the day as not trained",
  };
}

/*
  "I did push day."

  The verb has to be past tense and the sentence has to name training, or this
  matches "I did the shopping". `day` is deliberately NOT one of the training
  nouns — it appears in half of all sentences and made "I did a good day" tick a
  session off in an early draft. The session labels carry it instead: "push day"
  matches on `push`.
*/
const DID_VERB = /^(i\s+|ive\s+|i have\s+)?(just\s+)?(did|done|finished|completed|smashed|nailed|trained|went)\b/;
/*
  `session` is qualified, unlike the rest of this list.

  On its own it belongs to as many other things as it does to the gym — "I did
  a session with my therapist" ticked off a whole training day. Every other word
  here can only mean training, so only this one has to say whose session it was.
*/
const TRAINING_NOUN = /\b(gym|training|trained|workout|work out|lift|lifted)\b|\b(gym|training|my|todays) session\b/;
const SESSION_LABEL =
  /\b(push|pull|legs?|upper|lower|chest|back|shoulders?|arms?|full body|cardio)\b/;

/** "legs" → "leg", so a spoken label still matches a session named "Leg Day". */
function stem(label) {
  return label.endsWith("s") ? label.slice(0, -1) : label;
}

/*
  The terse form, which is how it is actually said out loud.

  "Legs done." "Gym done." No verb, no pronoun, nothing for `DID_VERB` to catch.
  Anchored at both ends so it stays a whole utterance — inside a longer sentence
  "legs done" could be half of anything.
*/
const TERSE_DONE =
  /^(gym|training|session|workout|push|pull|legs?|upper|lower|chest|back|arms?|shoulders?)( day)?\s+(done|finished|complete|completed|smashed)$/;

function matchGymDone(text) {
  const terse = TERSE_DONE.test(text);
  if (!DID_VERB.test(text) && !terse) return null;
  /*
    The word "routine" hands the sentence to the routine rule below.

    `gym` is one of Daily Routine's seven section keys as well as a training
    noun, so "I did my gym routine" satisfied this rule first and ticked every
    exercise in today's session — with `expect` null, because no session label
    was said, so nothing downstream could catch it either. When he names the
    feature, the feature wins.
  */
  if (/\broutine\b/.test(text)) return null;
  const label = SESSION_LABEL.exec(text)?.[1] ?? null;
  /*
    The terse form has already proved itself by being the entire utterance, so
    it is exempt from the noun check — "session done" is not ambiguous the way
    "I did a session with my therapist" is, because there is no rest of the
    sentence for the session to belong to.
  */
  if (!terse && !label && !TRAINING_NOUN.test(text)) return null;
  // Every exercise gets ticked, so a sentence that said "half" must not fire.
  if (PARTIAL.test(text)) return null;
  const date = notFuture(dateIn(text));
  if (!date) return null;

  return {
    action: "gym_toggle_exercise",
    params: { date },
    needs: {
      from: "gym_day",
      args: { date },
      find: "gym_exercise",
      // Every exercise on the day, not a named one — "I did push day" is a claim
      // about the session, not about an exercise.
      match: null,
      each: true,
      /*
        Toggles, so anything already ticked must be left alone or this unticks
        the half he did from his phone at the gym. The action is a toggle by
        design (its own description says "untick by calling it again"), which
        makes "skip what is done" the resolver's job, not the action's.
      */
      skipDone: true,
      unique: false,
      /*
        The check that stops this being a wrong write.

        Saying "I did push day" on a leg day means one of them is wrong, and
        guessing which is not this file's business. The resolver compares this
        against `session.name` and abandons if it is not in there.
      */
      expect: label ? stem(label) : null,
    },
    why: label
      ? `you said you did ${label} — ticking that session off`
      : "you said you trained — ticking today's session off",
  };
}

// --- routine -----------------------------------------------------------------

/*
  "Tick off X" and "mark my routine done".

  `tick`/`check off` is Daily Routine's own vocabulary, so the verb alone is
  enough to route here without the sentence naming the feature — and if the words
  after it are not a step, the resolver finds nothing and nothing is written.
  That safety net is why this can be looser than the rules above.

  Note it fills `date` even though `routine_toggle_task` ignores it for one-off
  steps. That mirrors the action, which takes the parameter and decides for
  itself; the caller should not have to know which steps repeat.
*/
const TICK_OFF = [
  /^(tick|check|cross)\s+(?:it\s+)?off\s+(.+)$/,
  /^(tick|check|cross)\s+(.+?)\s+off\b/,
];
const ROUTINE_DONE =
  /\broutine\b/;
/** The seven section keys, exactly as `routine_toggle_task` validates them. */
const SECTION = /\b(morning|work|gym|learning|forex|evening|sleep)\b/;
/*
  `did` is in here and nowhere else it would be dangerous: the rule already
  requires the word "routine" in the same sentence, so "I did my routine" cannot
  be mistaken for anything. Without it, "I did my routine" returned null while
  "I have done my routine" matched — the same statement, two ways of saying it,
  and only one worked.
*/
const DONE_WORD = /\b(did|done|finished|complete|completed|sorted|ticked off)\b/;

/*
  A step and a section are not the same lookup, and conflating them made the
  headline phrase do nothing.

  "Check off my morning routine" was emitted as a step named "morning routine",
  to be found `unique`ly — but no step is called that, and even reading it as
  the section fails, because a section with more than one step is by definition
  not unique. The intent matched, reported itself as a routine tick, and
  resolved to nothing every time. Naming a step means exactly one thing; naming
  a section, or nothing at all, means sweep what is in it.
*/
function matchRoutine(text) {
  let step = null;
  let section = null;
  let named = false;

  for (const re of TICK_OFF) {
    const hit = re.exec(text);
    if (!hit) continue;
    const what = cleanName(hit[2]);
    if (!what) return null;
    named = true;
    // "tick off my morning routine" names the section, not a step in it.
    if (ROUTINE_DONE.test(what)) section = SECTION.exec(what)?.[1] ?? null;
    else step = what;
    break;
  }

  // "mark my routine done", "routine's finished", "did my routine".
  if (!named) {
    if (!ROUTINE_DONE.test(text) || !DONE_WORD.test(text)) return null;
    section = SECTION.exec(text)?.[1] ?? null;
  }

  const sweeping = step === null;
  if (sweeping && PARTIAL.test(text)) return null;

  const date = notFuture(dateIn(text));
  if (!date) return null;

  const match = step ?? section;
  return {
    action: "routine_toggle_task",
    params: { date },
    needs: {
      from: "routine_day",
      args: { date },
      find: "routine_step",
      match,
      // A named step is one step; a section, or "my routine", is all of them.
      each: sweeping,
      skipDone: true,
      unique: !sweeping,
      expect: null,
    },
    why: step
      ? `ticking "${step}" off your routine`
      : section
        ? `ticking off your ${section} routine`
        : "ticking today's routine off",
  };
}

// --- missions ----------------------------------------------------------------

/*
  "Set the server build to sixty percent."

  No lookup can save a wrong number, so the number is the strict part: the
  percentage must be explicit. "Set the server build to sixty" is not enough —
  sixty of what — and it returns null.

  The word "mission" is not required, because a percentage is mission vocabulary
  on its own. Nothing else in Operator has one, and the name still has to resolve
  to exactly one mission or the resolver abandons.
*/
/** An instruction: the verb says it is addressed to Operator. */
const PROGRESS_IMPERATIVE = /^(?:set|move|update|bump|take)\s+(.+?)\s+(?:to|at)\s+/;
/*
  An observation, which is only sometimes addressed to Operator at all — and so
  the one shape here that requires the word "mission".

  "The server is at 90 percent" is a sentence about a disk, and it found the one
  mission with `server` in its name and overwrote its progress. No word list
  separates a subject that is a mission from one that is a filling drive, which
  is the same argument `matchMissionStatus` makes below and the same answer:
  make him say which board he means. The imperative above needs no such proof —
  "set X to 90 percent" is spoken to something.
*/
const PROGRESS_DECLARATIVE = /^(.+?)\s+is\s+(?:now\s+)?(?:at|on)\s+/;

/*
  Things that have a percentage and are not a mission.

  "A percentage is mission vocabulary" is true inside Operator and false out
  loud: "the battery is at 20 percent" and "my phone is on 5 percent" both
  produced a `mission_set_progress`. The unique-name check downstream catches
  most of it — but "the server is at 90 percent" is a sentence about a disk
  that will find exactly one mission with `server` in its name and overwrite
  its progress, which is why this list exists rather than trusting the resolver.
*/
const NOT_A_MISSION = /\b(battery|charge|charged|disk|drive|storage|memory|ram|cpu|gpu|volume|brightness|phone|laptop|humidity|signal|rain)\b/;

function matchMissionProgress(text) {
  const progress = percentIn(text);
  if (progress === null) return null;
  if (NOT_A_MISSION.test(text)) return null;

  let name = null;
  const told = PROGRESS_IMPERATIVE.exec(text);
  if (told) name = cleanName(told[1]);
  else {
    const said = PROGRESS_DECLARATIVE.exec(text);
    if (said && /\bmission\b/.test(text)) name = cleanName(said[1]);
  }
  if (!name) return null;

  return {
    action: "mission_set_progress",
    params: { progress },
    needs: {
      from: "missions_list",
      args: {},
      find: "mission",
      match: name,
      each: false,
      skipDone: false,
      // Two missions matching "server" is not a coin toss to be resolved by
      // taking the first. Abandon and let him say which.
      unique: true,
      expect: null,
    },
    why: `setting "${name}" to ${progress}%`,
  };
}

/*
  Status, which DOES require the word "mission" — the one rule here that asks
  for it.

  "Mark X as done" is the same sentence for a mission, a routine step and an
  exercise, and no word list separates them. Rather than pick, this only fires
  when he says which board he means. Narrow on purpose, and widening it later
  costs one regex; unwinding a status written onto the wrong record costs him
  noticing it first.
*/
/*
  Ordered, and the last two are the reason.

  `not started` has to be tested before `started`, or "mark the epyc mission as
  not started" reads the substring and writes `in_progress` — the opposite of
  what was said, onto a real record. It never fired while the negation guard
  swallowed the whole sentence; carving `not started` out of that guard is what
  made the ordering load-bearing rather than theoretical.
*/
const STATUS_WORDS = [
  [/\b(complete|completed|done|finished)\b/, "complete"],
  [/\b(blocked|stuck|waiting on)\b/, "blocked"],
  [/\bnot started\b/, "not_started"],
  [/\b(started|in progress|underway|going)\b/, "in_progress"],
];
const STATUS_PHRASES = [
  /^(?:mark|set|put)\s+(.+?)\s+mission\s+(?:as|to)\s+/,
  /^(?:mark|set|put)\s+(?:the\s+|my\s+)?mission\s+(.+?)\s+(?:as|to)\s+/,
  /^(.+?)\s+mission\s+is\s+/,
];

function matchMissionStatus(text) {
  if (!/\bmission\b/.test(text)) return null;

  let status = null;
  for (const [re, value] of STATUS_WORDS) {
    if (re.test(text)) {
      status = value;
      break;
    }
  }
  if (!status) return null;

  let name = null;
  for (const re of STATUS_PHRASES) {
    const hit = re.exec(text);
    if (hit) {
      name = cleanName(hit[1]);
      break;
    }
  }
  if (!name) return null;

  return {
    action: "mission_set_status",
    params: { status },
    needs: {
      from: "missions_list",
      args: {},
      find: "mission",
      match: name,
      each: false,
      skipDone: false,
      unique: true,
      expect: null,
    },
    why: `marking "${name}" as ${status.replace("_", " ")}`,
  };
}

// --- the router --------------------------------------------------------------

function normalise(raw) {
  let text = String(raw ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "")
    .replace(/'/g, "")
    .replace(/[.,!?;:"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Repeated, because "hey operator can you..." is three of them stacked.
  let previous;
  do {
    previous = text;
    text = text.replace(FILLER, "").replace(TRAILING, "").trim();
  } while (text !== previous);

  return text;
}

/**
 * Turn a spoken sentence into one capability action, or say nothing.
 *
 * @param {string} transcript  what was heard, raw
 * @returns {{action: string, params: object, needs: object|null, why: string} | null}
 *
 * `needs === null` means the intent is runnable as it stands. Otherwise the
 * caller must run `needs.from` first and fill the remaining parameters — see
 * `RESOLVERS`. A resolver that finds nothing must abandon the intent, never
 * fall back to running the action with what it has.
 */
/*
  ## Asking what today's session is — a READ, and the first rule written from
  ## real evidence rather than invention

  Every other phrase in this file's test suite was made up. This one was not:
  `scripts/intent-misses.mjs` reported, from actual transcripts, that the most
  common thing falling through was *"What's on my gym plan tomorrow?"* and
  *"What's on gym today?"*. Three of twenty-three misses, and the largest real
  cluster.

  ## Why this is allowed to be a question when nothing else is

  `matchIntent` rejects questions outright — `MUST_NOT` even names "a question
  about the gym" — and that guard is right, because a question must never become
  a WRITE. "Should I do push day tomorrow?" is not permission to tick it off.

  The guard is about writes. `matchClock` already sits above it for exactly this
  reason: "what time is it?" is a question and `now` only reads. This is the
  same shape and takes the same position, and it may only ever emit `gym_day`.
  A read that gets it wrong says the wrong thing, which costs a correction; a
  write that gets it wrong changes his training log.

  So: placed before the question guard, emitting a read and nothing else, and
  the must-not list below gains the phrasings that are still writes.
*/
const GYM_QUESTION = [
  /\bwhat(s| is| are)?\b.{0,20}\bgym\b/,
  /\bwhat(s| is| are)?\b.{0,20}\b(session|workout|training)\b/,
  /\bwhat am i (doing|training|hitting)\b/,
  /\bwhats? on\b.{0,20}\b(gym|session|workout|training)\b/,
  /\bwhats\b.{0,15}\b(gym|session|workout|training)\b/,
];

/*
  Phrasings that mention the gym but are not asking what is on it. Checked
  first, because several of them contain the words the patterns above look for.
*/
const NOT_A_GYM_QUESTION = [
  // A claim about having trained — that is matchGymDone's, and it writes.
  /\b(i|ive|i have|just)\b.{0,12}\b(did|done|finished|smashed|completed)\b/,
  // Ticking something off.
  /\b(tick|check|mark|cross)\b.{0,10}\b(off|done)\b/,
  // About the PAGE or the code, not the session.
  /\b(gym|workout)\b.{0,12}\b(page|screen|tab|button|component)\b/,
];

function matchGymQuestion(text) {
  if (NOT_A_GYM_QUESTION.some((re) => re.test(text))) return null;
  if (!GYM_QUESTION.some((re) => re.test(text))) return null;

  const date = dateIn(text);
  if (!date) return null;

  return {
    action: "gym_day",
    params: { date },
    needs: null,
    why: `reading the gym session for ${date} — a question, so nothing is written`,
  };
}

export function matchIntent(transcript) {
  const asked = /\?/.test(String(transcript ?? ""));
  const text = normalise(transcript);
  if (!text) return null;
  if (text.length > MAX_LENGTH) return null;
  if (MULTI_CLAUSE.some((re) => re.test(text))) return null;
  if (SOUNDS_LIKE_CODE.some((re) => re.test(text))) return null;

  /*
    Reads first, because they are the intents where a question mark is EXPECTED.
    Both of these only read; neither can reach a write. Everything below the
    guard that follows can.
  */
  const clock = matchClock(text);
  if (clock) return clock;

  const gymQuestion = matchGymQuestion(text);
  if (gymQuestion) return gymQuestion;

  if (asked || ASKING.some((re) => re.test(text))) return null;
  if (HYPOTHETICAL.some((re) => re.test(text))) return null;

  const device = matchDevice(text);
  if (device) return device;

  // Before the negation guard — a skip is usually phrased as a negative.
  const skip = matchGymSkip(text);
  if (skip) return skip;
  if (NEGATED.test(text)) return null;

  return matchGymDone(text) ?? matchRoutine(text) ?? matchMissionProgress(text) ?? matchMissionStatus(text);
}

// --- self-test ---------------------------------------------------------------
//
// Run: "C:\Program Files\nodejs\node.exe" server/intent.mjs --self-test
//
// Two lists, and the second one is the important one. Every phrase in MUST_NOT
// is a sentence that sounds like a command and is not: a question about the
// gym, a plan to train later, work on the app, a Whisper hallucination. Each
// one that starts matching is a write onto his data he did not ask for.
//
// The third check imports the real registry: every action name this file can
// emit must still exist in `server/actions.mjs`. A rename there would otherwise
// leave this quietly emitting an action nothing can run.

const MUST_MATCH = [
  /*
    Reads. These are QUESTIONS, which everything below deliberately refuses —
    see matchGymQuestion for why that guard is about writes rather than about
    question marks. The action is asserted exactly, so a change that turned
    one of these into a toggle fails here and not in his gym log.

    The first two are real: scripts/intent-misses.mjs found them in actual
    transcripts, which makes them the only phrases in this file that were not
    invented.
  */
  ["What's on my gym plan tomorrow?", "gym_day"],
  ["What's on gym today?", "gym_day"],
  ["whats my gym session look like for today", "gym_day"],
  ["what am i training today", "gym_day"],
  ["what time is it?", "now"],
  ["whats the time", "now"],
  ["what day is it", "now"],
  ["hey operator, tell me the date", "now"],
  ["i did push day", "gym_toggle_exercise"],
  ["did legs today", "gym_toggle_exercise"],
  ["went gym", "gym_toggle_exercise"],
  ["i trained today", "gym_toggle_exercise"],
  ["smashed pull day", "gym_toggle_exercise"],
  ["i did push day yesterday", "gym_toggle_exercise"],
  ["skip today", "gym_skip_day"],
  ["rest day", "gym_skip_day"],
  ["im not training today", "gym_skip_day"],
  ["unskip today", "gym_unskip_day"],
  ["mark my routine done", "routine_toggle_task"],
  ["can you tick off meditation", "routine_toggle_task"],
  ["check off my morning routine", "routine_toggle_task"],
  ["set the server build to 60 percent", "mission_set_progress"],
  ["move darams to seventy five percent", "mission_set_progress"],
  ["mark the epyc mission as complete", "mission_set_status"],
  ["the darams mission is blocked", "mission_set_status"],
  ["pause the music", "media_play_pause"],
  ["summon operator", "focus_operator"],
  ["show me the dashboard", "focus_operator"],
  ["legs done", "gym_toggle_exercise"],
  ["gym done", "gym_toggle_exercise"],
  ["i did my routine", "routine_toggle_task"],
  ["i skipped the gym", "gym_skip_day"],
  ["rest day tomorrow", "gym_skip_day"],
  // "gym" is a routine section as well as a training noun; the named feature wins.
  ["i did my gym routine", "routine_toggle_task"],
  ["tick off my evening routine", "routine_toggle_task"],
  // Reachable only since `not started` was carved out of the negation guard.
  ["mark the epyc mission as not started", "mission_set_status"],
  ["the darams mission is at 75 percent", "mission_set_progress"],
  ["i finished my gym session", "gym_toggle_exercise"],
  ["session done", "gym_toggle_exercise"],
  // Whisper writes the sign as often as the word; the sign never once matched.
  ["set darams to 45%", "mission_set_progress"],
];

const MUST_NOT = [
  /*
    Still nothing, even though they mention the gym. Whether he SHOULD train,
    or how a past session went, is conversation — answering it needs a worker,
    and matching it here would give a confident wrong answer from a rule that
    cannot reason.
  */
  "should i do push day tomorrow",
  "how did my gym session go",
  "is the gym page broken",
  "",
  "   ",
  "fix the gym page",
  "how was my gym session",
  "did i do push day",
  "im going to do push day later",
  "should i skip today",
  "add a mission for the server build",
  "put dentist on the calendar tomorrow at 3",
  "delete the gym mission",
  "i did push day and then add a mission",
  "thanks for watching",
  "mm-hmm",
  "can you commit this and push it",
  "i did legs on monday",
  "remind me to do legs tomorrow",
  "what should i train today",
  "i didnt do legs today",
  "set the server build to sixty",
  "tick off it",
  "i did the shopping",
  "have i done my routine",
  "the gym page is showing yesterdays session and it should be showing todays session instead",
  // Past tense about a future day: a mishearing, never an instruction.
  "i did push day tomorrow",
  "ill do my routine tomorrow",
  // Another clock entirely — `now` only knows this machine's.
  "what time is it in tokyo",
  "whats the time in utc",
  // A word this file owns, in a sentence about the app.
  "pause the build for a second",
  "set the gym page to 60 percent width",
  "i finished the push notification work",
  // Some of it is not all of it, and every sweep here ticks all of it.
  "i did half my routine",
  "i did most of my routine",
  "i did a bit of legs today",
  // A question phrased over a possessive rather than a pronoun.
  "was my routine done",
  "has my session finished",
  // Two commands joined by a bare "and" — one of them would be dropped silently.
  "skip today and mark the epyc mission as complete",
  "tick off meditation and delete the gym mission",
  "i did push day and add a mission",
  // A percentage about something that is not a mission.
  "the battery is at 20 percent",
  "my phone is on 5 percent",
  // "no gym" loose in a sentence that is not about training.
  "there is no gym near me",
  "no gym motivation today",
  // A percentage stated about something that has one and is not a mission.
  "the server is at 90 percent",
  "set the volume to 50 percent",
  // Two days named: whichever one won would be half of what he said.
  "skip today and tomorrow",
  "i did legs yesterday and today",
  // A session that was not a training session.
  "i did a session with my therapist",
];

async function selfTest() {
  const fail = [];
  const out = [];
  /*
    Counted as they run rather than added up at the end. The total used to be a
    formula over the list lengths plus a hand-written constant, and the constant
    was one short — a suite that miscounts itself is one nobody can tell has
    stopped running a check.
  */
  let checks = 0;
  const line = (ok, text) => {
    checks += 1;
    return `  ${ok ? "ok  " : "FAIL"}  ${text}`;
  };

  out.push("MUST MATCH");
  for (const [phrase, expected] of MUST_MATCH) {
    const hit = matchIntent(phrase);
    const ok = hit?.action === expected;
    if (!ok) fail.push(`"${phrase}" → ${hit?.action ?? "null"}, wanted ${expected}`);
    out.push(line(ok, `${JSON.stringify(phrase)} → ${hit?.action ?? "null"}`));
  }

  out.push("", "MUST NOT MATCH");
  for (const phrase of MUST_NOT) {
    const hit = matchIntent(phrase);
    const ok = hit === null;
    if (!ok) fail.push(`"${phrase}" → ${hit.action}, wanted null`);
    out.push(line(ok, `${JSON.stringify(phrase)} → ${hit ? hit.action : "null"}`));
  }

  out.push("", "PARAMS");
  const yesterday = matchIntent("i did push day yesterday");
  const yOk = yesterday?.params.date === dayKey(-1) && yesterday?.needs.expect === "push";
  if (!yOk) fail.push('"i did push day yesterday" got the wrong date or session guard');
  out.push(line(yOk, `yesterday → ${yesterday?.params.date}, expect ${yesterday?.needs.expect}`));

  const legs = matchIntent("did legs today");
  const lOk = legs?.needs.expect === "leg";
  if (!lOk) fail.push('"did legs today" should guard on the stem "leg"');
  out.push(line(lOk, `legs → expect ${legs?.needs.expect}`));

  const pct = matchIntent("move darams to seventy five percent");
  const pOk = pct?.params.progress === 75 && pct?.needs.match === "darams";
  if (!pOk) fail.push('"move darams to seventy five percent" parsed wrong');
  out.push(line(pOk, `words → ${pct?.params.progress}% on ${JSON.stringify(pct?.needs.match)}`));

  const all = matchIntent("mark my routine done");
  const aOk = all?.needs.match === null && all?.needs.each === true && all?.needs.unique === false;
  if (!aOk) fail.push('"mark my routine done" should sweep every step');
  out.push(line(aOk, `whole routine → each=${all?.needs.each} match=${all?.needs.match}`));

  /*
    The two routine shapes, asserted on the lookup and not just the action name.
    Checking only `action === "routine_toggle_task"` is what let a section be
    emitted as a uniquely-named step for a while: the suite passed and the
    intent resolved to nothing.
  */
  const sect = matchIntent("check off my morning routine");
  const sOk = sect?.needs.match === "morning" && sect?.needs.each === true && sect?.needs.unique === false;
  if (!sOk) fail.push('"check off my morning routine" should sweep the morning section');
  out.push(line(sOk, `section → match=${JSON.stringify(sect?.needs.match)} each=${sect?.needs.each} unique=${sect?.needs.unique}`));

  const one = matchIntent("tick off meditation");
  const oOk = one?.needs.match === "meditation" && one?.needs.each === false && one?.needs.unique === true;
  if (!oOk) fail.push('"tick off meditation" should be one uniquely-named step');
  out.push(line(oOk, `step → match=${JSON.stringify(one?.needs.match)} each=${one?.needs.each} unique=${one?.needs.unique}`));

  const ns = matchIntent("mark the epyc mission as not started");
  const nOk = ns?.params.status === "not_started" && ns?.needs.match === "epyc";
  if (!nOk) fail.push('"not started" must not be read as the substring "started"');
  out.push(line(nOk, `not started → ${ns?.params.status} on ${JSON.stringify(ns?.needs.match)}`));

  out.push("", "ACTION NAMES EXIST");
  const { listActions } = await import("./actions.mjs");
  const real = new Set(listActions().map((a) => a.name));
  for (const name of EMITTED_ACTIONS) {
    const ok = real.has(name);
    if (!ok) fail.push(`action "${name}" is not in actions.mjs`);
    out.push(line(ok, name));
  }
  for (const read of ["gym_day", "routine_day", "missions_list"]) {
    const ok = real.has(read);
    if (!ok) fail.push(`read action "${read}" is not in actions.mjs`);
    out.push(line(ok, `${read} (read, for needs.from)`));
  }

  console.log(out.join("\n"));
  console.log(`\n${checks} checks, ${fail.length} failed`);
  if (fail.length) {
    console.log("\n" + fail.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

if (process.argv.includes("--self-test")) await selfTest();
