import type { DecisionVerdict } from "@/lib/types";

/**
 * How a decision's verdict is shown — one place, like `knowledgeMeta` and
 * `routineMeta`, so a list row and the open record cannot describe the same
 * value two different ways.
 *
 * ## The colours are doing work
 *
 * The verdict is the field the log lives on: it is how you scan a page of
 * decisions and see which of your calls held up. So `bad` is `vital-down` and
 * `good` is `vital-up` — the Mission Board's calm register, but a
 * genuinely-binary "it worked / it didn't" state, which is exactly what
 * `vital-up` / `vital-down` are reserved for. `pending` is deliberately quiet:
 * a decision without an outcome yet is not a problem, it is just unfinished.
 */
export const VERDICT_META: Record<
  DecisionVerdict,
  { label: string; help: string; className: string; dot: string }
> = {
  pending: {
    label: "pending",
    help: "No outcome recorded yet. Too soon to say, or not looked at since.",
    className: "border-base-600 bg-base-700/50 text-ink-500",
    dot: "bg-ink-600",
  },
  good: {
    label: "worked out",
    help: "Looking back: this was the right call.",
    className: "border-vital-up/35 bg-vital-up/10 text-vital-up",
    dot: "bg-vital-up",
  },
  mixed: {
    label: "mixed",
    help: "Some of it landed, some of it didn't.",
    className: "border-xp/35 bg-xp/10 text-xp",
    dot: "bg-xp",
  },
  bad: {
    label: "backfired",
    help: "Looking back: this was the wrong call.",
    className: "border-vital-down/35 bg-vital-down/10 text-vital-down",
    dot: "bg-vital-down",
  },
};

/** In order, so a control can step through them. */
export const VERDICT_ORDER: DecisionVerdict[] = ["pending", "good", "mixed", "bad"];
