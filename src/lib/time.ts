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

/** "1h 20m", "45m", "—" for zero. For durations, not clock times. */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
