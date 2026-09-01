// The few things a spoken sentence may do WITHOUT going to a worker.
//
// ## Why this is separate from intent.mjs
//
// `intent.mjs` turns speech into capability actions — ticking off a gym
// session, moving a mission's progress. It is deliberately in observe-only mode
// until real transcripts prove its phrase list, because every phrase it was
// tested on was invented.
//
// These are different in kind. They control OPERATOR ITSELF rather than his
// data: arming the terminal, and stopping it. They cannot wait for that
// evidence, because arming is the thing that has to work before anything else
// can — and the owner's own framing is that his voice should do it.
//
// So this file is small, closed, and paranoid, where intent.mjs is broad.
//
// ## Arming by voice is not a weakening — it is the stronger version
//
// The clap used to arm the terminal, bounded to twenty minutes because a clap
// is ANONYMOUS: any sharp sound qualifies, the detector demonstrably
// false-fired, and the window existed to bound the damage of a door slamming.
//
// A spoken sentence is identifiable. It also arrives through the browser
// microphone, on a page served over the tailnet to an authenticated device —
// so it carries an identity a clap never could.
//
// **The device still has to be one that could already arm.** Speaking does not
// grant what tapping would not: `deviceMayManage` is checked exactly as the Dev
// page's button checks it, so a voice on an unlisted device is refused the same
// way a tap on one is. This adds a way to ask, not a new permission.

/*
  Deliberately narrow. Each of these has to be something nobody says by
  accident and nothing on a television says at all — "arm the terminal" is not
  a phrase that occurs in ordinary speech or in the background of a room.

  Anchored to the START of the sentence after filler, so "I was reading about
  how you arm the terminal" does not arm the terminal.
*/
/*
  ## Stop is the one command here with the asymmetry reversed

  Everything else in this file refuses when unsure, because the cost of a wrong
  ARM is arbitrary code execution. Stop is the opposite: a stop that fires when
  he did not mean it costs one retry, and a stop that fails to fire costs money
  and changes he did not ask for.

  From a real failure, 2026-09-01: Whisper heard "Head off my morning routine"
  for "tick off", the rules correctly declined to match it, and it went to a
  worker instead — *"it does things im not even asking it to do"*.

  So this one is deliberately loose. A bare "stop" counts. It is allowed to fire
  on the television, because the worst case is a job he wanted being cancelled
  and him saying it again.
*/
const STOP =
  /^(stop|cancel|abort|halt|quit|nevermind|never mind|forget it|shut up|be quiet|quiet|wait|no no|scrap that|leave it)\b/;

const ARM = /^(arm|enable|turn on|switch on|unlock)( the| my)? (terminal|shell|panel)\b/;
const DISARM = /^(disarm|disable|turn off|switch off|lock)( the| my)? (terminal|shell|panel)\b/;

/*
  Filler, stripped first, matching the list intent.mjs uses and for the reason
  it was widened there: his real transcripts begin "Okay.", "Yeah. Okay." and
  "Mm-hmm", because spoken agreement is how he starts a sentence and Whisper
  keeps it faithfully.
*/
const FILLER =
  /^(hey|ok|okay|yeah|yea|yep|yup|yes|alright|all right|well|so|um+|uh+|erm+|right|now|operator|please|can you|could you|would you|will you|just)\b[\s,]*/;

/**
 * What this sentence asks Operator to do to itself, if anything.
 *
 * @returns `"stop"`, `"arm"`, `"disarm"`, or null — and null is overwhelmingly the
 *          normal answer. A caller must treat anything else as needing the
 *          same authorisation the equivalent button needs.
 */
export function matchVoiceCommand(transcript) {
  let text = String(transcript ?? "")
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[.,!?;:"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Repeated, because "hey operator can you turn on the terminal" stacks three.
  let previous;
  do {
    previous = text;
    text = text.replace(FILLER, "").trim();
  } while (text !== previous);

  /*
    Length cap. A long sentence that happens to contain the phrase is a
    sentence ABOUT the terminal, not an instruction to arm it — and the cost of
    being wrong here is arbitrary code execution, so the bar is high.
  */
  if (!text) return null;

  /*
    Checked BEFORE the length cap, and against a shorter one of its own.

    "Stop" is a whole utterance; "stop, I was going to say something else about
    the gym page" is a sentence that happens to start with it. Twenty-five
    characters is enough for "cancel that please" and short enough that a
    discursive sentence falls through.
  */
  if (text.length <= 25 && STOP.test(text)) return "stop";

  if (text.length > 60) return null;

  if (ARM.test(text)) return "arm";
  if (DISARM.test(text)) return "disarm";
  return null;
}

/**
 * How long a spoken arming lasts, in milliseconds. 0 means until disarmed.
 *
 * An hour rather than the clap's twenty minutes, because a voice is a far
 * stronger signal than a transient — but not unbounded, because Whisper does
 * mishear and the failure mode is a terminal left armed for days by a sentence
 * he never said. He can always say it again.
 */
export const VOICE_ARM_MS =
  Math.max(0, Number(process.env.OPERATOR_VOICE_ARM_MINUTES ?? 60) || 60) * 60_000;

/*
  Run with `node server/voicecommand.mjs --self-test`.

  Same shape as `intent.mjs`'s, and here for the same reason: this file decides
  whether a sentence can execute code or kill a running job, so the phrases it
  must NOT match are worth as much as the ones it must.

  Unlike intent.mjs's suite, several of these came from real transcripts rather
  than imagination — "head off my morning routine" is what Whisper actually
  produced for "tick off", which is the mishearing that made stop necessary.
*/
const MUST = {
  stop: [
    "stop", "Stop.", "stop it", "cancel", "cancel that", "Cancel that please.",
    "abort", "never mind", "nevermind", "shut up", "wait", "quiet", "no no",
    "forget it", "okay stop", "yeah cancel that", "hey stop",
  ],
  arm: ["arm the terminal", "Hey Operator, can you turn on the terminal?", "unlock the shell"],
  disarm: ["disarm the terminal", "lock the panel"],
};

/*
  The ones that must fall through. Each is here because it would have been a
  plausible false positive:

  - "waiting on the build" starts with "wait" but is not the word — the `\b` is
    what saves it, and it would be lost by making the pattern any looser.
  - "stop the mission from being blocked" is a sentence ABOUT stopping, caught
    by the 25-character cap rather than by the pattern.
  - "head off my morning routine" is the real mishearing that started this. It
    must reach the intent router, not be swallowed here.
*/
const MUST_NOT = [
  "stop the mission from being blocked by the other one",
  "i was going to say cancel the meeting tomorrow but actually keep it",
  "waiting on the build to finish before i do anything else",
  "quietly add a note about the gym",
  "tick off my morning routine",
  "head off my morning routine",
  "what time is it",
  "i was reading about how you arm the terminal",
];

if (process.argv.includes("--self-test")) {
  let failed = 0;
  for (const [expected, phrases] of Object.entries(MUST)) {
    for (const phrase of phrases) {
      const got = matchVoiceCommand(phrase);
      if (got !== expected) {
        console.log(`  MISS   ${JSON.stringify(phrase)} → ${got}, wanted ${expected}`);
        failed += 1;
      }
    }
  }
  for (const phrase of MUST_NOT) {
    const got = matchVoiceCommand(phrase);
    if (got !== null) {
      console.log(`  FALSE  ${JSON.stringify(phrase)} → ${got}, wanted no match`);
      failed += 1;
    }
  }
  const total = Object.values(MUST).flat().length + MUST_NOT.length;
  console.log(failed ? `${failed} of ${total} FAILED` : `all ${total} pass`);
  process.exit(failed ? 1 : 0);
}
