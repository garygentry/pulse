// views/engine/verdict.ts — the never-falsely-green engine roll-up and its banner text
// (03 §3, 00 §4.2; D5). Pure and total: no clock, no store, never throws.

import type {
  CycleObservation, EnginePayload, OverviewSnapshotV2, SourceId, TargetStatus, ViewDeliveryState,
} from "@pulse/web-data/wire";
import { scrapeDiscovery } from "./model.js";
import { COMPONENT_LABEL, VERDICT_INLINE_CONTRIBUTORS } from "./labels.js";

/** The seven sources whose success the overview engine-OK summary requires (fold-overview buildEngineSummary). */
export const GOVERNING_SOURCES: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-status", "vmalert-rules", "gatus-statuses",
];

/** Inputs to the pure roll-up (REQ-VERDICT-02). */
export interface VerdictInput {
  /** Current engine payload or null. */ readonly engine: EnginePayload | null;
  /** Engine view delivery state (distinguishes Loading from Unknown). */ readonly delivery: ViewDeliveryState;
  /** Persistent "not current" per §4.1. */ readonly notCurrent: boolean;
  /** Latest accepted cycle observation, or null before the first. */ readonly observation: CycleObservation | null;
  /** Overview engine summary with the snapshot's generatedAt, or null; used only when generatedAt equals engine.generatedAt. */
  readonly overviewEngine: { readonly section: OverviewSnapshotV2["engine"]; readonly generatedAt: string } | null;
  /** Epoch ms of the transport's last valid contact (`connection.lastGoodAt`), for the Unknown banner. */ readonly lastGoodAt: number | null;
}

/** Roll-up result (REQ-VERDICT-01). */
export type Verdict =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown"; readonly since: number | null }
  | { readonly kind: "ok" }
  | { readonly kind: "degraded"; readonly contributors: readonly string[] };

const codePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Roll up the engine payload and cycle evidence into one verdict (REQ-VERDICT-01..04).
 * Pure and total: never throws, and does not read the clock or the store.
 *
 * @param input - Engine payload, delivery phase, persistent not-current flag, cycle observation,
 *   the overview engine summary with its generatedAt, and the transport lastGoodAt.
 * @returns loading | unknown(since) | ok | degraded(contributors in the fixed order of 03 §3.2).
 */
export function rollUpVerdict(input: VerdictInput): Verdict {
  const { engine, delivery, notCurrent, observation, overviewEngine, lastGoodAt } = input;

  if (engine === null && delivery.phase === "initial" && !notCurrent) return { kind: "loading" };
  if (engine === null || notCurrent) return { kind: "unknown", since: lastGoodAt };

  const out: string[] = [];

  if (engine.cycle.buildFailure !== null) out.push("cycle build failed");
  if (engine.cycle.degraded) out.push("publication cycle degraded");

  for (const c of engine.components) {
    if (c.state === "not-configured") continue;
    const name = COMPONENT_LABEL[c.id] ?? String(c.id);
    if (c.state === "unhealthy") out.push(`${name} unreachable`);
    else if (c.state !== "healthy" || c.availability.state !== "current") out.push(`${name} stale`);
  }

  if (!engine.deadman.configured) out.push("deadman not configured");
  else if (engine.deadman.state !== "healthy") out.push(`deadman ${engine.deadman.state}`);

  let down = 0;
  for (const job of engine.scrapeJobs) for (const t of job.targets) if (t.health !== "up") down += 1;
  if (down > 0) out.push(`${down} scrape targets down`);
  if (!scrapeDiscovery(engine, observation).current) out.push("target discovery not current");

  const failing = engine.ruleGroups.filter((g) => g.health !== "healthy").length;
  if (failing > 0) out.push(`${failing} rule groups failing`);

  const f = engine.notifications.failuresPerSecond;
  if (f !== null) {
    const keys = Object.keys(f)
      .filter((k) => { const v = f[k]; return typeof v === "number" && Number.isFinite(v) && v > 0; })
      .sort(codePoint);
    if (keys.length > 0) out.push(`notifications failing (${keys.join(", ")})`);
  }
  if (engine.notifications.availability.state !== "current") out.push("notification metrics unavailable");

  if (out.length === 0) {
    if (observation !== null) {
      for (const id of GOVERNING_SOURCES) {
        if (observation.sources[id]?.state !== "current") out.push(`engine source ${id} not current`);
      }
    }
    if (overviewEngine !== null && overviewEngine.generatedAt === engine.generatedAt) {
      const s = overviewEngine.section;
      const ok = s.availability.state === "current" && s.value !== null && s.value.ok === true;
      if (!ok) {
        const c = `engine source ${s.availability.source} not current`;
        if (!out.includes(c)) out.push(c);
      }
    }
  }

  return out.length === 0 ? { kind: "ok" } : { kind: "degraded", contributors: out };
}

/** [local] Render-ready verdict text (REQ-VERDICT-05, REQ-A11Y-01: text carries the state). */
export interface VerdictPresentation {
  /** Status word shown next to the glyph. */
  readonly word: "Loading" | "OK" | "Degraded" | "Unknown";
  /** Token/glyph status: ok → "ok", degraded → "warning", unknown → "unknown"; null for loading. */
  readonly status: TargetStatus | null;
  /** Full one-line headline, e.g. "Degraded — vmalert unreachable; 3 scrape targets down". */
  readonly headline: string;
  /** Contributors shown inline (first VERDICT_INLINE_CONTRIBUTORS). */
  readonly inline: readonly string[];
  /** Count of contributors beyond the inline ones (the "and N more" figure). */
  readonly more: number;
  /** Every contributor, for the expandable full list. */
  readonly all: readonly string[];
}

const NONE: readonly string[] = Object.freeze([]);

/** UTC ISO string for an epoch-ms value, or null when it is null, non-finite or out of Date range. */
function sinceIso(since: number | null): string | null {
  if (since === null || !Number.isFinite(since)) return null;
  const d = new Date(since);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * [local] Build the banner text for a verdict (03 §3.5).
 * - loading  → word "Loading", headline "Loading engine state…".
 * - ok       → word "OK", headline "OK".
 * - degraded → word "Degraded", headline "Degraded — " + inline.join("; ") + (more > 0 ? `; and ${more} more` : "").
 * - unknown  → word "Unknown", headline "Unknown — engine data not current since {formatIso(ISO)}",
 *              or "Unknown — engine data not current" when `since` is null or not finite.
 * @param verdict - From rollUpVerdict.
 * @param formatIso - Estate-clock formatter (`EstateClock.format`) supplied by 04; keeps this pure.
 */
export function presentVerdict(verdict: Verdict, formatIso: (isoUtc: string) => string): VerdictPresentation {
  if (verdict.kind === "loading") {
    return { word: "Loading", status: null, headline: "Loading engine state…", inline: NONE, more: 0, all: NONE };
  }
  if (verdict.kind === "ok") return { word: "OK", status: "ok", headline: "OK", inline: NONE, more: 0, all: NONE };
  if (verdict.kind === "unknown") {
    const iso = sinceIso(verdict.since);
    const headline = iso === null
      ? "Unknown — engine data not current"
      : `Unknown — engine data not current since ${formatIso(iso)}`;
    return { word: "Unknown", status: "unknown", headline, inline: NONE, more: 0, all: NONE };
  }
  const all = verdict.contributors;
  const inline = all.slice(0, VERDICT_INLINE_CONTRIBUTORS);
  const more = all.length - inline.length;
  const headline = `Degraded — ${inline.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  return { word: "Degraded", status: "warning", headline, inline, more, all };
}

/** A verdict the banner can show. The loading verdict is rendered by the view's loading layout. */
export type BannerVerdict = Exclude<Verdict, { readonly kind: "loading" }>;

/**
 * The text after the chip. Pure; never throws.
 * - degraded → contributors joined with "; ": `presentation.inline` on desk, `presentation.all` in
 *   kiosk. The "and N more" text is a button on desk, so it is not part of the text.
 * - unknown  → `presentation.headline` without its leading "{word} — ".
 * - ok       → "" (the chip word "OK" is the whole statement).
 *
 * @param verdict - Banner verdict.
 * @param presentation - presentVerdict output.
 * @param kiosk - Kiosk flag.
 * @returns The summary text, or "".
 */
export function bannerSummary(verdict: BannerVerdict, presentation: VerdictPresentation, kiosk: boolean): string {
  if (verdict.kind === "degraded") return (kiosk ? presentation.all : presentation.inline).join("; ");
  if (verdict.kind === "unknown") {
    const prefix = `${presentation.word} — `;
    return presentation.headline.startsWith(prefix) ? presentation.headline.slice(prefix.length) : "";
  }
  return "";
}
