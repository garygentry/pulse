// packages/web-data/tests/history/endpoint-key.test.ts — evidence for amendment 12 §2
// (REQ-ECR-02): the pinned Gatus 5.13.1 composite key helper, and HistoryService resolving a
// pulse endpoint name (service endpoint or `dns:<domain>`) to that key for the source call
// while keeping the payload/target keyed by the pulse name. Package test files are not
// typechecked, so mocks implement only what the service calls.

import { describe, expect, test } from "bun:test";

import { gatusEndpointKey } from "../../src/sources/gatus.js";
import { createHistoryService } from "../../src/history/service.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

describe("gatusEndpointKey (Gatus 5.13.1 config/endpoint/key.go)", () => {
  test("matches the pairs observed on the live stack", () => {
    expect(gatusEndpointKey("web", "web/app")).toBe("web_web-app");
    expect(gatusEndpointKey("casa", "casa/komodo-periphery")).toBe("casa_casa-komodo-periphery");
    expect(gatusEndpointKey("", "dns:status.example.com")).toBe("_dns:status-example-com");
  });

  test("lowercases, trims, and replaces every sanitized character with '-'", () => {
    expect(gatusEndpointKey("My_Group", "a_b")).toBe("my-group_a-b");
    expect(gatusEndpointKey("  Host ", " Web Portal ")).toBe("host_web-portal");
    expect(gatusEndpointKey("WEB", "WEB/App")).toBe("web_web-app");
    expect(gatusEndpointKey("g", "a,b#c+d&e.f/g h_i")).toBe("g_a-b-c-d-e-f-g-h-i");
    // Characters Gatus does not replace (':' , '-') survive verbatim.
    expect(gatusEndpointKey("g", "host:edge-01")).toBe("g_host:edge-01");
  });
});

// --- HistoryService resolution ---------------------------------------------

function prov() {
  return { file: "estate.yml", path: "x", line: 1, col: 1 };
}

function svcDecl(host: string, name: string, endpoints: string[]) {
  return {
    name,
    host,
    managed: true,
    deepHealth: false,
    suppressed: null,
    drilldownId: `svc:${host}/${name}`,
    kind: "web",
    provenance: prov(),
    gatusEndpoints: endpoints,
    artifacts: [],
    deepHealthDetail: null,
    backupFreshness: null,
    alerts: [],
  };
}

function model(): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId: "b",
    estate: {
      name: "home",
      domains: ["status.example.com", "example.com"],
      timezone: "UTC",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts: [],
    services: [
      svcDecl("web", "app", ["web/app"]),
      // Two services declaring the same name → ambiguous.
      svcDecl("a", "x", ["shared/dup"]),
      svcDecl("b", "y", ["shared/dup"]),
    ],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  } as unknown as WebEstateModelV2;
}

const RESULTS = [
  { timestamp: "2026-09-25T00:00:00Z", success: true, durationMs: 12, conditionResults: [] },
  { timestamp: "2026-09-25T00:01:00Z", success: false, durationMs: 40, conditionResults: [] },
];

function harness() {
  const keys: string[] = [];
  const gatus = {
    endpointStatuses: async () => ({ ok: true, data: [] }),
    endpointHistory: async (key: string) => {
      keys.push(key);
      return { ok: true, data: { key, results: RESULTS } };
    },
  };
  const vm = { queryRange: async () => ({ ok: true, data: { series: [] } }) };
  const svc = createHistoryService({ vm: vm as never, gatus: gatus as never, model: () => model(), now: () => Date.parse("2026-09-25T00:05:00Z") });
  return { svc, keys };
}

describe("HistoryService.endpointHistory addresses Gatus by composite key (12 §2)", () => {
  test("a service endpoint calls the source with <host>_<sanitized name>; payload keeps the pulse name", async () => {
    const { svc, keys } = harness();
    const r = await svc.endpointHistory({ endpoint: "web/app", range: "24h" } as never);
    expect(keys).toEqual(["web_web-app"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.endpoint).toBe("web/app");
      expect(r.data.target).toEqual({ kind: "endpoint", id: "web/app" });
      expect(r.data.results.length).toBe(2);
      expect(JSON.stringify(r.data)).not.toContain("web_web-app");
    }
  });

  test("a dns:<domain> endpoint resolves with an empty group", async () => {
    const { svc, keys } = harness();
    const r = await svc.endpointHistory({ endpoint: "dns:status.example.com", range: "24h" } as never);
    expect(keys).toEqual(["_dns:status-example-com"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.endpoint).toBe("dns:status.example.com");
      expect(r.data.target).toEqual({ kind: "endpoint", id: "dns:status.example.com" });
    }
  });

  test("unknown, ambiguous, and undeclared-domain names return TARGET_NOT_FOUND with no source call", async () => {
    const { svc, keys } = harness();
    for (const endpoint of ["no/such", "shared/dup", "dns:not-declared.example", "status.example.com", "web_web-app"]) {
      const r = await svc.endpointHistory({ endpoint, range: "1h" } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("TARGET_NOT_FOUND");
    }
    expect(keys).toEqual([]);
    expect(svc.stats().waiters).toBe(0);
  });

  test("the cache is keyed by the pulse name: a repeat request is a hit with no second source call", async () => {
    const { svc, keys } = harness();
    await svc.endpointHistory({ endpoint: "web/app", range: "1h" } as never);
    const again = await svc.endpointHistory({ endpoint: "web/app", range: "1h" } as never);
    expect(again.ok && again.delivery).toBe("hit");
    expect(keys).toEqual(["web_web-app"]);
  });
});
