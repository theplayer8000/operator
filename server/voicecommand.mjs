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
 * @returns `"arm"`, `"disarm"`, or null — and null is overwhelmingly the
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
  if (!text || text.length > 60) return null;

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
