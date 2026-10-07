/** rendered-model-v2.test.ts — the strict-superset v2 estate projection (02, 08 §§4, 6.1, 6.3).
 *
 *  Exercises `buildWebEstateModelFromIndex(model, index, safety)`: the complete top-level shape and
 *  literal version; every v1 path's field name / JSON type / omission behavior; estate metadata with
 *  its null rules and deadman presence; all five host classes with exactly one matching `detail`;
 *  command display + POSIX quoting; service deep-health / backup / alert branches; channels, routing,
 *  and standalone suppressions; ArtifactIndex-derived relationship arrays; empty-estate validity;
 *  malformed-direct-input invariants; human-readable preservation; and non-mutation.
 *
 *  The projection is the coordinated-emitter seam, so it omits `bundleId` (item 005 stamps it). */

import { describe, expect, test } from "bun:test";

import type { EstateModel, Host, Service } from "@pulse/core";

import { buildArtifactIndex } from "../src/render/artifact-index.js";
import { createWebSafetyContext } from "../src/render/web-safety.js";
import type { WebEstateModelV2, WebEstateHostV2 } from "../src/render/web-model.js";
import { buildWebEstateModelFromIndex, buildWebEstateModel } from "../src/render/web-model.js";
import {
  makeChannel,
  makeModel,
  makeRenderedModelV2Model,
  makeV2Host,
  makeV2Service,
} from "./factories.js";

type ProjectedModel = Omit<WebEstateModelV2, "bundleId">;

function project(model: EstateModel) {
  const index = buildArtifactIndex(model);
  const ctx = createWebSafetyContext();
  const result = buildWebEstateModelFromIndex(model, index, ctx);
  return { result, ctx, index };
}

/** Project and assert success, returning the value + accumulated warnings/canaries. */
function ok(model: EstateModel) {
  const { result, ctx, index } = project(model);
  if (!result.ok) {
    throw new Error(`expected a successful projection: ${JSON.stringify(result.findings)}`);
  }
  return { value: result.value, findings: result.findings, ctx, index };
}

function hostByName(value: ProjectedModel, name: string): WebEstateHostV2 {
  const host = value.hosts.find((h) => h.name === name);
  if (host === undefined) throw new Error(`no host ${name}`);
  return host;
}

function serviceByName(value: ProjectedModel, name: string) {
  const service = value.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return service;
}

// ---------------------------------------------------------------------------

describe("root construction and version", () => {
  test("returns all six collections plus literal formatVersion 2 and no bundleId", () => {
    const { value } = ok(makeRenderedModelV2Model());
    expect(value.formatVersion).toBe(2);
    expect("bundleId" in value).toBe(false);
    expect(Array.isArray(value.hosts)).toBe(true);
    expect(Array.isArray(value.services)).toBe(true);
    expect(Array.isArray(value.channels)).toBe(true);
    expect(Array.isArray(value.routingOverrides)).toBe(true);
    expect(Array.isArray(value.suppressions)).toBe(true);
    expect(value.estate).toBeDefined();
  });

  test("an empty estate yields valid empty arrays for every collection", () => {
    const { value } = ok(makeModel());
    expect(value.hosts).toEqual([]);
    expect(value.services).toEqual([]);
    expect(value.channels).toEqual([]);
    expect(value.routingOverrides).toEqual([]);
    expect(value.suppressions).toEqual([]);
    expect(value.formatVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 08 §6.3 — v1 strict-superset inventory
// ---------------------------------------------------------------------------

const V1_PATHS = [
  "formatVersion",
  "estate.name",
  "estate.domains",
  "hosts[].name",
  "hosts[].collectionClass",
  "hosts[].addresses",
  "hosts[].suppressed",
  "hosts[].drilldownId",
  "services[].name",
  "services[].host",
  "services[].managed",
  "services[].deepHealth",
  "services[].ingressUrl?",
  "services[].suppressed",
  "services[].drilldownId",
] as const;

describe("v1 strict-superset compatibility (08 §6.3)", () => {
  test("the finite inventory is covered", () => {
    expect(V1_PATHS.length).toBe(15);
  });

  test("v1 field names, JSON types, and identities are preserved", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" }), makeV2Host("excluded", { name: "old01" })],
      services: [
        makeV2Service({ name: "grafana", host: "app01", ingressUrl: "https://grafana.example.com" }),
        makeV2Service({ name: "batch", host: "app01" }),
      ],
    });
    const { value } = ok(model);

    expect(typeof value.formatVersion).toBe("number");
    expect(typeof value.estate.name).toBe("string");
    expect(Array.isArray(value.estate.domains)).toBe(true);

    const app = hostByName(value, "app01");
    expect(typeof app.name).toBe("string");
    expect(app.collectionClass).toBe("managed-linux");
    expect(Array.isArray(app.addresses)).toBe(true);
    expect(app.suppressed).toBeNull();
    expect(app.drilldownId).toBe("host:app01");
    expect(hostByName(value, "old01").suppressed).toEqual({
      class: "excluded",
      rationale: "decommissioned",
    });

    const grafana = serviceByName(value, "grafana");
    expect(typeof grafana.name).toBe("string");
    expect(grafana.host).toBe("app01");
    expect(typeof grafana.managed).toBe("boolean");
    expect(grafana.deepHealth).toBe(false);
    expect(grafana.ingressUrl).toBe("https://grafana.example.com");
    expect(grafana.suppressed).toBeNull();
    expect(grafana.drilldownId).toBe("svc:app01/grafana");
  });

  test("undeclared ingressUrl is omitted (never null/undefined), matching v1", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [makeV2Service({ name: "batch", host: "app01" })],
    });
    const { value } = ok(model);
    const batch = serviceByName(value, "batch");
    expect("ingressUrl" in batch).toBe(false);

    // v1 runtime agrees: absent key, never `null`.
    const v1 = buildWebEstateModel(model);
    expect("ingressUrl" in v1.services[0]!).toBe(false);
  });

  test("boolean deepHealth mirrors declaration presence, not the probe body", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({
          name: "a",
          host: "app01",
          deepHealth: {
            endpoint: "https://a.example.com/health",
            responseMapping: { ok: "$.ok" },
            alertExpression: "ok < 1",
          },
        }),
        makeV2Service({ name: "b", host: "app01" }),
      ],
    });
    const { value } = ok(model);
    expect(serviceByName(value, "a").deepHealth).toBe(true);
    expect(serviceByName(value, "b").deepHealth).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 02 §3 — estate metadata
// ---------------------------------------------------------------------------

describe("estate metadata", () => {
  test("copies name/timezone/schemaMajor, sorts+dedupes domains, maps absent optionals to null", () => {
    const model = makeModel({
      estate: {
        name: "home",
        domains: ["z.example.com", "a.example.com", "a.example.com"],
        timezone: "America/Chicago",
        deadmanHook: "https://deadman.example.com/ping",
        provenance: { file: "estate.yaml", path: "", line: 1, col: 1 },
      },
    });
    const { value } = ok(model);
    expect(value.estate.name).toBe("home");
    expect(value.estate.domains).toEqual(["a.example.com", "z.example.com"]);
    expect(value.estate.timezone).toBe("America/Chicago");
    expect(value.estate.schemaMajor).toBe(1);
    expect(value.estate.dnsResolver).toBeNull();
    expect(value.estate.retention).toBeNull();
  });

  test("copies declared dnsResolver and retention", () => {
    const { value } = ok(makeRenderedModelV2Model());
    expect(value.estate.dnsResolver).toBe("10.0.0.1");
    expect(value.estate.retention).toBe("30d");
  });

  test("a plain deadman hook is presence-only and collected as a canary; text never copied", () => {
    const hook = "https://deadman.example.com/ping";
    const { value, ctx } = ok(makeModel({ estate: { ...makeModel().estate, deadmanHook: hook } }));
    expect(value.estate.deadman).toEqual({ configured: true, kind: "plain" });
    expect(ctx.canaries.has(hook)).toBe(true);
    expect(JSON.stringify(value.estate)).not.toContain(hook);
  });

  test("a secret-reference deadman hook reports kind secret-ref and adds no canary", () => {
    const model = makeModel({
      estate: {
        ...makeModel().estate,
        deadmanHook: { kind: "env", raw: "${DEADMAN}", varName: "DEADMAN" },
      },
    });
    const { value, ctx } = ok(model);
    expect(value.estate.deadman).toEqual({ configured: true, kind: "secret-ref" });
    expect(ctx.canaries.has("${DEADMAN}")).toBe(false);
    expect(JSON.stringify(value.estate)).not.toContain("DEADMAN");
  });
});

// ---------------------------------------------------------------------------
// 02 §4 — host classes and details
// ---------------------------------------------------------------------------

describe("host classes", () => {
  test("all five classes are projected, hosts sorted by name, each with exactly its detail", () => {
    const { value } = ok(makeRenderedModelV2Model());
    expect(value.hosts.map((h) => h.name)).toEqual(["app01", "cam01", "hv01", "nas01", "old01"]);

    const app = hostByName(value, "app01");
    expect(app.collectionClass).toBe("managed-linux");
    if (app.collectionClass === "managed-linux") {
      expect(app.detail.cadvisor).toBe(true);
      expect(app.detail.heartbeat).toBe(true);
      expect(app.detail.deliveryForm).toBe("compose");
    }

    const hv = hostByName(value, "hv01");
    expect(hv.collectionClass).toBe("hypervisor-api");
    if (hv.collectionClass === "hypervisor-api") {
      expect(hv.detail.apiEndpoint).toBe("https://hv1.example.com:8006");
      expect(hv.detail.credential).toEqual({ kind: "env", display: "${HV_TOKEN}" });
    }

    const nas = hostByName(value, "nas01");
    expect(nas.collectionClass).toBe("nas-api");
    if (nas.collectionClass === "nas-api") {
      expect(nas.detail).toEqual({ apiEndpoint: null, credential: null });
    }

    const cam = hostByName(value, "cam01");
    expect(cam.collectionClass).toBe("probe-only");
    if (cam.collectionClass === "probe-only") {
      expect(cam.detail.probe.kind).toBe("http");
      expect(cam.detail.probe.expect).toBe("200");
    }

    const old = hostByName(value, "old01");
    expect(old.collectionClass).toBe("excluded");
    if (old.collectionClass === "excluded") {
      expect(old.detail).toEqual({});
      expect("suppressed" in old.detail).toBe(false);
    }
  });

  test("common base fields: expectedChurn default, scrapeIntervalClass null, provenance coordinates", () => {
    const { value } = ok(
      makeModel({ hosts: [makeV2Host("managed-linux", { name: "app01" })] }),
    );
    const app = hostByName(value, "app01");
    expect(app.expectedChurn).toBe(false);
    expect(app.scrapeIntervalClass).toBeNull();
    expect(app.provenance).toEqual({ file: "estate.yaml", path: "", line: 1, col: 1 });
    expect(app.addresses).toEqual(["10.0.0.10"]);
  });

  test("expectedChurn true and scrapeIntervalClass are carried when declared", () => {
    const { value } = ok(makeRenderedModelV2Model());
    const app = hostByName(value, "app01");
    expect(app.expectedChurn).toBe(true);
    expect(app.scrapeIntervalClass).toBe("fast");
  });

  test("managed-linux: exporterPorts unique ascending, both command-signal outputs sorted", () => {
    const { value } = ok(makeRenderedModelV2Model());
    const app = hostByName(value, "app01");
    if (app.collectionClass !== "managed-linux") throw new Error("expected managed-linux");
    expect(app.detail.exporterPorts).toEqual([9100, 9256, 9800]);
    // Sorted by (name, output, interval, command display): "metrics dump" < "queue depth".
    expect(app.detail.commandSignals.map((s) => s.name)).toEqual(["metrics dump", "queue depth"]);
    const dump = app.detail.commandSignals[0]!;
    const queue = app.detail.commandSignals[1]!;
    expect(dump.output).toBe("exposition");
    expect(queue.output).toBe("scalar");
    expect(queue.command).toBe("/usr/bin/depth --queue 'default queue'");
    expect(queue.credential).toBeNull();
    if (queue.output === "scalar") {
      expect(queue.metric).toBe("queue_depth");
      expect(queue.upMetric).toBe("queue_depth_up");
      expect(queue.labels).toEqual({ role: "worker" });
    }
    // exposition variant carries no scalar fields.
    expect("metric" in dump).toBe(false);
    expect("labels" in dump).toBe(false);
  });

  test("command-signal argv quoting covers safe, spaced, empty, apostrophe, and newline tokens", () => {
    const host = makeV2Host("managed-linux", {
      name: "app01",
      commandSignals: [
        {
          output: "exposition",
          name: "sig",
          command: ["/bin/echo", "plain", "with space", "", "it's", "line\nbreak"],
          interval: "10s",
        },
      ],
    });
    const { value } = ok(makeModel({ hosts: [host] }));
    const app = hostByName(value, "app01");
    if (app.collectionClass !== "managed-linux") throw new Error("expected managed-linux");
    expect(app.detail.commandSignals[0]!.command).toBe(
      "/bin/echo plain 'with space' '' 'it'\"'\"'s' 'line\nbreak'",
    );
  });

  test("labels are omitted (not undefined) when the scalar signal declares none", () => {
    const host = makeV2Host("managed-linux", {
      name: "app01",
      commandSignals: [
        {
          output: "scalar",
          name: "sig",
          command: ["/bin/true"],
          interval: "10s",
          metric: "m",
          upMetric: "m_up",
        },
      ],
    });
    const { value } = ok(makeModel({ hosts: [host] }));
    const app = hostByName(value, "app01");
    if (app.collectionClass !== "managed-linux") throw new Error("expected managed-linux");
    expect("labels" in app.detail.commandSignals[0]!).toBe(false);
  });

  test("nas-api: both-present branch projects sanitized endpoint and credential", () => {
    const host = makeV2Host("nas-api", {
      name: "nas01",
      apiEndpoint: "https://nas.example.com/api",
      credential: { kind: "env", raw: "${NAS_TOKEN}", varName: "NAS_TOKEN" },
    });
    const { value } = ok(makeModel({ hosts: [host] }));
    const nas = hostByName(value, "nas01");
    if (nas.collectionClass !== "nas-api") throw new Error("expected nas-api");
    expect(nas.detail).toEqual({
      apiEndpoint: "https://nas.example.com/api",
      credential: { kind: "env", display: "${NAS_TOKEN}" },
    });
  });

  test("probe-only: absent expect maps to null", () => {
    const host = makeV2Host("probe-only", {
      name: "cam01",
      probe: { kind: "tcp", target: "10.0.0.7:80" },
    });
    const { value } = ok(makeModel({ hosts: [host] }));
    const cam = hostByName(value, "cam01");
    if (cam.collectionClass !== "probe-only") throw new Error("expected probe-only");
    expect(cam.detail.probe).toEqual({ kind: "tcp", target: "10.0.0.7:80", expect: null });
  });
});

// ---------------------------------------------------------------------------
// 02 §5 — service projection
// ---------------------------------------------------------------------------

describe("service projection", () => {
  test("services sorted by (host, name); required arrays always present", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "b", host: "app01" }),
        makeV2Service({ name: "a", host: "app01" }),
      ],
    });
    const { value } = ok(model);
    expect(value.services.map((s) => s.name)).toEqual(["a", "b"]);
    for (const svc of value.services) {
      expect(Array.isArray(svc.gatusEndpoints)).toBe(true);
      expect(Array.isArray(svc.artifacts)).toBe(true);
      expect(Array.isArray(svc.alerts)).toBe(true);
    }
  });

  test("deep-health false emits null detail; true emits sorted metrics + copied mapping", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "plain", host: "app01" }),
        makeV2Service({
          name: "deep",
          host: "app01",
          deepHealth: {
            endpoint: "https://deep.example.com/health",
            responseMapping: { zeta: "$.z", alpha: "$.a" },
            alertExpression: "alpha < 1",
            hostLocal: true,
            credential: { kind: "env", raw: "${DH}", varName: "DH" },
          },
        }),
      ],
    });
    const { value } = ok(model);
    expect(serviceByName(value, "plain").deepHealthDetail).toBeNull();
    const deep = serviceByName(value, "deep").deepHealthDetail!;
    expect(deep.endpoint).toBe("https://deep.example.com/health");
    expect(deep.metrics).toEqual(["alpha", "zeta"]);
    expect(deep.responseMapping).toEqual({ zeta: "$.z", alpha: "$.a" });
    expect(deep.alertExpression).toBe("alpha < 1");
    expect(deep.hostLocal).toBe(true);
    expect(deep.credential).toEqual({ kind: "env", display: "${DH}" });
  });

  test("hostLocal defaults to false when the probe omits it", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({
          name: "deep",
          host: "app01",
          deepHealth: {
            endpoint: "https://deep.example.com/health",
            responseMapping: { ok: "$.ok" },
            alertExpression: "ok < 1",
          },
        }),
      ],
    });
    const { value } = ok(model);
    expect(serviceByName(value, "deep").deepHealthDetail!.hostLocal).toBe(false);
  });

  test("backup freshness: absent → null; default 15m interval; declared interval; command presence", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "none", host: "app01" }),
        makeV2Service({
          name: "default",
          host: "app01",
          backupFreshness: { signal: "sig", threshold: "26h" },
        }),
        makeV2Service({
          name: "declared",
          host: "app01",
          backupFreshness: {
            signal: "sig",
            threshold: "26h",
            interval: "1h",
            command: ["/usr/bin/age"],
          },
        }),
      ],
    });
    const { value } = ok(model);
    expect(serviceByName(value, "none").backupFreshness).toBeNull();
    expect(serviceByName(value, "default").backupFreshness).toEqual({
      signal: "sig",
      threshold: "26h",
      interval: "15m",
      hasCommand: false,
    });
    const declared = serviceByName(value, "declared").backupFreshness!;
    expect(declared.interval).toBe("1h");
    expect(declared.hasCommand).toBe(true);
    // The argv is never exposed.
    expect(JSON.stringify(declared)).not.toContain("/usr/bin/age");
  });

  test("endpoint alerts: optional keys copied only when declared, stable tuple order", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({
          name: "svc",
          host: "app01",
          alerts: [
            { type: "custom", description: "zeta" },
            { type: "custom", description: "alpha", failureThreshold: 5 },
            { type: "aaa" },
          ],
        }),
      ],
    });
    const { value } = ok(model);
    const alerts = serviceByName(value, "svc").alerts;
    // (type, description-or-empty, ...): "aaa" first, then custom/alpha, then custom/zeta.
    expect(alerts.map((a) => [a.type, a.description ?? null])).toEqual([
      ["aaa", null],
      ["custom", "alpha"],
      ["custom", "zeta"],
    ]);
    // Minimal alert carries only `type`.
    expect(Object.keys(alerts[0]!)).toEqual(["type"]);
  });

  test("every endpoint-alert optional key is preserved when declared", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({
          name: "svc",
          host: "app01",
          alerts: [
            {
              type: "custom",
              enabled: false,
              failureThreshold: 3,
              successThreshold: 2,
              description: "full",
              sendOnResolved: true,
            },
          ],
        }),
      ],
    });
    const { value } = ok(model);
    expect(serviceByName(value, "svc").alerts[0]).toEqual({
      type: "custom",
      enabled: false,
      failureThreshold: 3,
      successThreshold: 2,
      description: "full",
      sendOnResolved: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 02 §7 — channels, routing, standalone suppressions
// ---------------------------------------------------------------------------

describe("channels, routing, suppressions", () => {
  test("every channel kind projected, sorted by name, with credential/provenance", () => {
    const kinds = ["chat", "email", "push", "telegram", "webhook"] as const;
    const channels = kinds.map((kind, i) =>
      makeChannel({ name: `c${kinds.length - i}`, kind, credential: { kind: "env", raw: `\${K${i}}`, varName: `K${i}` } }),
    );
    const { value } = ok(makeModel({ channels }));
    expect(value.channels.map((c) => c.name)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(value.channels.every((c) => c.provenance.file === "estate.yaml")).toBe(true);
    expect(new Set(value.channels.map((c) => c.kind))).toEqual(new Set(kinds));
  });

  test("channel options: mixed keeps safe subset; all-sensitive and undeclared both → null", () => {
    const model = makeModel({
      channels: [
        makeChannel({ name: "mixed", options: { chat_id: "C1", apiToken: "secret-value" } }),
        makeChannel({ name: "allsensitive", options: { password: "x" } }),
        makeChannel({ name: "none" }),
      ],
    });
    const { value, findings } = ok(model);
    const byName = Object.fromEntries(value.channels.map((c) => [c.name, c]));
    expect(byName.mixed!.options).toEqual({ chat_id: "C1" });
    expect(byName.allsensitive!.options).toBeNull();
    expect(byName.none!.options).toBeNull();
    // Warnings never echo the omitted value.
    expect(findings.some((f) => f.code === "web_sensitive_channel_option_omitted")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("secret-value");
  });

  test("routing overrides: unique sorted channels, sorted records, provenance present", () => {
    const model = makeModel({
      channels: [makeChannel({ name: "ops" }), makeChannel({ name: "page" })],
      routingOverrides: [
        { severity: "warning", channels: ["page", "ops", "ops"], provenance: { file: "estate.yaml", path: "", line: 2, col: 1 } },
        { severity: "critical", channels: ["ops"], provenance: { file: "estate.yaml", path: "", line: 3, col: 1 } },
      ],
    });
    const { value } = ok(model);
    expect(value.routingOverrides.map((r) => r.severity)).toEqual(["critical", "warning"]);
    expect(value.routingOverrides[1]!.channels).toEqual(["ops", "page"]);
    expect(value.routingOverrides[0]!.provenance.line).toBe(3);
  });

  test("standalone suppression resolves host and ambiguous bare service names, sorted+deduped", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" }), makeV2Host("managed-linux", { name: "app02" })],
      services: [
        makeV2Service({ name: "shared", host: "app01" }),
        makeV2Service({ name: "shared", host: "app02" }),
      ],
      suppressions: [
        { class: "known-expected", rationale: "bare name", target: "shared", provenance: { file: "estate.yaml", path: "", line: 4, col: 1 } },
        { class: "excluded", rationale: "host retire", target: "app02", provenance: { file: "estate.yaml", path: "", line: 5, col: 1 } },
      ],
    });
    const { value } = ok(model);
    // Sorted by (target, class, rationale): "app02" < "shared".
    expect(value.suppressions.map((s) => s.target)).toEqual(["app02", "shared"]);
    expect(value.suppressions[0]!.resolves).toEqual(["host:app02"]);
    expect(value.suppressions[1]!.resolves).toEqual(["svc:app01/shared", "svc:app02/shared"]);
    expect(value.suppressions[0]!.rationale).toBe("host retire");
  });

  test("an unmatched suppression target keeps resolves empty", () => {
    const model = makeModel({
      suppressions: [
        { class: "known-expected", rationale: "future", target: "ghost", provenance: { file: "estate.yaml", path: "", line: 6, col: 1 } },
      ],
    });
    const { value } = ok(model);
    expect(value.suppressions[0]!.resolves).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 02 §8 — ArtifactIndex-derived relationships
// ---------------------------------------------------------------------------

describe("relationship attachment", () => {
  test("host/service artifacts equal the supplied index and are rendered-root-relative", () => {
    const model = makeRenderedModelV2Model();
    const { value, index } = ok(model);

    for (const host of value.hosts) {
      expect(host.artifacts).toEqual(index.hosts.get(host.name)!.artifacts);
      expect(host.scrapeTargets).toEqual(index.hosts.get(host.name)!.scrapeTargets);
      for (const path of host.artifacts) {
        expect(path.startsWith("/")).toBe(false);
        expect(path.includes("..")).toBe(false);
      }
    }
    for (const svc of value.services) {
      const id = `${svc.host}/${svc.name}`;
      expect(svc.artifacts).toEqual(index.services.get(id)!.artifacts);
      expect(svc.gatusEndpoints).toEqual(index.services.get(id)!.gatusEndpoints);
    }
  });

  test("an entity with no edges still emits present empty arrays", () => {
    const { value } = ok(makeModel({ hosts: [makeV2Host("excluded", { name: "old01" })] }));
    const old = hostByName(value, "old01");
    expect(old.artifacts).toEqual([]);
    expect(old.scrapeTargets).toEqual([]);
  });

  test("relationship arrays are fresh copies, not aliases of the index", () => {
    const model = makeModel({ hosts: [makeV2Host("managed-linux", { name: "app01" })] });
    const { value, index } = ok(model);
    const app = hostByName(value, "app01");
    expect(app.artifacts).not.toBe(index.hosts.get("app01")!.artifacts);
    expect(app.scrapeTargets).not.toBe(index.hosts.get("app01")!.scrapeTargets);
  });
});

// ---------------------------------------------------------------------------
// 02 §10 — fatal invariants and provenance
// ---------------------------------------------------------------------------

describe("fatal invariants return no partial model", () => {
  test("unsafe (absolute) provenance is fatal with WEB_UNSAFE_PROVENANCE and no value", () => {
    const host = makeV2Host("managed-linux", {
      name: "app01",
      provenance: { file: "/etc/absolute.yaml", path: "hosts[0]", line: 1, col: 1 },
    });
    const { result } = project(makeModel({ hosts: [host] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.findings.some((f) => f.code === "web_unsafe_provenance")).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain("/etc/absolute.yaml");
    expect("value" in result).toBe(false);
  });

  test("a half-present NAS API pair is a fatal invariant", () => {
    const host = makeV2Host("nas-api", { name: "nas01", apiEndpoint: "https://nas.example.com/api" });
    const { result } = project(makeModel({ hosts: [host] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.findings.some((f) => f.code === "incomplete_nas_api")).toBe(true);
  });

  test("a non-positive alert threshold is a fatal invariant", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "svc", host: "app01", alerts: [{ type: "custom", failureThreshold: 0 }] }),
      ],
    });
    const { result } = project(model);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.findings.some((f) => f.code === "wrong_type")).toBe(true);
  });

  test("a fractional alert threshold is a fatal invariant", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "svc", host: "app01", alerts: [{ type: "custom", successThreshold: 1.5 }] }),
      ],
    });
    const { result } = project(model);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL sanitation, human readability, determinism, non-mutation
// ---------------------------------------------------------------------------

describe("safety, determinism, and purity", () => {
  test("ingress URL userinfo is removed with a non-echoing warning; safe context retained", () => {
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "app01" })],
      services: [
        makeV2Service({ name: "svc", host: "app01", ingressUrl: "https://alice9:pw7secret@grafana.example.com/path" }),
      ],
    });
    const { value, findings } = ok(model);
    const url = serviceByName(value, "svc").ingressUrl!;
    expect(url).not.toContain("alice9");
    expect(url).not.toContain("pw7secret");
    expect(url).toContain("grafana.example.com");
    expect(findings.some((f) => f.code === "web_url_userinfo_removed")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("pw7secret");
  });

  test("human-readable names, rationale, and descriptions survive projection", () => {
    const { value } = ok(makeRenderedModelV2Model());
    expect(value.suppressions[0]!.rationale).toBe("maintenance window");
    const backup = serviceByName(value, "backup");
    expect(backup.suppressed).toEqual({ class: "expected-churn", rationale: "nightly job flaps" });
    const grafana = serviceByName(value, "grafana");
    expect(grafana.alerts.some((a) => a.description === "grafana degraded")).toBe(true);
  });

  test("permuted set-like source order produces equal projected values", () => {
    const a = makeRenderedModelV2Model();
    const b = makeRenderedModelV2Model({
      estate: { ...a.estate, domains: ["a.example.com", "z.example.com"] },
      hosts: [...a.hosts].reverse(),
      services: [...a.services].reverse(),
    });
    expect(ok(a).value).toEqual(ok(b).value);
  });

  test("projection does not mutate the model or the index", () => {
    const model = makeRenderedModelV2Model();
    const before = JSON.parse(JSON.stringify(model));
    project(model);
    expect(JSON.parse(JSON.stringify(model))).toEqual(before);
  });
});
