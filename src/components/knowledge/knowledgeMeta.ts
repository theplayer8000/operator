import type { KnowledgeConfidence, KnowledgeKind } from "@/lib/types";

/**
 * How a note's two enums are shown.
 *
 * One place, like `routineMeta` and `eventMeta`, so the list row and the open
 * note cannot describe the same value differently — which they did within an
 * hour of having two copies, on every feature that has tried it.
 *
 * ## The colours are doing work, not decoration
 *
 * Confidence is the field this vault lives or dies on: its failure mode is a
 * note written once while learning something, never revisited, and trusted a
 * year later as though it were checked. So `unverified` is warm and slightly
 * uncomfortable and `verified` is green — the register is Mission Board's calm
 * one, but a state you should hesitate over has to look like one.
 *
 * `vital-up` and `vital-down` are reserved for genuinely binary positive and
 * negative states, which this is: it either held up when you last checked or
 * it did not.
 */
export const CONFIDENCE_META: Record<
  KnowledgeConfidence,
  { label: string; help: string; className: string; dot: string }
> = {
  unverified: {
    label: "unverified",
    help: "Written down, never checked since. Read it, do not trust it.",
    className: "border-vital-down/35 bg-vital-down/10 text-vital-down",
    dot: "bg-vital-down",
  },
  works: {
    label: "worked",
    help: "This worked when it was written. Not re-checked since.",
    className: "border-xp/35 bg-xp/10 text-xp",
    dot: "bg-xp",
  },
  verified: {
    label: "verified",
    help: "Checked, and held up. Safe to act on.",
    className: "border-vital-up/35 bg-vital-up/10 text-vital-up",
    dot: "bg-vital-up",
  },
};

/**
 * The three kinds, which change how a note is READ rather than how it is
 * stored — so the difference is a label and a colour, not a schema.
 */
export const KIND_META: Record<KnowledgeKind, { label: string; className: string }> = {
  note: {
    label: "note",
    className: "border-base-600 bg-base-700/50 text-ink-500",
  },
  command: {
    label: "command",
    className: "border-rank/35 bg-rank/10 text-rank",
  },
  resource: {
    label: "resource",
    className: "border-base-500 bg-base-700/50 text-ink-300",
  },
};

/** In order, so a control can step through them. */
export const CONFIDENCE_ORDER: KnowledgeConfidence[] = ["unverified", "works", "verified"];
export const KIND_ORDER: KnowledgeKind[] = ["note", "command", "resource"];
