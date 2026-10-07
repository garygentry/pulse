// agent-kit/src/slots/severity.ts
// severity-taxonomy lock (REQ-INTEG-05).
//
// Produces the `Slots.severity: readonly SeverityDef[]` block
// and re-exports the `SeverityDef` type that `emit/types.ts` imports from
// `../slots/severity.js`. Because agent-kit takes NO runtime dependency on @pulse/alerting
// (it sits outside the root `workspaces` globs — V-002), this module reads alerting's published
// JSON artifact by path and adapts its nested shape into the flat `SeverityDef`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SlotMismatchError } from "../emit/errors.js";

// ── Severity types (OT-02 resolution: local mirror) ─────────────────────────────────────────
// The authoritative definitions live in `stack/alerting/src/taxonomy.ts:7-30`. agent-kit takes
// NO `workspace:*` dependency on @pulse/alerting (it sits outside the root `workspaces` globs —
// V-002), and alerting's tsconfig is `noEmit`, so neither a tsconfig project reference (TS6310:
// a composite project may not reference a no-emit project) nor a relative type-only import into
// its `.ts` source (TS6059/6307: composite + rootDir rejects an external input file) can supply
// these types. This is the sanctioned non-blocking OT-02 fallback — a LOCAL TYPE MIRROR: the
// types are mirrored from the published JSON's shape rather than imported. This is compile-time only: the
// runtime values are read from the published `severity-taxonomy.json` artifact by path (below),
// and `severity-contract.test.ts` (item 007) locks the shipped content against that real
// artifact — so a taxonomy drift still fails the build; the mirror can introduce no silent
// runtime divergence.

/** The response-oriented severity levels. `deadman` is deliberately NOT a routable severity. */
export type Severity = "critical" | "warning" | "info";

/** Whether a severity mirrors to the automation webhook (REQ-HOOK-01). */
export type WebhookMirror = "always" | "if-selected" | "never";

/** One severity's routing semantics, keyed by required response (mirror of alerting's `SeverityDef`). */
export interface SeverityDef {
  /** The level name. */
  readonly name: Severity;
  /** The required operator response, in prose. */
  readonly response: string;
  /** Human-readable channel target description. */
  readonly channels: string;
  /** Repeat cadence while firing & unsilenced, or `null` when not repeated. */
  readonly repeatInterval: string | null;
  /** Max grouping/batching window before delivery, or `null`. */
  readonly groupWindow: string | null;
  /** Whether this severity bypasses quiet hours. */
  readonly bypassesQuietHours: boolean;
  /** Whether a resolved notification is sent when the alert clears. */
  readonly sendsResolved: boolean;
  /** Webhook-mirror policy. */
  readonly webhookMirror: WebhookMirror;
}

/**
 * Repo-relative path to alerting's published contract artifact. Resolved from this module's
 * source dir; agent-kit runs generation/tests with Bun directly on TS source
 * (package.json "generate": "bun run scripts/generate.ts"), so `import.meta.dir` is
 * `agent-kit/src/slots`.
 */
const CONTRACT_PATH = resolve(
  import.meta.dir,
  "../../../stack/alerting/contract/severity-taxonomy.json",
);

/** The nested shape of the published artifact (see §4.1). Parsed defensively, not trusted. */
interface RawTaxonomy {
  contractVersion: number;
  severities: {
    name: Severity;
    response: string;
    routing: {
      channels: string;
      repeatInterval: string | null;
      groupWindow: string | null;
      bypassesQuietHours: boolean;
      sendsResolved: boolean;
    };
  }[];
  webhookMirror: Record<Severity, WebhookMirror>;
}

/** Read + minimally validate the artifact. Throws (fails the build) on any shape surprise. */
function readRawTaxonomy(): RawTaxonomy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  } catch (e) {
    throw new SlotMismatchError(
      "severity",
      `cannot read/parse ${CONTRACT_PATH}: ${(e as Error).message}`,
    );
  }
  const t = raw as RawTaxonomy;
  if (
    typeof t?.contractVersion !== "number" ||
    !Array.isArray(t.severities) ||
    t.webhookMirror == null
  ) {
    throw new SlotMismatchError("severity", "severity-taxonomy.json is not the expected shape");
  }
  return t;
}

/** The version the JSON artifact declared, exposed so the content-vs-declared check can assert it. */
export function severityContractVersion(): number {
  return readRawTaxonomy().contractVersion;
}

/**
 * The severity slot: the published taxonomy adapted into the flat `SeverityDef` shape the
 * content and the alert-triage subagent (REQ-SKILL-04/05) render from. Order is preserved from
 * the artifact (critical→warning→info), which is significant and stable.
 *
 * @throws {SlotMismatchError} If the artifact is missing/malformed, or a severity has no
 *   webhook-mirror entry (a genuine taxonomy drift — must fail the build, REQ-INTEG-05).
 */
export function severityTaxonomy(): readonly SeverityDef[] {
  const t = readRawTaxonomy();
  return t.severities.map((s) => {
    const mirror = t.webhookMirror[s.name];
    if (mirror === undefined) {
      throw new SlotMismatchError("severity", `no webhookMirror entry for severity '${s.name}'`);
    }
    return {
      name: s.name,
      response: s.response,
      channels: s.routing.channels,
      repeatInterval: s.routing.repeatInterval,
      groupWindow: s.routing.groupWindow,
      bypassesQuietHours: s.routing.bypassesQuietHours,
      sendsResolved: s.routing.sendsResolved,
      webhookMirror: mirror,
    } satisfies SeverityDef;
  });
}
