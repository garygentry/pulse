// apps/web/tests/estate-bundle-validation.test.ts — exhaustive mutation matrix for the pure bundle
// validator (rendered-model-v2, 05 §§5–8, 08 §8.7). Every row starts from a fully valid v2 bundle
// (`makeEstateBundleFixture`), applies exactly one mutation, and asserts the deterministic first
// `EstateBundleError` (artifact, kind, path, field, foundVersion, code) — so the asserted field is
// necessarily the first error. The module-private artifact validators are exercised only through the
// public `parseEstateBundle` trust boundary.

import { describe, expect, test } from "bun:test";

import { EstateBundleError } from "../src/shared/errors.js";
import type { EstateBundleArtifact, EstateBundleErrorKind } from "../src/shared/errors.js";
import { parseEstateBundle } from "../src/server/estate/validate.js";
import type { BundleFileBytes, EstateBundleLoadResult } from "../src/server/estate/load.js";
import {
  cloneJson,
  FIXTURE_PATHS,
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  serializeArtifact,
} from "./factories/estate-bundle.js";

const LOADED_AT = "2026-09-10T00:00:00.000Z";
const OTHER_BUNDLE_ID = `sha256:${"f".repeat(64)}` as const;

const PATH: Record<EstateBundleArtifact, string> = {
  model: FIXTURE_PATHS.model,
  coverage: FIXTURE_PATHS.coverage,
  findings: FIXTURE_PATHS.findings,
};

function toBytes(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  return serializeArtifact(v);
}

/** Serialize (or pass through raw strings / null) and validate one candidate bundle. */
function run(model: unknown, coverage: unknown, findings: unknown, loadedAt = LOADED_AT): EstateBundleLoadResult {
  const files: BundleFileBytes = {
    model: typeof model === "string" ? model : serializeArtifact(model),
    coverage: toBytes(coverage),
    findings: toBytes(findings),
  };
  return parseEstateBundle(files, FIXTURE_PATHS, loadedAt);
}

interface ExpectedError {
  kind: EstateBundleErrorKind;
  artifact: EstateBundleArtifact;
  field: string | null;
  foundVersion?: number | null;
}

function expectError(r: EstateBundleLoadResult, exp: ExpectedError): EstateBundleError {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a failure result");
  // No successful partial member is ever exposed on failure (05 §7).
  expect("bundle" in r).toBe(false);
  const e = r.error;
  expect(e).toBeInstanceOf(EstateBundleError);
  expect(e.kind).toBe(exp.kind);
  expect(e.artifact).toBe(exp.artifact);
  expect(e.path).toBe(PATH[exp.artifact]);
  expect(e.field).toBe(exp.field);
  expect(e.code).toBe(`ESTATE_BUNDLE_${exp.kind.toUpperCase()}`);
  expect(e.foundVersion).toBe(exp.foundVersion ?? null);
  return e;
}

// A structure error on `model` with the given field.
function ms(field: string): ExpectedError {
  return { kind: "structure", artifact: "model", field };
}

// ── Valid bundles succeed ─────────────────────────────────────────────────────────────────────────

describe("valid bundles", () => {
  test("a complete v2 bundle succeeds and exposes the injected loadedAt", () => {
    const f = makeEstateBundleFixture();
    const r = run(f.model, f.coverage, f.findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.model.estate.name).toBe("home-estate");
    expect(r.bundle.coverage).not.toBeNull();
    expect(r.bundle.findings).not.toBeNull();
    expect(r.bundle.loadedAt).toBe(LOADED_AT);
  });

  test("missing both optional siblings succeeds with null members", () => {
    const f = makeEstateBundleFixture();
    const r = run(f.model, null, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.coverage).toBeNull();
    expect(r.bundle.findings).toBeNull();
  });

  test("missing coverage only, and missing findings only, both succeed", () => {
    const f = makeEstateBundleFixture();
    const a = run(f.model, null, f.findings);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.bundle.coverage).toBeNull();
    const b = run(f.model, f.coverage, null);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.bundle.findings).toBeNull();
  });

  test("a structurally valid empty estate with three empty buckets and empty findings succeeds", () => {
    const model = makeWebEstateModelV2({
      hosts: [],
      services: [],
      channels: [],
      routingOverrides: [],
      suppressions: [],
    });
    const coverage = makeWebCoverageArtifact(model);
    const findings = { formatVersion: 2 as const, bundleId: model.bundleId, findings: [] };
    const r = run(model, coverage, findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.coverage?.covered).toEqual([]);
    expect(r.bundle.coverage?.gaps).toEqual([]);
    expect(r.bundle.coverage?.suppressed).toEqual([]);
  });

  test("valid nas both-null branch, deadman plain, and null optionals succeed", () => {
    const model = makeWebEstateModelV2();
    (model.hosts[2] as { detail: unknown }).detail = { apiEndpoint: null, credential: null };
    model.estate.deadman.kind = "plain";
    model.estate.dnsResolver = null;
    model.estate.retention = null;
    const r = run(model, null, null);
    expect(r.ok).toBe(true);
  });
});

// ── Common header: JSON, root, version, bundle id (05 §§4.2, 5.2) ────────────────────────────────

describe("artifact header", () => {
  test("invalid JSON in each member is unparseable at $", () => {
    const f = makeEstateBundleFixture();
    expectError(run("{ not json", f.coverage, f.findings), { kind: "unparseable", artifact: "model", field: "$" });
    expectError(run(f.model, "{ not json", f.findings), {
      kind: "unparseable",
      artifact: "coverage",
      field: "$",
    });
    expectError(run(f.model, f.coverage, "{ not json"), {
      kind: "unparseable",
      artifact: "findings",
      field: "$",
    });
  });

  test("primitive/array/null roots are a structure error at $", () => {
    const f = makeEstateBundleFixture();
    expectError(run("[]", null, null), ms("$"));
    expectError(run("123", null, null), ms("$"));
    expectError(run("null", null, null), ms("$"));
    expectError(run(f.model, "null", null), { kind: "structure", artifact: "coverage", field: "$" });
    expectError(run(f.model, null, "42"), { kind: "structure", artifact: "findings", field: "$" });
  });

  const versionRows: Array<{ name: string; value: unknown; foundVersion: number | null }> = [
    { name: "missing", value: undefined, foundVersion: null },
    { name: "string '2'", value: "2", foundVersion: null },
    { name: "v1", value: 1, foundVersion: 1 },
    { name: "v3", value: 3, foundVersion: 3 },
    { name: "fractional 2.5", value: 2.5, foundVersion: 2.5 },
  ];
  for (const row of versionRows) {
    test(`model formatVersion ${row.name} is a version error with foundVersion ${row.foundVersion}`, () => {
      const model = cloneJson(makeEstateBundleFixture().model) as unknown as Record<string, unknown>;
      if (row.value === undefined) delete model["formatVersion"];
      else model["formatVersion"] = row.value;
      expectError(run(model, null, null), {
        kind: "version",
        artifact: "model",
        field: "formatVersion",
        foundVersion: row.foundVersion,
      });
    });
  }

  test("coverage and findings version failures are attributed to their member", () => {
    const f = makeEstateBundleFixture();
    const cov = cloneJson(f.coverage) as unknown as Record<string, unknown>;
    cov["formatVersion"] = 3;
    expectError(run(f.model, cov, null), {
      kind: "version",
      artifact: "coverage",
      field: "formatVersion",
      foundVersion: 3,
    });
    const find = cloneJson(f.findings) as unknown as Record<string, unknown>;
    find["formatVersion"] = 1;
    expectError(run(f.model, f.coverage, find), {
      kind: "version",
      artifact: "findings",
      field: "formatVersion",
      foundVersion: 1,
    });
  });

  test("a malformed bundleId is a structure error at bundleId in each member", () => {
    const f = makeEstateBundleFixture();
    const model = cloneJson(f.model) as unknown as Record<string, unknown>;
    model["bundleId"] = "sha256:NOTHEX";
    expectError(run(model, null, null), ms("bundleId"));
    const cov = cloneJson(f.coverage) as unknown as Record<string, unknown>;
    cov["bundleId"] = "md5:abc";
    expectError(run(f.model, cov, null), { kind: "structure", artifact: "coverage", field: "bundleId" });
    const find = cloneJson(f.findings) as unknown as Record<string, unknown>;
    find["bundleId"] = "sha256:" + "z".repeat(64);
    expectError(run(f.model, null, find), { kind: "structure", artifact: "findings", field: "bundleId" });
  });
});

// ── Model structure field matrix (05 §5.3) ────────────────────────────────────────────────────────

type Mut = (m: any) => void;

const modelRows: Array<{ name: string; field: string; mutate: Mut }> = [
  // estate metadata
  { name: "estate missing", field: "estate", mutate: (m) => delete m.estate },
  { name: "estate.name wrong type", field: "estate.name", mutate: (m) => (m.estate.name = 5) },
  { name: "estate.name empty", field: "estate.name", mutate: (m) => (m.estate.name = "") },
  { name: "estate.domains not array", field: "estate.domains", mutate: (m) => (m.estate.domains = "x") },
  { name: "estate.domains element non-string", field: "estate.domains[0]", mutate: (m) => (m.estate.domains = [7]) },
  { name: "estate.timezone missing", field: "estate.timezone", mutate: (m) => delete m.estate.timezone },
  { name: "estate.dnsResolver wrong type", field: "estate.dnsResolver", mutate: (m) => (m.estate.dnsResolver = 1) },
  { name: "estate.retention wrong type", field: "estate.retention", mutate: (m) => (m.estate.retention = 1) },
  { name: "estate.schemaMajor zero", field: "estate.schemaMajor", mutate: (m) => (m.estate.schemaMajor = 0) },
  { name: "estate.schemaMajor fractional", field: "estate.schemaMajor", mutate: (m) => (m.estate.schemaMajor = 1.5) },
  { name: "estate.deadman missing", field: "estate.deadman", mutate: (m) => delete m.estate.deadman },
  { name: "deadman.configured non-bool", field: "estate.deadman.configured", mutate: (m) => (m.estate.deadman.configured = "yes") },
  { name: "deadman.kind invalid", field: "estate.deadman.kind", mutate: (m) => (m.estate.deadman.kind = "other") },
  // top-level arrays
  { name: "hosts not array", field: "hosts", mutate: (m) => (m.hosts = {}) },
  { name: "services not array", field: "services", mutate: (m) => (m.services = {}) },
  { name: "channels not array", field: "channels", mutate: (m) => (m.channels = 0) },
  { name: "routingOverrides not array", field: "routingOverrides", mutate: (m) => (m.routingOverrides = 0) },
  { name: "suppressions not array", field: "suppressions", mutate: (m) => (m.suppressions = 0) },
  // host base
  { name: "host not object", field: "hosts[0]", mutate: (m) => (m.hosts[0] = 3) },
  { name: "host.name", field: "hosts[0].name", mutate: (m) => (m.hosts[0].name = 3) },
  { name: "host.collectionClass invalid", field: "hosts[0].collectionClass", mutate: (m) => (m.hosts[0].collectionClass = "vm") },
  { name: "host.addresses not array", field: "hosts[0].addresses", mutate: (m) => (m.hosts[0].addresses = "x") },
  { name: "host.addresses element", field: "hosts[0].addresses[0]", mutate: (m) => (m.hosts[0].addresses = [1]) },
  { name: "host.suppressed non-object", field: "hosts[0].suppressed", mutate: (m) => (m.hosts[0].suppressed = 5) },
  { name: "host.suppressed.class invalid", field: "hosts[0].suppressed.class", mutate: (m) => (m.hosts[0].suppressed = { class: "x", rationale: "r" }) },
  { name: "host.suppressed.rationale missing", field: "hosts[0].suppressed.rationale", mutate: (m) => (m.hosts[0].suppressed = { class: "excluded" }) },
  { name: "host.drilldownId wrong type", field: "hosts[0].drilldownId", mutate: (m) => (m.hosts[0].drilldownId = 1) },
  { name: "host.expectedChurn non-bool", field: "hosts[0].expectedChurn", mutate: (m) => (m.hosts[0].expectedChurn = "no") },
  { name: "host.scrapeIntervalClass wrong type", field: "hosts[0].scrapeIntervalClass", mutate: (m) => (m.hosts[0].scrapeIntervalClass = 5) },
  { name: "host.provenance missing", field: "hosts[0].provenance", mutate: (m) => delete m.hosts[0].provenance },
  { name: "host.provenance.file unsafe", field: "hosts[0].provenance.file", mutate: (m) => (m.hosts[0].provenance.file = "/etc/passwd") },
  { name: "host.provenance.path non-string", field: "hosts[0].provenance.path", mutate: (m) => (m.hosts[0].provenance.path = 1) },
  { name: "host.provenance.line zero", field: "hosts[0].provenance.line", mutate: (m) => (m.hosts[0].provenance.line = 0) },
  { name: "host.provenance.col zero", field: "hosts[0].provenance.col", mutate: (m) => (m.hosts[0].provenance.col = 0) },
  { name: "host.scrapeTargets not array", field: "hosts[0].scrapeTargets", mutate: (m) => (m.hosts[0].scrapeTargets = 1) },
  { name: "scrapeTargets[0].job", field: "hosts[0].scrapeTargets[0].job", mutate: (m) => (m.hosts[0].scrapeTargets[0].job = "") },
  { name: "scrapeTargets[0].instance", field: "hosts[0].scrapeTargets[0].instance", mutate: (m) => delete m.hosts[0].scrapeTargets[0].instance },
  { name: "host.artifacts not array", field: "hosts[0].artifacts", mutate: (m) => (m.hosts[0].artifacts = 1) },
  { name: "host.artifacts unsafe", field: "hosts[0].artifacts[0]", mutate: (m) => (m.hosts[0].artifacts = ["../secret"]) },
  { name: "host.artifacts duplicate", field: "hosts[0].artifacts[1]", mutate: (m) => (m.hosts[0].artifacts = ["scrape/hostA.yml", "scrape/hostA.yml"]) },
  { name: "host.detail missing", field: "hosts[0].detail", mutate: (m) => delete m.hosts[0].detail },
  // managed-linux detail
  { name: "exporterPorts not array", field: "hosts[0].detail.exporterPorts", mutate: (m) => (m.hosts[0].detail.exporterPorts = 1) },
  { name: "exporterPorts element non-positive", field: "hosts[0].detail.exporterPorts[0]", mutate: (m) => (m.hosts[0].detail.exporterPorts = [0]) },
  { name: "cadvisor non-bool", field: "hosts[0].detail.cadvisor", mutate: (m) => (m.hosts[0].detail.cadvisor = 1) },
  { name: "heartbeat non-bool", field: "hosts[0].detail.heartbeat", mutate: (m) => (m.hosts[0].detail.heartbeat = 1) },
  { name: "deliveryForm invalid", field: "hosts[0].detail.deliveryForm", mutate: (m) => (m.hosts[0].detail.deliveryForm = "helm") },
  { name: "commandSignals not array", field: "hosts[0].detail.commandSignals", mutate: (m) => (m.hosts[0].detail.commandSignals = 1) },
  { name: "signal.name", field: "hosts[0].detail.commandSignals[0].name", mutate: (m) => (m.hosts[0].detail.commandSignals[0].name = "") },
  { name: "signal.output invalid", field: "hosts[0].detail.commandSignals[0].output", mutate: (m) => (m.hosts[0].detail.commandSignals[0].output = "table") },
  { name: "signal.interval", field: "hosts[0].detail.commandSignals[0].interval", mutate: (m) => (m.hosts[0].detail.commandSignals[0].interval = 1) },
  { name: "signal.command", field: "hosts[0].detail.commandSignals[0].command", mutate: (m) => delete m.hosts[0].detail.commandSignals[0].command },
  { name: "signal.credential not object", field: "hosts[0].detail.commandSignals[0].credential", mutate: (m) => (m.hosts[0].detail.commandSignals[0].credential = 5) },
  { name: "signal.credential.kind invalid", field: "hosts[0].detail.commandSignals[0].credential.kind", mutate: (m) => (m.hosts[0].detail.commandSignals[0].credential = { kind: "x", display: "y" }) },
  { name: "scalar signal metric missing", field: "hosts[0].detail.commandSignals[0].metric", mutate: (m) => delete m.hosts[0].detail.commandSignals[0].metric },
  { name: "scalar signal upMetric missing", field: "hosts[0].detail.commandSignals[0].upMetric", mutate: (m) => delete m.hosts[0].detail.commandSignals[0].upMetric },
  { name: "scalar labels non-object", field: "hosts[0].detail.commandSignals[0].labels", mutate: (m) => (m.hosts[0].detail.commandSignals[0].labels = 1) },
  { name: "scalar labels value non-string", field: 'hosts[0].detail.commandSignals[0].labels["mount"]', mutate: (m) => (m.hosts[0].detail.commandSignals[0].labels = { mount: 1 }) },
  { name: "exposition signal carries metric", field: "hosts[0].detail.commandSignals[1].metric", mutate: (m) => (m.hosts[0].detail.commandSignals[1].metric = "x") },
  // hypervisor detail
  { name: "hypervisor apiEndpoint missing", field: "hosts[1].detail.apiEndpoint", mutate: (m) => delete m.hosts[1].detail.apiEndpoint },
  { name: "hypervisor credential missing", field: "hosts[1].detail.credential", mutate: (m) => delete m.hosts[1].detail.credential },
  { name: "env credential display mismatch", field: "hosts[1].detail.credential.display", mutate: (m) => (m.hosts[1].detail.credential.display = "PVE") },
  // nas detail
  { name: "op credential display mismatch", field: "hosts[2].detail.credential.display", mutate: (m) => (m.hosts[2].detail.credential.display = "op://x") },
  { name: "nas endpoint string but credential null", field: "hosts[2].detail.credential", mutate: (m) => (m.hosts[2].detail.credential = null) },
  { name: "nas endpoint null but credential set", field: "hosts[2].detail.apiEndpoint", mutate: (m) => (m.hosts[2].detail.apiEndpoint = null) },
  { name: "nas endpoint wrong type", field: "hosts[2].detail.apiEndpoint", mutate: (m) => (m.hosts[2].detail.apiEndpoint = 5) },
  // probe detail
  { name: "probe missing", field: "hosts[3].detail.probe", mutate: (m) => delete m.hosts[3].detail.probe },
  { name: "probe.kind", field: "hosts[3].detail.probe.kind", mutate: (m) => (m.hosts[3].detail.probe.kind = "") },
  { name: "probe.target", field: "hosts[3].detail.probe.target", mutate: (m) => delete m.hosts[3].detail.probe.target },
  { name: "probe.expect wrong type", field: "hosts[3].detail.probe.expect", mutate: (m) => (m.hosts[3].detail.probe.expect = 1) },
  // excluded detail
  { name: "excluded detail has a key", field: 'hosts[4].detail["extra"]', mutate: (m) => (m.hosts[4].detail = { extra: 1 }) },
  // service base
  { name: "service not object", field: "services[0]", mutate: (m) => (m.services[0] = 1) },
  { name: "service.name", field: "services[0].name", mutate: (m) => (m.services[0].name = 1) },
  { name: "service.host wrong type", field: "services[0].host", mutate: (m) => (m.services[0].host = 1) },
  { name: "service.managed non-bool", field: "services[0].managed", mutate: (m) => (m.services[0].managed = 1) },
  { name: "service.deepHealth non-bool", field: "services[0].deepHealth", mutate: (m) => (m.services[0].deepHealth = 1) },
  { name: "service.ingressUrl present empty", field: "services[0].ingressUrl", mutate: (m) => (m.services[0].ingressUrl = "") },
  { name: "service.drilldownId wrong type", field: "services[0].drilldownId", mutate: (m) => (m.services[0].drilldownId = 1) },
  { name: "service.kind", field: "services[0].kind", mutate: (m) => (m.services[0].kind = "") },
  { name: "service.provenance.file unsafe", field: "services[0].provenance.file", mutate: (m) => (m.services[0].provenance.file = "a\\b") },
  { name: "service.gatusEndpoints not array", field: "services[0].gatusEndpoints", mutate: (m) => (m.services[0].gatusEndpoints = 1) },
  { name: "service.gatusEndpoints element", field: "services[0].gatusEndpoints[0]", mutate: (m) => (m.services[0].gatusEndpoints = [1]) },
  { name: "service.artifacts unsafe", field: "services[0].artifacts[0]", mutate: (m) => (m.services[0].artifacts = ["/abs.yml"]) },
  { name: "service.artifacts duplicate", field: "services[2].artifacts[1]", mutate: (m) => (m.services[2].artifacts = ["gatus/restic.yml", "gatus/restic.yml"]) },
  { name: "deepHealth true but detail null", field: "services[0].deepHealthDetail", mutate: (m) => (m.services[0].deepHealthDetail = null) },
  { name: "deepHealth false but detail present", field: "services[1].deepHealthDetail", mutate: (m) => (m.services[1].deepHealthDetail = {}) },
  // deep-health detail
  { name: "dh.endpoint", field: "services[0].deepHealthDetail.endpoint", mutate: (m) => (m.services[0].deepHealthDetail.endpoint = "") },
  { name: "dh.metrics not array", field: "services[0].deepHealthDetail.metrics", mutate: (m) => (m.services[0].deepHealthDetail.metrics = 1) },
  { name: "dh.metrics element", field: "services[0].deepHealthDetail.metrics[0]", mutate: (m) => (m.services[0].deepHealthDetail.metrics = [1, 2]) },
  { name: "dh.responseMapping non-object", field: "services[0].deepHealthDetail.responseMapping", mutate: (m) => (m.services[0].deepHealthDetail.responseMapping = 1) },
  { name: "dh.responseMapping value non-string", field: 'services[0].deepHealthDetail.responseMapping["cache"]', mutate: (m) => (m.services[0].deepHealthDetail.responseMapping = { cache: 1, db: "$.db" }) },
  { name: "dh.alertExpression", field: "services[0].deepHealthDetail.alertExpression", mutate: (m) => delete m.services[0].deepHealthDetail.alertExpression },
  { name: "dh.hostLocal non-bool", field: "services[0].deepHealthDetail.hostLocal", mutate: (m) => (m.services[0].deepHealthDetail.hostLocal = 1) },
  { name: "dh.credential invalid", field: "services[0].deepHealthDetail.credential", mutate: (m) => (m.services[0].deepHealthDetail.credential = 5) },
  { name: "dh.metrics disagree with mapping", field: "services[0].deepHealthDetail.metrics", mutate: (m) => (m.services[0].deepHealthDetail.metrics = ["cache"]) },
  // backup freshness
  { name: "backup non-object non-null", field: "services[1].backupFreshness", mutate: (m) => (m.services[1].backupFreshness = 1) },
  { name: "backup.signal", field: "services[1].backupFreshness.signal", mutate: (m) => (m.services[1].backupFreshness.signal = "") },
  { name: "backup.threshold", field: "services[1].backupFreshness.threshold", mutate: (m) => delete m.services[1].backupFreshness.threshold },
  { name: "backup.interval", field: "services[1].backupFreshness.interval", mutate: (m) => (m.services[1].backupFreshness.interval = 1) },
  { name: "backup.hasCommand non-bool", field: "services[1].backupFreshness.hasCommand", mutate: (m) => (m.services[1].backupFreshness.hasCommand = 1) },
  // alerts
  { name: "alerts not array", field: "services[0].alerts", mutate: (m) => (m.services[0].alerts = 1) },
  { name: "alert not object", field: "services[0].alerts[0]", mutate: (m) => (m.services[0].alerts[0] = 1) },
  { name: "alert.type", field: "services[0].alerts[0].type", mutate: (m) => (m.services[0].alerts[0].type = "") },
  { name: "alert.enabled non-bool", field: "services[0].alerts[0].enabled", mutate: (m) => (m.services[0].alerts[0].enabled = 1) },
  { name: "alert.failureThreshold zero", field: "services[0].alerts[0].failureThreshold", mutate: (m) => (m.services[0].alerts[0].failureThreshold = 0) },
  { name: "alert.successThreshold fractional", field: "services[0].alerts[0].successThreshold", mutate: (m) => (m.services[0].alerts[0].successThreshold = 1.5) },
  { name: "alert.description empty", field: "services[0].alerts[0].description", mutate: (m) => (m.services[0].alerts[0].description = "") },
  { name: "alert.sendOnResolved non-bool", field: "services[0].alerts[0].sendOnResolved", mutate: (m) => (m.services[0].alerts[0].sendOnResolved = 1) },
  // channels
  { name: "channel not object", field: "channels[0]", mutate: (m) => (m.channels[0] = 1) },
  { name: "channel.name", field: "channels[0].name", mutate: (m) => (m.channels[0].name = "") },
  { name: "channel.kind invalid", field: "channels[0].kind", mutate: (m) => (m.channels[0].kind = "sms") },
  { name: "channel.credential missing", field: "channels[0].credential", mutate: (m) => delete m.channels[0].credential },
  { name: "channel.options non-object non-null", field: "channels[0].options", mutate: (m) => (m.channels[0].options = 1) },
  { name: "channel.options value invalid", field: 'channels[0].options["chat-id"]', mutate: (m) => (m.channels[0].options["chat-id"] = []) },
  { name: "channel.options value null", field: 'channels[0].options["chat-id"]', mutate: (m) => (m.channels[0].options["chat-id"] = null) },
  { name: "channel.provenance missing", field: "channels[0].provenance", mutate: (m) => delete m.channels[0].provenance },
  // routing overrides
  { name: "routing.severity", field: "routingOverrides[0].severity", mutate: (m) => (m.routingOverrides[0].severity = "") },
  { name: "routing.channels not array", field: "routingOverrides[0].channels", mutate: (m) => (m.routingOverrides[0].channels = 1) },
  { name: "routing.channels element", field: "routingOverrides[0].channels[0]", mutate: (m) => (m.routingOverrides[0].channels = [1]) },
  { name: "routing.provenance missing", field: "routingOverrides[0].provenance", mutate: (m) => delete m.routingOverrides[0].provenance },
  // standalone suppressions
  { name: "suppression.target", field: "suppressions[0].target", mutate: (m) => (m.suppressions[0].target = "") },
  { name: "suppression.class invalid", field: "suppressions[0].class", mutate: (m) => (m.suppressions[0].class = "x") },
  { name: "suppression.rationale", field: "suppressions[0].rationale", mutate: (m) => delete m.suppressions[0].rationale },
  { name: "suppression.provenance missing", field: "suppressions[0].provenance", mutate: (m) => delete m.suppressions[0].provenance },
  { name: "suppression.resolves not array", field: "suppressions[0].resolves", mutate: (m) => (m.suppressions[0].resolves = 1) },
  { name: "suppression.resolves element", field: "suppressions[0].resolves[0]", mutate: (m) => (m.suppressions[0].resolves = [1]) },
];

describe("model structure matrix", () => {
  for (const row of modelRows) {
    test(row.name, () => {
      const m = cloneJson(makeEstateBundleFixture().model) as any;
      row.mutate(m);
      expectError(run(m, null, null), ms(row.field));
    });
  }
});

// ── Model identity checks (05 §6.2) ───────────────────────────────────────────────────────────────

describe("model identities", () => {
  const rows: Array<{ name: string; field: string; mutate: Mut }> = [
    { name: "duplicate host name", field: "hosts[1].name", mutate: (m) => (m.hosts[1].name = "hostA-managed") },
    { name: "wrong host drilldownId", field: "hosts[0].drilldownId", mutate: (m) => (m.hosts[0].drilldownId = "host:wrong") },
    { name: "duplicate service identity", field: "services[1].name", mutate: (m) => { m.services[1].host = "hostA-managed"; m.services[1].name = "grafana"; } },
    { name: "unknown owner host", field: "services[0].host", mutate: (m) => (m.services[0].host = "ghost") },
    { name: "wrong service drilldownId", field: "services[0].drilldownId", mutate: (m) => (m.services[0].drilldownId = "svc:wrong") },
    { name: "unresolved suppression resolves", field: "suppressions[0].resolves[0]", mutate: (m) => (m.suppressions[0].resolves = ["host:nope"]) },
    { name: "duplicate resolves entry", field: "suppressions[0].resolves[1]", mutate: (m) => (m.suppressions[0].resolves = ["host:hostE-excluded", "host:hostE-excluded"]) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const m = cloneJson(makeEstateBundleFixture().model) as any;
      row.mutate(m);
      expectError(run(m, null, null), ms(row.field));
    });
  }
});

// ── Coverage structure and bucket invariants (05 §5.4) ────────────────────────────────────────────

function covErr(field: string, kind: EstateBundleErrorKind = "structure"): ExpectedError {
  return { kind, artifact: "coverage", field };
}

describe("coverage structure", () => {
  const rows: Array<{ name: string; field: string; mutate: Mut }> = [
    { name: "bucket not array", field: "covered", mutate: (c) => (c.covered = 1) },
    { name: "entry not object", field: "covered[0]", mutate: (c) => (c.covered[0] = 1) },
    { name: "entry.kind invalid", field: "covered[0].kind", mutate: (c) => (c.covered[0].kind = "cluster") },
    { name: "entry.name", field: "covered[0].name", mutate: (c) => (c.covered[0].name = 1) },
    { name: "entry.collectionClass invalid", field: "covered[0].collectionClass", mutate: (c) => (c.covered[0].collectionClass = "vm") },
    { name: "entry.artifacts unsafe", field: "covered[0].artifacts[0]", mutate: (c) => (c.covered[0].artifacts = ["../x"]) },
    { name: "entry.artifacts duplicate", field: "covered[0].artifacts[1]", mutate: (c) => (c.covered[0].artifacts = ["scrape/hostA.yml", "scrape/hostA.yml"]) },
    { name: "suppressed entry.suppressed.class invalid", field: "suppressed[0].suppressed.class", mutate: (c) => (c.suppressed[0].suppressed = { class: "x", rationale: "r" }) },
    { name: "covered entry suppressed non-null", field: "covered[0].suppressed", mutate: (c) => (c.covered[0].suppressed = { class: "excluded", rationale: "r" }) },
    { name: "covered entry with no artifacts", field: "covered[0].artifacts", mutate: (c) => (c.covered[0].artifacts = []) },
    { name: "gap entry suppressed non-null", field: "gaps[0].suppressed", mutate: (c) => (c.gaps[0].suppressed = { class: "excluded", rationale: "r" }) },
    { name: "gap entry with artifacts", field: "gaps[0].artifacts", mutate: (c) => (c.gaps[0].artifacts = ["scrape/x.yml"]) },
    { name: "suppressed entry with null suppression", field: "suppressed[0].suppressed", mutate: (c) => (c.suppressed[0].suppressed = null) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const f = makeEstateBundleFixture();
      const c = cloneJson(f.coverage) as any;
      row.mutate(c);
      expectError(run(f.model, c, null), covErr(row.field));
    });
  }
});

// ── Coverage/model coherence (05 §6.3) ────────────────────────────────────────────────────────────

describe("coverage/model coherence", () => {
  test("duplicate entity across buckets fails on the later entry name", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.gaps.push({ kind: "host", name: "hostA-managed", collectionClass: "managed-linux", artifacts: [], suppressed: null });
    expectError(run(f.model, c, null), covErr(`gaps[${c.gaps.length - 1}].name`, "incoherent"));
  });

  test("extra/unknown coverage entity fails at its name", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.covered.push({ kind: "host", name: "ghostX", collectionClass: "managed-linux", artifacts: ["scrape/ghost.yml"], suppressed: null });
    expectError(run(f.model, c, null), covErr(`covered[${c.covered.length - 1}].name`, "incoherent"));
  });

  test("wrong-kind entry fails at its name", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.covered[0].kind = "service"; // name "hostA-managed" is not a service composite
    expectError(run(f.model, c, null), covErr("covered[0].name", "incoherent"));
  });

  test("collection-class mismatch fails at collectionClass", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.covered[0].collectionClass = "probe-only";
    expectError(run(f.model, c, null), covErr("covered[0].collectionClass", "incoherent"));
  });

  test("artifact-relationship mismatch fails at artifacts", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.covered[0].artifacts = ["scrape/other.yml"];
    expectError(run(f.model, c, null), covErr("covered[0].artifacts", "incoherent"));
  });

  test("suppression mismatch fails at suppressed", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.suppressed[0].suppressed.rationale = "different rationale";
    expectError(run(f.model, c, null), covErr("suppressed[0].suppressed", "incoherent"));
  });

  const missingRows: Array<{ name: string; field: string; mutate: Mut }> = [
    { name: "missing covered entity", field: "covered", mutate: (c) => (c.covered = c.covered.filter((e: any) => e.name !== "hostA-managed")) },
    { name: "missing gap entity", field: "gaps", mutate: (c) => (c.gaps = c.gaps.filter((e: any) => e.name !== "hostD-probe")) },
    { name: "missing suppressed entity", field: "suppressed", mutate: (c) => (c.suppressed = c.suppressed.filter((e: any) => e.name !== "hostE-excluded")) },
  ];
  for (const row of missingRows) {
    test(row.name, () => {
      const f = makeEstateBundleFixture();
      const c = cloneJson(f.coverage) as any;
      row.mutate(c);
      expectError(run(f.model, c, null), covErr(row.field, "incoherent"));
    });
  }
});

// ── Cross-artifact bundle identity (05 §6.1) ──────────────────────────────────────────────────────

describe("bundle identity coherence", () => {
  test("mismatched coverage id wins over mismatched findings id", () => {
    const f = makeEstateBundleFixture();
    const c = cloneJson(f.coverage) as any;
    c.bundleId = OTHER_BUNDLE_ID;
    const fnd = cloneJson(f.findings) as any;
    fnd.bundleId = OTHER_BUNDLE_ID;
    expectError(run(f.model, c, fnd), { kind: "incoherent", artifact: "coverage", field: "bundleId" });
  });

  test("mismatched findings id (coverage coherent) is attributed to findings", () => {
    const f = makeEstateBundleFixture();
    const fnd = cloneJson(f.findings) as any;
    fnd.bundleId = OTHER_BUNDLE_ID;
    expectError(run(f.model, f.coverage, fnd), { kind: "incoherent", artifact: "findings", field: "bundleId" });
  });
});

// ── Findings structure (05 §5.5) ──────────────────────────────────────────────────────────────────

describe("findings structure", () => {
  function fErr(field: string): ExpectedError {
    return { kind: "structure", artifact: "findings", field };
  }
  const rows: Array<{ name: string; field: string; mutate: Mut }> = [
    { name: "findings not array", field: "findings", mutate: (f) => (f.findings = 1) },
    { name: "finding not object", field: "findings[0]", mutate: (f) => (f.findings[0] = 1) },
    { name: "severity invalid", field: "findings[0].severity", mutate: (f) => (f.findings[0].severity = "fatal") },
    { name: "code unknown", field: "findings[0].code", mutate: (f) => (f.findings[0].code = "made_up_code") },
    { name: "file unsafe", field: "findings[0].file", mutate: (f) => (f.findings[0].file = "/etc/shadow") },
    { name: "path non-string", field: "findings[0].path", mutate: (f) => (f.findings[0].path = 1) },
    { name: "message empty", field: "findings[0].message", mutate: (f) => (f.findings[0].message = "") },
    { name: "fix empty", field: "findings[0].fix", mutate: (f) => (f.findings[0].fix = "") },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const base = makeEstateBundleFixture();
      const fnd = cloneJson(base.findings) as any;
      row.mutate(fnd);
      expectError(run(base.model, null, fnd), fErr(row.field));
    });
  }
});

// ── loadedAt and safety guarantees (05 §§7, 8) ────────────────────────────────────────────────────

describe("loadedAt and safety", () => {
  test("non-parseable loadedAt is an unreadable clock error at loadedAt on model", () => {
    const f = makeEstateBundleFixture();
    expectError(run(f.model, f.coverage, f.findings, "not-a-date"), {
      kind: "unreadable",
      artifact: "model",
      field: "loadedAt",
    });
  });

  test("non-canonical loadedAt (missing millis) is rejected", () => {
    const f = makeEstateBundleFixture();
    expectError(run(f.model, f.coverage, f.findings, "2026-09-10T00:00:00Z"), {
      kind: "unreadable",
      artifact: "model",
      field: "loadedAt",
    });
  });

  test("the error message never echoes an unsafe field value", () => {
    const m = cloneJson(makeEstateBundleFixture().model) as any;
    m.hosts[0].provenance.file = "/etc/passwd-secret-1234";
    const e = expectError(run(m, null, null), ms("hosts[0].provenance.file"));
    expect(e.message).not.toContain("/etc/passwd-secret-1234");
    expect(e.message).not.toContain("passwd");
  });

  test("an unsafe artifact path is not echoed in the message", () => {
    const m = cloneJson(makeEstateBundleFixture().model) as any;
    m.hosts[0].artifacts = ["../../etc/leaked-9876"];
    const e = expectError(run(m, null, null), ms("hosts[0].artifacts[0]"));
    expect(e.message).not.toContain("leaked-9876");
  });

  test("parseEstateBundle returns data (never throws) for arbitrary garbage", () => {
    expect(() => parseEstateBundle({ model: " ", coverage: null, findings: null }, FIXTURE_PATHS, LOADED_AT)).not.toThrow();
    const r = run("{}", null, null);
    expect(r.ok).toBe(false);
  });
});

// ── Record insertion-order independence (05 §5.1) ─────────────────────────────────────────────────

describe("record key order independence", () => {
  test("the first invalid label key is the raw-code-point-first key regardless of insertion order", () => {
    const buildWith = (labels: Record<string, unknown>) => {
      const m = cloneJson(makeEstateBundleFixture().model) as any;
      m.hosts[0].detail.commandSignals[0].labels = labels;
      return run(m, null, null);
    };
    const field = 'hosts[0].detail.commandSignals[0].labels["apple"]';
    // both keys invalid (numbers); "apple" < "zebra" by code point.
    expectError(buildWith({ zebra: 1, apple: 2 }), ms(field));
    expectError(buildWith({ apple: 2, zebra: 1 }), ms(field));
  });

  test("channel option key order does not change the first error", () => {
    const buildWith = (options: Record<string, unknown>) => {
      const m = cloneJson(makeEstateBundleFixture().model) as any;
      m.channels[0].options = options;
      return run(m, null, null);
    };
    const field = 'channels[0].options["aaa"]';
    expectError(buildWith({ zzz: [], aaa: [] }), ms(field));
    expectError(buildWith({ aaa: [], zzz: [] }), ms(field));
  });
});
