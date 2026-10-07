// stack/alerting/tests/harness.ts
// The single non-test support module for the alerting suite (06 §1), mirroring stack/tests/harness.ts.
// It provides:
//   - the pinned tool-image constants (§2),
//   - the `run()` spawn helper + `DOCKER_OK` self-skip (re-exported from ./run.js),
//   - fixture/golden path constants (re-exported from ./paths.js),
//   - `loadFixtureInput(name): TransformInput` — read one estate fixture into the transform's input,
//   - `generateScaleFixture(...)` — the 200-host / ~2,000-alert factory (§8).
//
// It imports @pulse/core types and stack/alerting/src (the transform surface). It imports NO
// production notification-provider SDK (REQ-TEST-01): the only I/O is reading committed fixtures and,
// in the Tier-B suites, spawning pinned one-shot tool containers on the local Docker bridge.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EstateModel, Provenance } from "@pulse/core";
import type { TransformInput } from "../src/index.js";
import type { AmRoutingRendered, ProberConfigRendered } from "../src/transform/rendered.js";
import { run } from "./run.js";
import { AGENT_METRICS_JSON, CONTRACT_DIR, FIXTURE_DIR } from "./paths.js";

export { run, type Ran } from "./run.js";
export {
  TESTS_DIR,
  PKG_ROOT,
  REPO_ROOT,
  FIXTURE_DIR,
  GOLDEN_DIR,
  STATIC_RULES_DIR,
  PROMTOOL_FIXTURE_DIR,
  WEBHOOK_FIXTURE_DIR,
  CONTRACT_DIR,
  AGENT_METRICS_JSON,
} from "./paths.js";

// ── §2 pinned tool images (Tier B; REQ-TEST-01, CON-04) ─────────────────────────────────────────

/** amtool ships INSIDE the Alertmanager runtime image — reuse the exact stack pin (01 §6, tech-spec
 *  §6.2). amtool lives at /bin/amtool; invoke via `--entrypoint amtool`. */
export const AMTOOL_IMAGE = "prom/alertmanager:v0.27.0" as const;

/** promtool is NOT shipped by the VictoriaMetrics/vmalert images. This Prometheus image is a
 *  TEST-ONLY tool source (never wired into stack/compose — CON-04); vmalert rules are Prometheus
 *  rule-format, so `promtool test rules` validates & unit-tests them. */
export const PROMTOOL_IMAGE = "prom/prometheus:v2.53.2" as const;

/** The stack's exact VictoriaMetrics pin (stack/compose/docker-compose.yml). The synthetic-check
 *  suite evaluates rendered rules against a throwaway instance because MetricsQL's increase()
 *  differs from Prometheus's (no extrapolation; a new series' first sample counts) — promtool
 *  cannot stand in for it (issue #1). */
export const VM_IMAGE = "victoriametrics/victoria-metrics:v1.102.1" as const;

/** Local loopback HTTP receiver image for the webhook container layer (§6.4). Pinned. */
export const RECEIVER_IMAGE = "python:3.12-alpine" as const;

// ── §2 Docker daemon self-skip (mirrors stack/tests/bringup.smoke.test.ts) ───────────────────────

/** True iff a Docker daemon is reachable (the Tier-B container tier can run). Detected once at load
 *  time; each Tier-B suite opens with `const d = DOCKER_OK ? describe : describe.skip;`. */
export function dockerDaemonReachable(): boolean {
  try {
    return run(["docker", "version"]).exitCode === 0;
  } catch {
    return false; // CLI binary absent → not reachable
  }
}

/** Evaluated once at import — Tier-B suites gate their `describe` on this. */
export const DOCKER_OK = dockerDaemonReachable();

// ── §10 backup-freshness capability gate (item 014) ──────────────────────────────────────────────

/** The shape of the host-agent metrics contract this gate reads (only the fields it needs). The
 *  committed contract nests series under `families[].series[]` — there is NO top-level `series`
 *  array (00 §7 / agent/contract/metrics.json), so the gate MUST flatten the families. */
interface AgentMetricsContract {
  families?: readonly { series?: readonly { name: string }[] }[];
}

/**
 * True once host-agent delivers BOTH required backup-freshness series (00 §7,
 * `METRICS.backupAgeSeconds` / `METRICS.backupUp`). Until then the backup promtool block is
 * `describe.skip`ped — visibly PENDING, never a false green, never silently dropped (06 §10).
 *
 * The committed contract is shaped `{ contractVersion, families: [ { kind, prefix, series: [ {
 * name } ] } ] }` — it has NO top-level `series` array, so this flattens `families[].series[].name`
 * (NOT spec §10's `contract.series ?? []`, which would leave the gate permanently false and silently
 * defeat activation-on-delivery). Reading a temp metrics.json with a synthetic backup family injected
 * flips it to `true` with no other change — the activation-on-delivery mechanism for host-agent V-001.
 *
 * @param metricsJsonPath - The host-agent metrics contract to read (defaults to the committed one).
 * @returns Whether both backup-freshness series are present in the contract.
 */
export function backupMetricDelivered(metricsJsonPath: string = AGENT_METRICS_JSON): boolean {
  try {
    const contract = JSON.parse(readFileSync(metricsJsonPath, "utf8")) as AgentMetricsContract;
    const names = new Set(
      (contract.families ?? []).flatMap((f) => f.series ?? []).map((s) => s.name),
    );
    return names.has("pulse_backup_freshness_age_seconds") && names.has("pulse_backup_freshness_up");
  } catch {
    return false; // contract unreadable/malformed → not delivered
  }
}

// ── loadFixtureInput — read one estate fixture into a TransformInput (00 §4) ─────────────────────

/**
 * Load a committed estate fixture into the transform's input. Each fixture directory carries:
 *   - `estate.json`             — the fictional `EstateModel` (loadAndValidate-shaped, CON-05),
 *   - `alertmanager/routing.yaml` — the rendered abstract routing tree (single source of truth),
 *   - `prober/config.yaml`      — the rendered prober declarations (deep-health/backup sources).
 * All names are fictional and every secret is a `${VAR}`/`op://` reference (REQ-SEC-01, REQ-TEST-01).
 *
 * @param name - The fixture directory name (e.g. "multi-service").
 * @returns The `{ estate, routing, prober }` the pure transform consumes.
 */
export function loadFixtureInput(name: string): TransformInput {
  const dir = join(FIXTURE_DIR, name);
  const estate = JSON.parse(readFileSync(join(dir, "estate.json"), "utf8")) as EstateModel;
  const routing = parseYaml(
    readFileSync(join(dir, "alertmanager", "routing.yaml"), "utf8"),
  ) as AmRoutingRendered;
  const prober = parseYaml(
    readFileSync(join(dir, "prober", "config.yaml"), "utf8"),
  ) as ProberConfigRendered;
  return { estate, routing, prober };
}

// ── generateScaleFixture — the 200-host / ~2,000-alert scale factory (§8) ────────────────────────

/** Deterministic provenance for a factory-built model element (no clock/PID — REQ-DET-01). */
function prov(path: string): Provenance {
  return { file: "scale.yaml", path, line: 1, col: 1 };
}

/**
 * Generate a large, fictional, well-formed estate to exercise the transform's output-shape and
 * grouping behavior at scale (§8, REQ-PERF-01/REQ-SCALE-01). NOT a load test: it proves the pure
 * transform stays deterministic and preserves the critical route + `group_by` collapse as the estate
 * grows, without introducing any bespoke runtime.
 *
 * Each host contributes one deep-health probe and one backup probe to the prober config, so
 * `hosts=200` renders ~400 inventory rules; the `activeAlerts` count is a documented target for the
 * grouping sanity (the transform itself does not simulate live alerts).
 *
 * @param opts.hosts        - Number of fictional managed-linux hosts to generate.
 * @param opts.activeAlerts - Documented active-alert target for the grouping sanity (§8).
 * @returns A `TransformInput` with a fictional estate, routing tree, and prober config.
 */
export function generateScaleFixture(opts: { hosts: number; activeAlerts: number }): TransformInput {
  void opts.activeAlerts; // documented target for the §8 grouping sanity; not simulated by the transform
  const hostCount = opts.hosts;

  const hosts: EstateModel["hosts"] = [];
  const services: EstateModel["services"] = [];
  const probes: ProberConfigRendered["probes"] = [];

  for (let i = 0; i < hostCount; i++) {
    const host = `host-${String(i).padStart(4, "0")}`;
    hosts.push({
      name: host,
      collectionClass: "managed-linux",
      addresses: [`10.1.${Math.floor(i / 256)}.${i % 256}`],
      exporterPorts: [9100],
      cadvisor: true,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: [],
      provenance: prov(`hosts[${i}]`),
    });

    const dhService = `svc-dh-${String(i).padStart(4, "0")}`;
    const bkService = `svc-bk-${String(i).padStart(4, "0")}`;
    services.push({
      name: dhService,
      host,
      kind: "app",
      managed: true,
      deepHealth: {
        endpoint: `https://${dhService}.fixture.invalid/healthz`,
        responseMapping: { "service_ok": "$.ok" },
        alertExpression: "service_ok < 1",
      },
      provenance: prov(`services[dh-${i}]`),
    });
    services.push({
      name: bkService,
      host,
      kind: "backup",
      managed: true,
      backupFreshness: { signal: "restic", threshold: "24h" },
      provenance: prov(`services[bk-${i}]`),
    });

    probes.push({
      name: `svc:${host}/${dhService}`,
      target: `https://${dhService}.fixture.invalid/healthz`,
      kind: "deep-health",
      responseMapping: { "service_ok": "$.ok" },
      alertExpression: "service_ok < 1",
    });
    probes.push({
      name: `svc:${host}/${bkService}#backup`,
      target: host,
      kind: "backup-freshness",
      threshold: "24h",
    });
  }

  const estate: EstateModel = {
    schemaMajor: 1,
    estate: {
      name: "scale-fixture",
      domains: ["scale.invalid"],
      timezone: "UTC",
      deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
      provenance: prov("estate"),
    },
    hosts,
    services,
    channels: [
      {
        name: "ops-chat",
        kind: "chat",
        credential: { kind: "env", raw: "${SLACK_TOKEN}", varName: "SLACK_TOKEN" },
        provenance: prov("channels[0]"),
      },
    ],
    routingOverrides: [],
    suppressions: [],
  };

  const routing: AmRoutingRendered = {
    route: {
      receiver: "ops-chat",
      routes: [
        { match: { severity: "critical" }, receiver: "ops-chat" },
        { match: { severity: "warning" }, receiver: "ops-chat" },
      ],
    },
    receivers: [
      { name: "ops-chat", config: { slack_configs: [{ api_url: "${SLACK_TOKEN}" }] } },
    ],
  };

  return { estate, routing, prober: { probes } };
}

// ── webhook-event contract: schema + minimal structural validator (§6, item 013) ─────────────────
//
// The webhook contract test (webhook.test.ts) validates fixture payloads against
// contract/webhook-event.schema.json. Rather than add `ajv` as a devDependency, we ship the minimal
// structural validator the item allows — it covers exactly the JSON-Schema (draft 2020-12) subset the
// webhook schema uses: `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`
// (bool | schema), `items`, `minItems`, and `format: "date-time"` (RFC 3339). The schema uses no
// `$ref`, so no reference resolution is needed.

/** The loose JSON-Schema shape this validator understands (the webhook schema's used subset). */
export interface JsonSchemaNode {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  minItems?: number;
  format?: string;
}

/** The published automation-webhook event schema (item 010), loaded once. */
export const WEBHOOK_SCHEMA = JSON.parse(
  readFileSync(join(CONTRACT_DIR, "webhook-event.schema.json"), "utf8"),
) as JsonSchemaNode;

/** RFC 3339 date-time (the `format: date-time` shape the schema declares). Accepts the AM zero time
 *  `0001-01-01T00:00:00Z` (a valid RFC 3339 instant) as well as real timestamps. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** True iff `s` is a well-formed RFC 3339 date-time that also parses to a real instant. */
export function isRfc3339DateTime(s: string): boolean {
  return RFC3339.test(s) && !Number.isNaN(Date.parse(s));
}

/** The JSON type name used by the validator (arrays and null distinguished from `object`). */
function jsonTypeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function validateNode(schema: JsonSchemaNode, data: unknown, path: string, errors: string[]): void {
  if ("const" in schema && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: value ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const actual = jsonTypeOf(data);
    if (actual !== schema.type) {
      errors.push(`${path}: expected type "${schema.type}", got "${actual}"`);
      return; // shape is wrong — descending would only produce noise
    }
  }
  if (schema.type === "object") {
    const obj = data as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    const addl = schema.additionalProperties;
    for (const [key, value] of Object.entries(obj)) {
      const propSchema = props[key];
      if (propSchema) validateNode(propSchema, value, `${path}.${key}`, errors);
      else if (addl && typeof addl === "object") validateNode(addl, value, `${path}.${key}`, errors);
      // addl === true (or undefined → treated as permissive) → no constraint on extra properties
    }
  }
  if (schema.type === "array") {
    const arr = data as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${arr.length}`);
    }
    if (schema.items) {
      arr.forEach((item, i) => validateNode(schema.items!, item, `${path}[${i}]`, errors));
    }
  }
  if (schema.type === "string" && schema.format === "date-time" && typeof data === "string") {
    if (!isRfc3339DateTime(data)) errors.push(`${path}: "${data}" is not an RFC 3339 date-time`);
  }
}

/**
 * Validate `data` against a JSON-Schema `schema` (the draft-2020-12 subset used by the webhook
 * contract). Returns a list of human-readable error strings; an empty array means the payload
 * conforms. Deterministic and hermetic — pure in-process structural checks, no network (REQ-TEST-01).
 *
 * @param schema - The schema node to validate against (e.g. `WEBHOOK_SCHEMA`).
 * @param data   - The parsed JSON payload to check.
 * @returns The (possibly empty) list of conformance errors.
 */
export function validateAgainstSchema(schema: JsonSchemaNode, data: unknown): string[] {
  const errors: string[] = [];
  validateNode(schema, data, "$", errors);
  return errors;
}
