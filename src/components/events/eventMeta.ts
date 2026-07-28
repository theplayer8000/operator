import type { EventKind } from "@/lib/types";

/**
 * Five kinds, colour-coded from the existing tokens rather than new hues —
 * a calendar that invents its own palette stops looking like the same app.
 */
export const EVENT_KIND_META: Record<EventKind, { label: string; dot: string; text: string }> = {
  work: { label: "Work", dot: "bg-xp", text: "text-xp" },
  personal: { label: "Personal", dot: "bg-rank", text: "text-rank" },
  admin: { label: "Admin", dot: "bg-ink-500", text: "text-ink-500" },
  health: { label: "Health", dot: "bg-vital-up", text: "text-vital-up" },
  other: { label: "Other", dot: "bg-ink-700", text: "text-ink-700" },
};

export const EVENT_KINDS: EventKind[] = ["work", "personal", "admin", "health", "other"];
