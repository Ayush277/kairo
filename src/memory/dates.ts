/** Local-calendar date helpers. Dates are `YYYY-MM-DD` strings in the server's local timezone. */

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Noon local time avoids DST edge cases when doing day arithmetic. */
export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function addDays(s: string, n: number): string {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

export function weekdayOf(s: string): number {
  return parseDateStr(s).getDay();
}

export function describeDate(s: string): string {
  const d = parseDateStr(s);
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

export function atLocalTime(s: string, hour: number, minute = 0): Date {
  const d = parseDateStr(s);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Most recent occurrence of `dow` (0=Sun) strictly before `today`. */
export function lastWeekday(today: string, dow: number): string {
  const back = (weekdayOf(today) - dow + 7) % 7 || 7;
  return addDays(today, -back);
}

/** Most recent occurrence of month/day on or before `today` (month is 1-12). */
export function mostRecentMonthDay(today: string, month: number, day: number): string {
  const year = parseDateStr(today).getFullYear();
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  return candidate <= today ? candidate : `${year - 1}-${pad(month)}-${pad(day)}`;
}

/** Parse a client-supplied "as of" value (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`) as local time. */
export function parseAsOf(value: string | undefined | null): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return atLocalTime(value, 12, 0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatClock(d: Date): string {
  return `${describeDate(localDateStr(d))}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
