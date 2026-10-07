// src/client/views/alerts/table/columns-model.ts — pure text helpers for the firing triage table cells.
import type { ActiveAlert, TargetIdentity } from "@pulse/web-data/wire";

/** Human age from an ISO-8601 `startsAt`. Coarse buckets (s/m/h/d) — no live ticking (re-derived on
 *  render). Unparseable → "—". `now` is injectable for deterministic tests. */
export function formatAge(startsAt: string, now: number = Date.now()): string {
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return "—";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** "host:web01" / "service:api" / …; null (unattributed) → "—" (never a fuzzy guess). */
export function formatTarget(target: TargetIdentity | null): string {
  return target === null ? "—" : `${target.kind}:${target.id}`;
}

/** Summary text: the `summary` annotation, falling back to `description`; else "—".
 *  Plain text only — no HTML is rendered from annotations here. */
export function summaryText(a: ActiveAlert): string {
  return a.annotations.summary ?? a.annotations.description ?? "—";
}
