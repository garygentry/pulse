/**
 * stack-core verification harness — the single non-test support module that realizes
 * `00-core-definitions.md`'s exported constants and types once, imported by both test
 * suites (`config.test.ts`, `bringup.smoke.test.ts`; `06-testing-strategy.md §1`).
 *
 * It imports NO `@pulse/*` package: stack-core asserts against on-disk YAML + Docker, not
 * TypeScript APIs. Only Node/Bun built-ins are used. The rendered-tree types below are
 * *mirror* definitions of pulse-cli's emitted on-disk shapes (source of truth:
 * the committed golden tree) — never a
 * `@pulse/renderer` import.
 *
 * Scope note: this harness mirrors the mounted-rendered-data and compose-config contracts it
 * asserts against — not every type in 00. `BringupCondition`, `ProberProbe`, and
 * `ProberConfigRendered` are omitted because they belong to the deferred prober slot / failure
 * taxonomy (00 §4.4, §8), which this harness does not realize.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

/* ===========================================================================================
 * 1. Service registry constants (00 §1)
 * ========================================================================================= */

/** Compose project name (REQ-COMPOSE-02). Fixed. */
export const COMPOSE_PROJECT = "pulse" as const;

/** The user-defined bridge network every service attaches to (tech-spec §3.1). */
export const COMPOSE_NETWORK = "pulse" as const;

declare const smokeProjectBrand: unique symbol;
/** A project identity that can only be constructed by the test-only factory below. */
export type SmokeProjectName = string & { readonly [smokeProjectBrand]: true };

/**
 * Return a unique, Compose-safe project name for one Docker smoke lifecycle.
 *
 * The committed compose tree intentionally defaults to the production project `pulse`. Docker
 * tests MUST override that identity with one name created once per lifecycle, then reuse it for
 * every up/ps/logs/down command. A UUID makes concurrent test processes safe; the PID keeps leaked
 * test resources attributable when a process is killed before its teardown hook runs.
 */
export function createSmokeProjectName(scope: string): SmokeProjectName {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(scope)) {
    throw new Error(`invalid compose smoke scope: ${scope}`);
  }
  return `pulse-test-${scope}-${process.pid}-${randomUUID()}` as SmokeProjectName;
}

/** Build a mutating smoke command only from a factory-created test project identity. */
export function smokeComposeArgs(
  project: SmokeProjectName,
  composeFile: string,
  ...args: string[]
): string[] {
  if (!project.startsWith("pulse-test-")) {
    throw new Error(`refusing unsafe Docker smoke project: ${project}`);
  }
  return ["docker", "compose", "-p", project, "-f", composeFile, ...args];
}

/** Compose's default resource name for the engine's user-defined `pulse` network. */
export function composeNetworkName(project: SmokeProjectName): string {
  return `${project}_${COMPOSE_NETWORK}`;
}

/** Services that MUST be healthy under a default-profile `compose up` (REQ-PERF-01). */
export const DEFAULT_PROFILE_SERVICES = [
  "victoriametrics",
  "vmalert",
  "alertmanager",
  "gatus",
  "grafana",
  "cadvisor",
  "pve-exporter",
] as const;
export type DefaultProfileService = (typeof DEFAULT_PROFILE_SERVICES)[number];

/* ===========================================================================================
 * 2. `engine-apis` — exposed address set (00 §2)
 * ========================================================================================= */

/**
 * The `engine-apis` contract: stable in-stack `service:port` addresses on the `pulse`
 * network. `deploy-toolkit`'s host-published mappings are NOT part of this set (REQ-API-02).
 */
export const ENGINE_APIS = {
  /** Metrics TSDB + query API + built-in scraper. Grafana datasource + dashboards query here. */
  victoriametrics: "victoriametrics:8428",
  /** Rule evaluator. */
  vmalert: "vmalert:8880",
  /** Routing/silence/deadman brain. Gatus + vmalert post alerts here. */
  alertmanager: "alertmanager:9093",
  /** Synthetic-check engine. */
  gatus: "gatus:8080",
  /** Dashboards UI. */
  grafana: "grafana:3000",
} as const;

/** URL form injected into the web slot's env (00 §3, 05-mounts-contracts-failure.md §6.4). */
export const ENGINE_API_URLS = {
  PULSE_VM_URL: "http://victoriametrics:8428",
  PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
  PULSE_GATUS_URL: "http://gatus:8080",
} as const;

/* ===========================================================================================
 * 3. Profiles (00 §3)
 * ========================================================================================= */

/** Compose profiles that gate optional services out of the default `compose up`.
 *  (There is no `nas` profile: a nas-api host is a direct node_exporter scrape now — issue #4.) */
export type StackProfile = "web" | "deep-health";

export const PROFILE = {
  /** Gates the `web` service (web-app slot). Green without a web image (REQ-WEB-02). */
  web: "web",
  /** Gates the deferred `prober` deep-health slot (OQ-A6). */
  deepHealth: "deep-health",
} as const;

/* ===========================================================================================
 * 4. Rendered-tree input contracts (00 §4) — mirror types of pulse-cli's on-disk shapes
 * ========================================================================================= */

/** One Prometheus file_sd entry (Prometheus `file_sd` schema). */
export interface FileSdEntry {
  /** Scrape targets: `host:port` (managed-linux) or `scheme://host:port` (api classes). */
  targets: string[];
  /** Labels attached to every target. `__`-prefixed labels are meta and dropped post-relabel. */
  labels: Record<string, string>;
}

/** The four v1 collection classes; each renders to `scrape/file_sd/<class>.json`. */
export type CollectionClass =
  | "managed-linux" // direct node_exporter scrape; auxiliary exporters use split jobs
  | "hypervisor-api" // relabel-through pve-exporter
  | "nas-api" // direct node_exporter scrape (issue #4; opt-in API-exporter override recipe)
  | "probe-only"; // NOT wired to a VM job in v1 — Gatus/prober cover it

/** Abstract receiver shape emitted by pulse-cli (source: 02-rendering-engine.md §4.3). */
export interface AmReceiver {
  name: string;
  /** Opaque provider config (e.g. `{ webhook_configs: [...] }`) — NOT native AM top-level. */
  config: Record<string, unknown>;
}
export interface AmRoutingRendered {
  receivers: AmReceiver[];
  route: Record<string, unknown>;
}

/** Ledger at the rendered root. `RENDER_FORMAT_VERSION` = 2 in packages/renderer/src/manifest.ts. */
export interface RenderedManifest {
  /** MUST equal the version stack-core builds against. Asserted by the smoke harness. */
  formatVersion: number;
  /** Code-point-sorted relative paths of every rendered file. */
  files: string[];
}

/** The rendered format version stack-core is built against (CON-03). Mismatch = loud failure. */
export const EXPECTED_RENDER_FORMAT_VERSION = 2 as const;

/* ===========================================================================================
 * 5. Secret-reference conventions (00 §5)
 * ========================================================================================= */

/** A secret reference token: `${VARNAME}`. The tree/config carry these, never literals. */
export type SecretRef = `\${${string}}`;

/** Meta-label on a rendered file_sd entry carrying the credential *reference* for its exporter. */
export const CREDENTIAL_LABEL = "__pulse_credential__" as const;

/** Exporter env vars that hold the resolved read-only tokens (documented in `.env.example`).
 *  (nas-api has no shipped exporter — issue #4 — so no NAS token env here.) */
export const EXPORTER_TOKEN_ENV = {
  "pve-exporter": "PVE_TOKEN",
} as const;

/* ===========================================================================================
 * 6. Mount map (00 §6)
 * ========================================================================================= */

/** One read-only bind of a rendered subtree into a service. `source` is relative to the rendered root. */
export interface RenderedMount {
  source: string; // e.g. "scrape/file_sd"
  containerPath: string; // e.g. "/rendered/scrape/file_sd"
  consumer: DefaultProfileService | "prober";
  readOnly: true;
}

export const RENDERED_MOUNTS: RenderedMount[] = [
  { source: "scrape/file_sd", containerPath: "/rendered/scrape/file_sd", consumer: "victoriametrics", readOnly: true },
  // Gatus merges a config *directory*: rendered endpoints land as one file among stack-core's own.
  { source: "gatus/config.yaml", containerPath: "/config/10-endpoints.yaml", consumer: "gatus", readOnly: true },
  // Slot only — mounted for `alerting` to transform; AM does NOT read this (00 §4.3).
  { source: "alertmanager/routing.yaml", containerPath: "/rendered/alertmanager/routing.yaml", consumer: "alertmanager", readOnly: true },
  { source: "prober/config.yaml", containerPath: "/rendered/prober/config.yaml", consumer: "prober", readOnly: true },
  // NOTE (web-app 07-slot-reconciliation.md §3.7): the `web` slot's ${PULSE_RENDERED_DIR:-../rendered}:/rendered:ro
  // mount is DELIBERATELY NOT listed here. The REQ-MOUNT-02 guard parses the DEFAULT profile and does
  // `if (!svc) continue` for absent consumers; `web` is profiles:["web"]-gated, so listing it would add
  // ZERO coverage without reworking the guard to an all-profiles parse. The web mount is instead asserted
  // in apps/web/tests/smoke.test.ts (boots `--profile web`, reads /rendered/web-estate-model.json in-container).
];

/* ===========================================================================================
 * 7. Healthcheck budget (00 §7)
 * ========================================================================================= */

/** Baseline compose healthcheck budget; tuned per component at implementation. */
export const HEALTHCHECK_BUDGET = {
  interval: "10s",
  timeout: "5s",
  retries: 6,
  startPeriod: "30s",
} as const;

/** Per-service health probe (200-expecting HTTP GET unless noted). Detail in 02-compose-services.md §4. */
export const HEALTH_PROBES: Record<DefaultProfileService, string> = {
  victoriametrics: "GET /health on :8428",
  vmalert: "GET /health on :8880",
  alertmanager: "GET /-/healthy on :9093",
  gatus: "GET /health on :8080",
  grafana: "GET /api/health on :3000",
  cadvisor: "GET /healthz on :8080",
  "pve-exporter": "GET /metrics reachable on :9221",
};

/* ===========================================================================================
 * 9. Verification-harness types (00 §9)
 * ========================================================================================= */

/** Parsed `docker compose config` output subset the hermetic tests assert against. */
export interface ComposeConfig {
  name: string; // MUST equal COMPOSE_PROJECT
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
  volumes: Record<string, unknown>;
}

export interface ComposeService {
  image?: string; // absent for build-based services (web)
  build?: string | Record<string, unknown>;
  profiles?: string[];
  healthcheck?: Record<string, unknown>;
  volumes?: (string | Record<string, unknown>)[];
  depends_on?: Record<string, { condition: string }> | string[];
  environment?: Record<string, string> | string[];
}

/** Result of a single service health assertion in the smoke harness. */
export interface ServiceHealth {
  service: DefaultProfileService;
  healthy: boolean;
  /** `docker compose logs` tail captured when `healthy` is false. */
  logTail?: string;
}

/** A functional in-stack probe the smoke harness runs after `compose up --wait`. */
export interface FunctionalProbe {
  name: string; // e.g. "vm-self-scrape", "grafana-datasource"
  run(): Promise<boolean>;
}

/* ===========================================================================================
 * Path constants (06 §1) — anchored on import.meta.dir so paths are absolute regardless of CWD
 * ========================================================================================= */

/** Repo root: stack/tests → up two. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
/** The committed engine tree (01 §1). */
export const COMPOSE_FILE = resolve(REPO_ROOT, "stack", "compose", "docker-compose.yml");
/** The seeded rendered tree the smoke tier mounts (06 §3). */
export const FIXTURE_RENDERED_DIR = resolve(import.meta.dir, "fixtures", "rendered");

/* ===========================================================================================
 * Spawn helper (06 §2) — Bun built-in; no dependency
 * ========================================================================================= */

export interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing streams. Never throws on non-zero exit. */
export function run(argv: string[], env: Record<string, string> = {}): Ran {
  const p = Bun.spawnSync(argv, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** True iff the Docker DAEMON is reachable (not merely the CLI). */
export function dockerDaemonReachable(): boolean {
  try { return run(["docker", "version"]).exitCode === 0; }
  catch { return false; }
}

/** Placeholder env so `docker compose config`/`up` can interpolate ${VAR}s (never real). */
export const FIXTURE_ENV: Record<string, string> = {
  PULSE_RENDERED_DIR: FIXTURE_RENDERED_DIR,
  PVE_TOKEN: "placeholder-not-a-secret",
  PULSE_VM_RETENTION: "6",
};
