/**
 * One wording for times across deck: "just now", "42s ago", "6m ago", "3h ago",
 * "8d ago". Pure functions; callers pass `now` so rendering stays deterministic.
 */

/** Age in milliseconds → "6m ago". Negative ages (clock skew) read as "just now". */
export function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** An ISO timestamp relative to `now` (epoch ms or Date). Unparseable input is returned as-is. */
export function formatRelative(iso: string, now: number | Date = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return formatAge(Number(now) - at);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** An ISO timestamp as local "2026-01-15 12:00". Unparseable input is returned as-is. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
