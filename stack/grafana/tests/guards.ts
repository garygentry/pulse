// stack/grafana/tests/guards.ts
//
// The single, verification-only support module for the `dashboards` guard suite. It realizes
// 00-core-definitions.md's exported surface (constants + types, copied verbatim) and adds the
// path constants + loaders both Tier A (static-guards.test.ts) and Tier B (provisioning.smoke.test.ts)
// import from "./guards.js". It imports NO @pulse/* package (tech-spec §6) — only Node built-ins.
//
// The type bodies below are byte-for-byte the shapes in 00-core-definitions.md §1–§4 and §6–§7. Do
// NOT diverge them: if 00 changes, this file changes with it (enforced by `bun run typecheck`).
// 00 §5 (DashboardProviderConfig / AlertmanagerDatasourceConfig) is intentionally NOT realized here:
// the provider YAML and Alertmanager datasource are validated behaviorally by the Tier B smoke
// (provisioned by uid + reached through the datasource proxy), not by a compile-time shape.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// §1 Constants and Enumerations (00-core-definitions.md §1)
// ─────────────────────────────────────────────────────────────────────────────

/** The stable board UIDs (REQ-LINK-01). Frozen for v1; every board's `uid` ∈ this set. `pulse-gpu`
 *  is the additive GPU-contention correlation board (issue #1). */
export const BOARD_UIDS = [
  "pulse-host",
  "pulse-deephealth",
  "pulse-hypervisor",
  "pulse-nas",
  "pulse-engine",
  "pulse-gpu",
  "pulse-dns",
  "pulse-ingress",
] as const;

/** A board UID drawn from the frozen set. */
export type BoardUid = (typeof BOARD_UIDS)[number];

/** Grafana folder names, one per immediate subdirectory of the provider's scanned `json/` path. */
export const FOLDERS = [
  "Hosts",
  "Deep-Health",
  "Infrastructure",
  "Engine",
  "GPU",
  "DNS",
  "Ingress",
] as const;
export type FolderName = (typeof FOLDERS)[number];

/** On-disk subdirectory name under `dashboards/json/` for each folder. */
export const FOLDER_DIRS = {
  Hosts: "hosts",
  "Deep-Health": "deep-health",
  Infrastructure: "infrastructure",
  Engine: "engine",
  GPU: "gpu",
  DNS: "dns",
  Ingress: "ingress",
} as const satisfies Record<FolderName, string>;

/**
 * The URL-bound target template variable each board declares (REQ-LINK-02). `pulse-engine` binds NO
 * target variable (whole-engine board → fixed `/d/pulse-engine`). Names here MUST equal the variable
 * `name` fields the boards declare, and the `boundVar` in each drilldown-links.md row.
 */
export const TARGET_VARS = {
  "pulse-host": "instance",
  "pulse-hypervisor": "instance",
  "pulse-nas": "instance",
  "pulse-deephealth": "service",
  "pulse-engine": null,
  "pulse-gpu": "instance",
  "pulse-dns": "instance",
  "pulse-ingress": "instance",
} as const satisfies Record<BoardUid, string | null>;

/** Datasource template-variable names (REQ-TMPL-02). */
export const DATASOURCE_VARS = {
  metrics: "DS",
  alerts: "DS_ALERTS",
} as const;

/** Stable UID of the additive Alertmanager datasource (§5). Referenced only via `${DS_ALERTS}`. */
export const ALERTMANAGER_DS_UID = "pulse-alertmanager";

/** Tag every board carries so a taxonomy/ownership scan can find Pulse boards. */
export const PULSE_BOARD_TAG = "pulse";

// ─────────────────────────────────────────────────────────────────────────────
// §2 Grafana Dashboard Model (00-core-definitions.md §2)
// ─────────────────────────────────────────────────────────────────────────────

/** The validated subset of a committed Grafana dashboard model. */
export interface DashboardModel {
  /** Stable board handle, ∈ BOARD_UIDS. The only durable URL identity. */
  uid: BoardUid;
  /** Human-readable board title. MUST NOT contain an estate literal. */
  title: string;
  /** Pinned Grafana dashboard schema version. Presence + integer type is asserted (REQ-REPRO-01). */
  schemaVersion: number;
  /** Board tags; MUST include PULSE_BOARD_TAG. */
  tags: string[];
  /** Template-variable declarations (datasource vars + optional target var). */
  templating: { list: TemplateVariable[] };
  /** Panels; each metric/alert panel references a datasource via `${DS}` / `${DS_ALERTS}`. */
  panels: Panel[];
}

/** A Grafana templating variable (`datasource` for DS/DS_ALERTS; `query` for target selectors). */
export interface TemplateVariable {
  /** Variable name (unqualified; the deep-link binds it as `var-<name>`). */
  name: string;
  /** `datasource` for DS/DS_ALERTS; `query` for target selectors. */
  type: "datasource" | "query";
  /** DS plugin id (`prometheus`/`alertmanager`) or the `label_values(...)` expression. */
  query: string;
  /** REQ-TMPL-03: target selectors MUST NOT be `required`. `undefined`/`false` ⇒ not required. */
  required?: boolean;
  /** Whether an "All" option is offered (target selectors may enable it). */
  includeAll?: boolean;
}

/** A panel. The guard suite reads `datasource` and each target's `expr`. */
export interface Panel {
  /** Grafana panel type, e.g. `timeseries`, `stat`, `table`, `alertlist`. */
  type: string;
  /** Panel title. MUST NOT contain an estate literal. */
  title: string;
  /** Datasource reference — MUST be a `${DS}` / `${DS_ALERTS}` template ref, never a literal UID. */
  datasource: PanelDatasourceRef;
  /** Query targets (metric panels). Each `expr` MUST be target-scoped when applicable. */
  targets?: PanelTarget[];
}

/** A panel/variable datasource reference — the `${DS}`/`${DS_ALERTS}` template form. */
export type PanelDatasourceRef =
  | `\${${string}}` // "${DS}" | "${DS_ALERTS}"
  | { type: string; uid: `\${${string}}` };

/** A single metric query target within a panel. */
export interface PanelTarget {
  /** PromQL expression. MUST reference the board's target variable when the board declares one. */
  expr: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 Guard-Suite Domain Types (00-core-definitions.md §3)
// ─────────────────────────────────────────────────────────────────────────────

/** The four hermetic guard checks (check 5, provisioning smoke, is Docker-tier). */
export type GuardCheck =
  | "json-validity"
  | "uid-convention"
  | "no-estate-literals"
  | "no-external-datasource";

/** A parsed committed artifact under verification, tagged by role. */
export type ArtifactKind = "board" | "provider" | "datasource" | "provenance" | "drilldown-doc";

export interface LoadedArtifact {
  /** Repo-relative path. */
  path: string;
  /** Role in the verification. */
  kind: ArtifactKind;
  /** Raw file text (deny-list scans operate on this). */
  raw: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 Provenance Manifest (00-core-definitions.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/** One provenance record. */
export type ProvenanceEntry =
  | {
      source: "grafana.com";
      sourceId: string;
      revision: string;
      notes: string;
    }
  | {
      source: "hand-authored";
    };

/** The whole manifest: exactly one entry per board UID (key set === BOARD_UIDS). */
export type ProvenanceManifest = Record<BoardUid, ProvenanceEntry>;

// ─────────────────────────────────────────────────────────────────────────────
// §6 Drilldown-Links Contract Row (00-core-definitions.md §6)
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the (category, target) → deep-link convention `web-app` consumes. */
export interface DrilldownEntry {
  /** Display category, e.g. "per-host", "deep-health", "hypervisor", "NAS", "engine self-health". */
  category: string;
  /** The board UID. */
  uid: BoardUid;
  /** URL-bound target variable, or null for the engine board. Equals TARGET_VARS[uid]. */
  boundVar: string | null;
  /** Deep-link template, e.g. "/d/pulse-host?var-instance=<host>" or "/d/pulse-engine". */
  deepLink: string;
  /** The view-time `label_values(...)` query populating the target var, or null for engine. */
  variableQuery: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 Failure Conditions (00-core-definitions.md §7)
// ─────────────────────────────────────────────────────────────────────────────

/** The enumerated ways a committed artifact violates REQ-VERIF-01 (the declared protection set). */
export type GuardFailureKind =
  | "invalid-json"
  | "non-board-json"
  | "duplicate-uid"
  | "unknown-uid"
  | "provenance-mismatch"
  | "estate-literal"
  | "credential-literal"
  | "external-reference"
  | "hardcoded-datasource"
  | "unscoped-query";

/** A single guard finding: which check, which failure, where, and why. */
export interface GuardFinding {
  /** The check that produced the finding. */
  check: GuardCheck;
  /** The specific violation. */
  kind: GuardFailureKind;
  /** Repo-relative path of the offending file. */
  path: string;
  /** Human-readable reason, surfaced in the failing assertion message. */
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path constants (05-testing-strategy.md §0)
// ─────────────────────────────────────────────────────────────────────────────

/** Repo root, derived from this file's location: stack/grafana/tests → up 3. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Provisioning root under stack-core's mount. */
export const PROVISIONING_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "compose",
  "config",
  "grafana",
  "provisioning",
);

/** The provider's scanned path — ONLY board JSON lives here (file-provider gotcha). */
export const BOARDS_JSON_DIR = join(PROVISIONING_DIR, "dashboards", "json");
export const PROVIDER_YAML = join(PROVISIONING_DIR, "dashboards", "pulse.yaml");
export const ALERTMANAGER_YAML = join(PROVISIONING_DIR, "datasources", "alertmanager.yml");

/** Feature-package non-board artifacts (00 §4, 04) — live OUTSIDE the scanned json/ path. */
export const PROVENANCE_JSON = join(import.meta.dir, "..", "provenance.json");
export const DRILLDOWN_DOC = join(import.meta.dir, "..", "drilldown-links.md");

// ─────────────────────────────────────────────────────────────────────────────
// Loaders (05-testing-strategy.md §0)
// ─────────────────────────────────────────────────────────────────────────────

/** Every `.json` under BOARDS_JSON_DIR, recursively (matches Grafana's recursive scan). Sorted. */
export function listBoardJsonFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (abs.endsWith(".json")) {
        out.push(abs);
      }
    }
  };
  walk(BOARDS_JSON_DIR);
  return out.sort();
}

/**
 * Load every committed artifact under verification, tagged by ArtifactKind (00 §3). Fixtures are NOT
 * included — they are seed data, not shipped artifacts, and are out of the literal-scan set (05 §4).
 */
export function loadArtifacts(): LoadedArtifact[] {
  const artifacts: LoadedArtifact[] = [];
  const push = (abs: string, kind: ArtifactKind): void => {
    artifacts.push({ path: relative(REPO_ROOT, abs), kind, raw: readFileSync(abs, "utf8") });
  };
  for (const board of listBoardJsonFiles()) push(board, "board");
  push(PROVIDER_YAML, "provider");
  push(ALERTMANAGER_YAML, "datasource");
  push(PROVENANCE_JSON, "provenance");
  push(DRILLDOWN_DOC, "drilldown-doc");
  return artifacts;
}
