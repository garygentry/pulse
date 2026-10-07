/** web-model.test.ts — the `web-estate-model` projection + shared suppression index (02 §5, REQ-WEM-01).
 *
 *  NOTE (rendered-model-v2, item 004): these assertions are retained as explicit v1 COMPATIBILITY
 *  evidence — they exercise the still-live v1 `buildWebEstateModel`/`emitWebEstateModelFile` runtime,
 *  which stays authoritative until the public entry point moves to `web-artifacts.ts` (item 005) and
 *  emission flips (item 010). The strict-superset v2 projection is covered in `rendered-model-v2.test.ts`.
 *
 *  Asserts: `formatVersion === RENDER_FORMAT_VERSION`; hosts sorted by name and services by host
 *  then name; the `host:<name>`/`svc:<host>/<name>` drilldownId conventions; an excluded host and a
 *  standalone-suppressed service project `suppressed !== null` (with carried class/rationale) while a
 *  monitored entity projects `null`; the serialized JSON leaks no provenance/credential/timezone/
 *  deadmanHook/routing field; the `ingressUrl` key is omitted when absent (never `undefined`). */

import { expect, test, describe } from "bun:test";

import type { EstateModel, Host, Service, Provenance, Suppression } from "@pulse/core";

import { RENDER_FORMAT_VERSION } from "../src/manifest.js";
import {
  buildWebEstateModel,
  emitWebEstateModelFile,
  buildSuppressionIndex,
  toSuppressionInfo,
} from "../src/render/web-model.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

function makeModel(over: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "home-estate",
      domains: ["example.com"],
      timezone: "America/Chicago",
      deadmanHook: { kind: "env", raw: "${DEADMAN}", varName: "DEADMAN" },
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...over,
  };
}

const managed = (over: Partial<Host> = {}): Host =>
  ({
    name: "web01",
    collectionClass: "managed-linux",
    cadvisor: false,
    heartbeat: true,
    deliveryForm: "compose",
    addresses: ["10.0.0.4"],
    exporterPorts: [9100],
    commandSignals: [],
    provenance: PROV,
    ...over,
  } as Host);

const excluded = (name: string, rationale = "decommissioned"): Host => ({
  name,
  collectionClass: "excluded",
  addresses: ["10.0.0.99"],
  suppressed: { class: "excluded", rationale },
  provenance: PROV,
});

const service = (over: Partial<Service> = {}): Service => ({
  name: "grafana",
  host: "web01",
  kind: "http",
  managed: true,
  provenance: PROV,
  ...over,
});

describe("buildWebEstateModel — stamp + ordering", () => {
  test("stamps formatVersion === RENDER_FORMAT_VERSION and copies estate name/domains", () => {
    const web = buildWebEstateModel(makeModel({ hosts: [managed()] }));
    expect(web.formatVersion).toBe(RENDER_FORMAT_VERSION);
    expect(web.estate).toEqual({ name: "home-estate", domains: ["example.com"] });
  });

  test("hosts sorted by name (raw code-point)", () => {
    const web = buildWebEstateModel(
      makeModel({ hosts: [managed({ name: "web02" }), managed({ name: "web01" })] }),
    );
    expect(web.hosts.map((h) => h.name)).toEqual(["web01", "web02"]);
  });

  test("services sorted by host then name", () => {
    const web = buildWebEstateModel(
      makeModel({
        services: [
          service({ name: "b", host: "web02" }),
          service({ name: "a", host: "web02" }),
          service({ name: "z", host: "web01" }),
        ],
      }),
    );
    expect(web.services.map((s) => `${s.host}/${s.name}`)).toEqual([
      "web01/z",
      "web02/a",
      "web02/b",
    ]);
  });

  test("drilldownId conventions: host:<name> and svc:<host>/<name>", () => {
    const web = buildWebEstateModel(
      makeModel({ hosts: [managed()], services: [service()] }),
    );
    expect(web.hosts[0].drilldownId).toBe("host:web01");
    expect(web.services[0].drilldownId).toBe("svc:web01/grafana");
  });

  test("addresses are copied (no aliasing back to the source host)", () => {
    const host = managed();
    const web = buildWebEstateModel(makeModel({ hosts: [host] }));
    expect(web.hosts[0].addresses).toEqual(["10.0.0.4"]);
    expect(web.hosts[0].addresses).not.toBe(host.addresses);
  });
});

describe("buildWebEstateModel — service field projection", () => {
  test("deepHealth is a boolean derived from presence, not the probe body", () => {
    const web = buildWebEstateModel(
      makeModel({
        services: [
          service({
            name: "a",
            deepHealth: {
              endpoint: "https://a/health",
              responseMapping: { "$.ok": "ok" },
              alertExpression: "ok < 1",
            },
          }),
          service({ name: "b" }),
        ],
      }),
    );
    const byName = Object.fromEntries(web.services.map((s) => [s.name, s.deepHealth]));
    expect(byName.a).toBe(true);
    expect(byName.b).toBe(false);
  });

  test("ingressUrl copied when present; key omitted (never undefined) when absent", () => {
    const web = buildWebEstateModel(
      makeModel({
        services: [
          service({ name: "with", ingressUrl: "https://grafana.example.com" }),
          service({ name: "without" }),
        ],
      }),
    );
    const withUrl = web.services.find((s) => s.name === "with")!;
    const without = web.services.find((s) => s.name === "without")!;
    expect(withUrl.ingressUrl).toBe("https://grafana.example.com");
    expect("ingressUrl" in without).toBe(false);
    // Serialized form must not carry an `"ingressUrl": null`/undefined key for the absent case.
    const json = emitWebEstateModelFile(
      makeModel({ services: [service({ name: "without" })] }),
    ).files[0].contents;
    expect(json).not.toContain("ingressUrl");
  });
});

describe("suppression mapping", () => {
  test("toSuppressionInfo returns null for undefined, else carries class/rationale", () => {
    expect(toSuppressionInfo(undefined)).toBeNull();
    expect(toSuppressionInfo({ class: "excluded", rationale: "gone" })).toEqual({
      class: "excluded",
      rationale: "gone",
    });
  });

  test("an excluded host projects suppressed !== null with carried class/rationale", () => {
    const web = buildWebEstateModel(makeModel({ hosts: [excluded("old01", "retired")] }));
    expect(web.hosts[0].suppressed).toEqual({ class: "excluded", rationale: "retired" });
  });

  test("a monitored host projects suppressed === null", () => {
    const web = buildWebEstateModel(makeModel({ hosts: [managed()] }));
    expect(web.hosts[0].suppressed).toBeNull();
  });

  test("a standalone-suppressed service projects suppressed !== null; a monitored one is null", () => {
    const suppression: Suppression = {
      class: "known-expected",
      rationale: "batch job flaps",
      target: "web01/batch",
      provenance: PROV,
    };
    const web = buildWebEstateModel(
      makeModel({
        services: [service({ name: "batch" }), service({ name: "live" })],
        suppressions: [suppression],
      }),
    );
    const batch = web.services.find((s) => s.name === "batch")!;
    const live = web.services.find((s) => s.name === "live")!;
    expect(batch.suppressed).toEqual({ class: "known-expected", rationale: "batch job flaps" });
    expect(live.suppressed).toBeNull();
  });

  test("an in-target service `suppressed` mark projects suppressed !== null", () => {
    const web = buildWebEstateModel(
      makeModel({
        services: [service({ name: "batch", suppressed: { class: "expected-churn", rationale: "churny" } })],
      }),
    );
    expect(web.services[0].suppressed).toEqual({ class: "expected-churn", rationale: "churny" });
  });
});

describe("buildSuppressionIndex", () => {
  test("keys excluded hosts, suppressed services, and standalone targets by identity", () => {
    const index = buildSuppressionIndex(
      makeModel({
        hosts: [excluded("old01", "gone"), managed()],
        services: [
          service({ name: "svcmark", suppressed: { class: "expected-churn", rationale: "churn" } }),
          service({ name: "standalone" }),
          service({ name: "monitored" }),
        ],
        suppressions: [
          { class: "known-expected", rationale: "std", target: "web01/standalone", provenance: PROV },
        ],
      }),
    );
    expect(index.get("host:old01")).toEqual({ class: "excluded", rationale: "gone" });
    expect(index.get("host:web01")).toBeUndefined();
    expect(index.get("svc:web01/svcmark")).toEqual({ class: "expected-churn", rationale: "churn" });
    expect(index.get("svc:web01/standalone")).toEqual({ class: "known-expected", rationale: "std" });
    expect(index.get("svc:web01/monitored")).toBeUndefined();
  });

  test("a standalone target matching a host name keys host:<name>", () => {
    const index = buildSuppressionIndex(
      makeModel({
        hosts: [managed({ name: "web01" })],
        suppressions: [
          { class: "known-expected", rationale: "planned", target: "web01", provenance: PROV },
        ],
      }),
    );
    expect(index.get("host:web01")).toEqual({ class: "known-expected", rationale: "planned" });
  });

  test("an in-target service mark wins over a conflicting standalone entry", () => {
    const index = buildSuppressionIndex(
      makeModel({
        services: [
          service({ name: "batch", suppressed: { class: "expected-churn", rationale: "in-target" } }),
        ],
        suppressions: [
          { class: "known-expected", rationale: "standalone", target: "web01/batch", provenance: PROV },
        ],
      }),
    );
    expect(index.get("svc:web01/batch")).toEqual({ class: "expected-churn", rationale: "in-target" });
  });
});

describe("emitWebEstateModelFile — leak-free serialization", () => {
  test("emits exactly one web-estate-model.json with no findings, stamped formatVersion", () => {
    const result = emitWebEstateModelFile(makeModel({ hosts: [managed()] }));
    expect(result.findings).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("web-estate-model.json");
    const parsed = JSON.parse(result.files[0].contents);
    expect(parsed.formatVersion).toBe(RENDER_FORMAT_VERSION);
  });

  test("the serialized JSON leaks no provenance/credential/timezone/deadmanHook/routing field", () => {
    // A rich estate exercising every leak surface: a credentialed host, a routing override,
    // a deadman hook secret ref, and a timezone.
    const model = makeModel({
      hosts: [
        managed(),
        {
          name: "pve1",
          collectionClass: "hypervisor-api",
          addresses: ["10.0.0.5"],
          apiEndpoint: "https://pve1:8006",
          credential: { kind: "env", raw: "${PVE_TOKEN}", varName: "PVE_TOKEN" },
          provenance: PROV,
        } as Host,
      ],
      services: [service({ ingressUrl: "https://grafana.example.com" })],
      channels: [
        {
          name: "ops",
          kind: "chat",
          credential: { kind: "env", raw: "${SLACK}", varName: "SLACK" },
          provenance: PROV,
        },
      ],
      routingOverrides: [{ severity: "critical", channels: ["ops"], provenance: PROV }],
    });
    const json = emitWebEstateModelFile(model).files[0].contents;

    for (const forbidden of [
      "provenance",
      "credential",
      "apiEndpoint",
      "timezone",
      "deadmanHook",
      "deadman_hook",
      "routingOverrides",
      "channels",
      "America/Chicago",
      "PVE_TOKEN",
      "${SLACK}",
      "estate.yaml",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel({ hosts: [managed(), managed({ name: "web02" })] });
    expect(emitWebEstateModelFile(model).files[0].contents).toBe(
      emitWebEstateModelFile(model).files[0].contents,
    );
  });
});
