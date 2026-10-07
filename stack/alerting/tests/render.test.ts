// stack/alerting/tests/render.test.ts
// Tier-A unit tests for the transform harness (03 §2, item 008):
//   - buildAlertingConfig (pure) whole-or-nothing: any error finding → all four YAML fields "".
//   - buildAlertingConfig on a valid input serializes all four outputs.
//   - renderToDisk aborts BEFORE the transform on estate-load failure (nothing written).
//   - renderToDisk treats a missing/unparseable rendered input as INVALID_ROUTE (nothing written).
//   - renderToDisk whole-or-nothing: an error-producing estate writes ZERO files (tree untouched).
//   - renderToDisk on a valid estate stages temps then renames all four atomically.
/// <reference path="./bun-test.d.ts" />
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAlertingConfig, renderToDisk, type TransformInput } from "../src/render.js";
import type { AmRoutingRendered, ProberConfigRendered } from "../src/transform/rendered.js";
import type { EstateModel } from "../src/transform/estate.js";

const PROV = { file: "estate.yaml", path: "estate", line: 1, col: 1 } as const;

// ── Pure fixtures (no I/O) ───────────────────────────────────────────────────────────────────────

function renderedRouting(): AmRoutingRendered {
  return {
    route: {
      receiver: "oncall",
      routes: [
        { continue: false, match: { severity: "critical" }, receiver: "oncall" },
        { continue: false, match: { severity: "warning" }, receiver: "ops" },
      ],
    },
    receivers: [
      { name: "oncall", config: { webhook_configs: [{ url: "${OPSGENIE_WEBHOOK}" }] } },
      { name: "ops", config: { slack_configs: [{ api_url: "${SLACK_TOKEN}" }] } },
    ],
  };
}

function proberConfig(): ProberConfigRendered {
  return {
    probes: [
      {
        name: "svc:web-01/web-app",
        target: "https://web-app.example/healthz",
        kind: "deep-health",
        responseMapping: { "status": "$.status" },
        alertExpression: "status < 1",
      },
      {
        name: "svc:db-01/postgres#backup",
        target: "db-01",
        kind: "backup-freshness",
        threshold: "24h",
      },
    ],
  };
}

function model(over: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "render-fixture",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: [
      { name: "ops-chat", kind: "chat", credential: { kind: "env", raw: "${SLACK_TOKEN}", varName: "SLACK_TOKEN" }, provenance: PROV },
    ],
    routingOverrides: [],
    suppressions: [],
    ...over,
  };
}

/** A service whose Gatus ingress check carries an alerts: binding (synthetic-check rule, issue #1). */
function portalService(): EstateModel["services"][number] {
  return {
    name: "portal",
    host: "web-01",
    kind: "http",
    managed: true,
    ingressUrl: "https://portal.example/",
    alerts: [{ type: "custom" }],
    provenance: PROV,
  };
}

function input(over: Partial<TransformInput> = {}): TransformInput {
  return { estate: model(), routing: renderedRouting(), prober: proberConfig(), ...over };
}

describe("buildAlertingConfig (pure, 03 §2.2)", () => {
  test("a valid input serializes all four outputs", () => {
    const out = buildAlertingConfig(input({ estate: model({ services: [portalService()] }) }));
    expect(out.findings.some((f) => f.severity === "error")).toBe(false);
    expect(out.alertmanagerConfig).toContain("resolve_timeout");
    expect(out.deepHealthRules).toContain("DeepHealthFailed");
    expect(out.backupRules).toContain("BackupStale");
    expect(out.syntheticRules).toContain("GatusCheckFailed");
  });

  test("an estate with no alerts: binding renders an empty synthetic ruleset", () => {
    expect(buildAlertingConfig(input()).syntheticRules).toBe("groups: []\n");
  });

  test("is deterministic: identical input → byte-identical output", () => {
    const a = buildAlertingConfig(input());
    const b = buildAlertingConfig(input());
    expect(a.alertmanagerConfig).toBe(b.alertmanagerConfig);
    expect(a.deepHealthRules).toBe(b.deepHealthRules);
    expect(a.backupRules).toBe(b.backupRules);
    expect(a.syntheticRules).toBe(b.syntheticRules);
  });

  test("whole-or-nothing: any error finding blanks ALL four YAML fields", () => {
    // No channels → NO_HUMAN_CHANNEL (error) from routing (007).
    const out = buildAlertingConfig(
      input({ estate: model({ channels: [], services: [portalService()] }) }),
    );
    expect(out.findings.some((f) => f.code === "NO_HUMAN_CHANNEL" && f.severity === "error")).toBe(true);
    expect(out.alertmanagerConfig).toBe("");
    expect(out.deepHealthRules).toBe("");
    expect(out.backupRules).toBe("");
    expect(out.syntheticRules).toBe("");
  });

  test("whole-or-nothing: a malformed prober entry (INVALID_RULE) blanks ALL four fields", () => {
    const badProber: ProberConfigRendered = {
      probes: [{ name: "not-a-svc-name", target: "x", kind: "deep-health", alertExpression: "up < 1" }],
    };
    const out = buildAlertingConfig(
      input({ prober: badProber, estate: model({ services: [portalService()] }) }),
    );
    expect(out.findings.some((f) => f.code === "INVALID_RULE" && f.severity === "error")).toBe(true);
    expect(out.alertmanagerConfig).toBe("");
    expect(out.deepHealthRules).toBe("");
    expect(out.backupRules).toBe("");
    expect(out.syntheticRules).toBe("");
  });
});

// ── I/O fixtures (renderToDisk) ──────────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** Write a rendered tree with the routing + prober inputs renderToDisk reads. */
function writeRenderedTree(renderedDir: string): void {
  mkdirSync(join(renderedDir, "alertmanager"), { recursive: true });
  mkdirSync(join(renderedDir, "prober"), { recursive: true });
  const routingYaml = [
    "route:",
    "  receiver: oncall",
    "  routes:",
    "    - continue: false",
    "      match:",
    "        severity: critical",
    "      receiver: oncall",
    "    - continue: false",
    "      match:",
    "        severity: warning",
    "      receiver: ops",
    "receivers:",
    "  - name: oncall",
    "    config:",
    "      webhook_configs:",
    "        - url: ${OPSGENIE_WEBHOOK}",
    "  - name: ops",
    "    config:",
    "      slack_configs:",
    "        - api_url: ${SLACK_TOKEN}",
    "",
  ].join("\n");
  const proberYaml = [
    "probes:",
    "  - name: svc:web-01/web-app",
    "    target: https://web-app.example/healthz",
    "    kind: deep-health",
    "    responseMapping:",
    "      status: $.status",
    "    alertExpression: status < 1",
    "  - name: svc:db-01/postgres#backup",
    "    target: db-01",
    "    kind: backup-freshness",
    "    threshold: 24h",
    "",
  ].join("\n");
  writeFileSync(join(renderedDir, "alertmanager", "routing.yaml"), routingYaml, "utf8");
  writeFileSync(join(renderedDir, "prober", "config.yaml"), proberYaml, "utf8");
}

/** A valid estate (managed-linux host + a human chat channel) → loads ok:true, no error findings. */
function writeValidEstate(estateDir: string): void {
  const yaml = [
    "estate:",
    "  schema_version: 1",
    "  name: render-fixture",
    "  domains:",
    "    - example.com",
    "  timezone: UTC",
    '  deadman_hook: "${PULSE_DEADMANSSWITCH_URL}"',
    "",
    "hosts:",
    "  - name: web-01",
    "    collection_class: managed-linux",
    "    delivery_form: compose",
    "    addresses:",
    "      - 10.0.0.11",
    "    exporter_ports:",
    "      - 9100",
    "",
    "services:",
    "  - name: portal",
    "    host: web-01",
    "    kind: http",
    "    managed: true",
    "    ingress_url: https://portal.example/",
    "    alerts:",
    "      - type: custom",
    "        failure_threshold: 2",
    "",
    "channels:",
    "  - name: ops-chat",
    "    kind: chat",
    '    credential: "${SLACK_TOKEN}"',
    "",
  ].join("\n");
  writeFileSync(join(estateDir, "estate.yaml"), yaml, "utf8");
}

/** A valid-but-channel-less estate → loads ok:true, but the transform emits NO_HUMAN_CHANNEL (error). */
function writeNoChannelEstate(estateDir: string): void {
  const yaml = [
    "estate:",
    "  schema_version: 1",
    "  name: render-fixture",
    "  domains:",
    "    - example.com",
    "  timezone: UTC",
    '  deadman_hook: "${PULSE_DEADMANSSWITCH_URL}"',
    "",
    "hosts:",
    "  - name: web-01",
    "    collection_class: managed-linux",
    "    delivery_form: compose",
    "    addresses:",
    "      - 10.0.0.11",
    "    exporter_ports:",
    "      - 9100",
    "",
  ].join("\n");
  writeFileSync(join(estateDir, "estate.yaml"), yaml, "utf8");
}

/** An INVALID estate (managed-linux host missing exporter_ports) → loadAndValidate ok:false. */
function writeInvalidEstate(estateDir: string): void {
  const yaml = [
    "estate:",
    "  schema_version: 1",
    "  name: error-estate",
    "  domains:",
    "    - example.com",
    "  timezone: UTC",
    "  deadman_hook: https://example.com/deadman",
    "",
    "hosts:",
    "  - name: web-01",
    "    collection_class: managed-linux",
    "    delivery_form: compose",
    "    addresses:",
    "      - 10.0.0.11",
    "",
  ].join("\n");
  writeFileSync(join(estateDir, "estate.yaml"), yaml, "utf8");
}

const OUTPUT_PATHS = (renderedDir: string): string[] => [
  join(renderedDir, "alertmanager", "alertmanager.yml"),
  join(renderedDir, "vmalert", "rules", "deep-health.yml"),
  join(renderedDir, "vmalert", "rules", "backup.yml"),
  join(renderedDir, "vmalert", "rules", "synthetic.yml"),
];

describe("renderToDisk (03 §2.3)", () => {
  test("a valid estate stages temps then renames all four outputs atomically", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeValidEstate(estateDir);
    writeRenderedTree(renderedDir);

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "error")).toBe(false);
    expect(result.written).toEqual(OUTPUT_PATHS(renderedDir));
    for (const path of OUTPUT_PATHS(renderedDir)) expect(existsSync(path)).toBe(true);
    expect(readFileSync(OUTPUT_PATHS(renderedDir)[1]!, "utf8")).toContain("DeepHealthFailed");
    expect(readFileSync(OUTPUT_PATHS(renderedDir)[2]!, "utf8")).toContain("BackupStale");
    // The estate's alerts: binding (snake_case, through the real loader) reaches the synthetic rule.
    const synthetic = readFileSync(OUTPUT_PATHS(renderedDir)[3]!, "utf8");
    expect(synthetic).toContain("GatusCheckFailed");
    expect(synthetic).toContain(
      'gatus_results_total{name="web-01/portal",group="web-01",success="false"}[8m])) >= 2',
    );
    // No staging temp survives a successful rename.
    const amDir = readdirSync(join(renderedDir, "alertmanager"));
    expect(amDir.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("whole-or-nothing: an error-producing estate writes ZERO files (tree untouched)", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeNoChannelEstate(estateDir);
    writeRenderedTree(renderedDir);

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "NO_HUMAN_CHANNEL" && f.severity === "error")).toBe(true);
    expect(result.written).toEqual([]);
    for (const path of OUTPUT_PATHS(renderedDir)) expect(existsSync(path)).toBe(false);
    // The vmalert output subtree is never even created on the abort path.
    expect(existsSync(join(renderedDir, "vmalert"))).toBe(false);
  });

  test("estate-load failure aborts BEFORE the transform (estateFindings, nothing written)", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeInvalidEstate(estateDir);
    writeRenderedTree(renderedDir);

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(false);
    expect(result.estateFindings.length).toBeGreaterThan(0);
    expect(result.findings).toEqual([]); // transform never ran
    expect(result.written).toEqual([]);
    for (const path of OUTPUT_PATHS(renderedDir)) expect(existsSync(path)).toBe(false);
  });

  test("a missing/unparseable rendered input yields INVALID_ROUTE and writes nothing", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-"); // deliberately left without the rendered tree
    writeValidEstate(estateDir);

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(false);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.code).toBe("INVALID_ROUTE");
    expect(result.findings[0]!.severity).toBe("error");
    expect(result.written).toEqual([]);
    for (const path of OUTPUT_PATHS(renderedDir)) expect(existsSync(path)).toBe(false);
  });

  // Per-host prober configs (issue #8): host-local deep-health probes live in
  // agent/<host>/prober/config.yaml and must still generate central vmalert rules.
  const writePerHostProber = (renderedDir: string, host: string, service: string): void => {
    mkdirSync(join(renderedDir, "agent", host, "prober"), { recursive: true });
    const yaml = [
      "probes:",
      `  - name: svc:${host}/${service}`,
      "    target: http://127.0.0.1:5000/api/stats",
      "    kind: deep-health",
      "    responseMapping:",
      "      detectors: $.detectors.count",
      "    alertExpression: detectors < 1",
      "",
    ].join("\n");
    writeFileSync(join(renderedDir, "agent", host, "prober", "config.yaml"), yaml, "utf8");
  };
  const deepHealthRules = (renderedDir: string): string =>
    readFileSync(join(renderedDir, "vmalert", "rules", "deep-health.yml"), "utf8");

  test("a per-host prober config's deep-health probe generates a rule alongside the central ones (#8)", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeValidEstate(estateDir);
    writeRenderedTree(renderedDir); // central: svc:web-01/web-app
    writePerHostProber(renderedDir, "web-01", "frigate"); // host-local: svc:web-01/frigate

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(true);
    const rules = deepHealthRules(renderedDir);
    // Both the central probe AND the per-host probe produce bound rules.
    expect(rules).toContain('pulse_deep_health{service="web-app",metric="status"}');
    expect(rules).toContain('pulse_deep_health{service="frigate",metric="detectors"}');
  });

  test("an all-host-local estate (no central prober/config.yaml) still transforms — no INVALID_ROUTE (#8)", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeValidEstate(estateDir);
    writeRenderedTree(renderedDir);
    rmSync(join(renderedDir, "prober", "config.yaml")); // only host-local probes remain
    writePerHostProber(renderedDir, "web-01", "frigate");

    const result = renderToDisk({ estateDir, renderedDir });

    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.code === "INVALID_ROUTE")).toBe(false);
    expect(deepHealthRules(renderedDir)).toContain('pulse_deep_health{service="frigate",metric="detectors"}');
  });

  test("dry-run (write:false) reports ok without writing", () => {
    const estateDir = mkTmp("alerting-estate-");
    const renderedDir = mkTmp("alerting-rendered-");
    writeValidEstate(estateDir);
    writeRenderedTree(renderedDir);

    const result = renderToDisk({ estateDir, renderedDir, write: false });

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    for (const path of OUTPUT_PATHS(renderedDir)) expect(existsSync(path)).toBe(false);
  });
});
