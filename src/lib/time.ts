// Clock helpers for anything that reasons about time-of-day.
//
// Everything here is **local time**, deliberately. Operator's one time-related
// defect (OPS-009) is a UTC comparison used where the owner meant "today", so
// the rule for this file is: never touch toISOString() for a wall-clock value.
// ISO strings are for timestamps; these are for "what time is it here".

/** Minutes since local midnight, from "HH:MM". Returns null if unparseable. */
export function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight → "HH:MM". Wraps past 24h, so 25:30 reads as 01:30. */
export function formatHHMM(minutesSinceMidnight: number): string {
  const wrapped = ((minutesSinceMidnight % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Minutes since local midnight for a given moment. */
export function minutesIntoDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// --- Calendar dates -------------------------------------------------------
// A "date key" is a local calendar day as "YYYY-MM-DD".
//
// Never build one with toISOString().slice(0, 10). That converts to UTC first,
// so any evening in BST lands on the wrong day — which is exactly half of
// OPS-009. These read the local parts directly.

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight for a date key. Invalid input returns null. */
export function fromDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days from today to `key`. Negative is past, 0 is today. */
export function daysFromToday(key: string): number | null {
  const target = fromDateKey(key);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "In 4 days", "3 days ago", else a short date. */
export function relativeDay(key: string): string {
  const diff = daysFromToday(key);
  if (diff === null) return key;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff <= 14) return `In ${diff} days`;
  if (diff < -1 && diff >= -14) return `${Math.abs(diff)} days ago`;
  const date = fromDateKey(key);
  return date
    ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : key;
}

/**
 * The weeks of a month as a 6×7 grid of date keys, Monday-first, padded with
 * the neighbouring months so every row is full. `null` marks a padding cell.
 */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1);
  // getDay() is Sunday-first; shift so Monday is 0.
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (string | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => toDateKey(new Date(year, month, i + 1))),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday-first, to match how the owner's week actually starts. */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** "1h 20m", "45m", "—" for zero. For durations, not clock times. */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
