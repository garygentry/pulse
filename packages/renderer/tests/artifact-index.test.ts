/** artifact-index.test.ts — the shared estate→artifact index (02 §3.4, §8; REQ-RND-01,
 *  REQ-COV-03, REQ-MODEL-12).
 *
 *  Asserts: buildArtifactIndex maps each host collection class and each service condition to
 *  exactly the 02 §3.4 artifact-path table; every declared host/service receives an entry (empty
 *  arrays where it maps to nothing); host `scrapeTargets` reproduce scrape.ts's (job, instance)
 *  identities and service `gatusEndpoints` reproduce gatus.ts's endpoint names; set-like values are
 *  deduped and deterministically sorted; the build performs no filesystem access. */

import * as fs from "node:fs";

import { expect, test, describe, spyOn } from "bun:test";

import type { EstateModel, Host, Service, Provenance } from "@pulse/core";

import { buildArtifactIndex } from "../src/render/artifact-index.js";
import type { WebScrapeTarget } from "../src/render/web-model.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

function makeModel(hosts: Host[], services: Service[]): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "test-estate",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "https://deadman.example.com/ping",
      provenance: PROV,
    },
    hosts,
    services,
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
}

function makeService(overrides: Partial<Service> & Pick<Service, "name" | "host">): Service {
  return {
    kind: "web",
    managed: true,
    provenance: PROV,
    ...overrides,
  };
}

describe("buildArtifactIndex — host artifact paths (02 §3.4)", () => {
  const cases: Array<[string, Host, string[]]> = [
    [
      "managed-linux",
      { name: "web01", collectionClass: "managed-linux", addresses: ["10.0.0.4"], exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [], provenance: PROV },
      [
        "agent/web01.yaml",
        "scrape/file_sd/managed-linux-heartbeat.json",
        "scrape/file_sd/managed-linux.json",
      ],
    ],
    [
      "managed-linux (heartbeat opt-out, issue #30)",
      { name: "dns01", collectionClass: "managed-linux", addresses: ["10.0.0.8"], exporterPorts: [9100], cadvisor: false, heartbeat: false, deliveryForm: "systemd", commandSignals: [], provenance: PROV },
      [
        // No managed-linux-heartbeat.json — node-exporter-only host.
        "agent/dns01.yaml",
        "scrape/file_sd/managed-linux.json",
      ],
    ],
    [
      "hypervisor-api",
      { name: "pve1", collectionClass: "hypervisor-api", addresses: ["10.0.0.5"], apiEndpoint: "https://pve1:8006", credential: { kind: "env", raw: "${PVE}", varName: "PVE" }, provenance: PROV },
      ["scrape/file_sd/hypervisor-api.json"],
    ],
    [
      "nas-api",
      { name: "nas1", collectionClass: "nas-api", addresses: ["10.0.0.6"], apiEndpoint: "https://nas1", credential: { kind: "env", raw: "${NAS}", varName: "NAS" }, provenance: PROV },
      ["scrape/file_sd/nas-api.json"],
    ],
    [
      "probe-only",
      { name: "edge01", collectionClass: "probe-only", addresses: ["10.0.0.9"], probe: { kind: "icmp", target: "10.0.0.9" }, provenance: PROV },
      ["gatus/config.yaml", "prober/config.yaml", "scrape/file_sd/probe-only.json"],
    ],
    [
      "excluded",
      { name: "old01", collectionClass: "excluded", addresses: ["10.0.0.99"], suppressed: { class: "excluded", rationale: "decommissioned" }, provenance: PROV },
      [],
    ],
  ];

  for (const [label, host, expected] of cases) {
    test(`${label} host maps to exactly ${JSON.stringify(expected)}`, () => {
      const index = buildArtifactIndex(makeModel([host], []));
      expect(index.hosts.get(host.name)?.artifacts).toEqual(expected);
    });
  }

  test("managed-linux includes every applicable split scrape artifact", () => {
    const host: Host = {
      name: "web01",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.4"],
      exporterPorts: [9100, 9256],
      cadvisor: true,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: [
        { output: "exposition", name: "gpu", command: ["/bin/gpu"], interval: "30s" },
      ],
      provenance: PROV,
    };
    const service = makeService({
      name: "local",
      host: "web01",
      deepHealth: {
        endpoint: "http://127.0.0.1/health",
        responseMapping: { ok: "$.ok" },
        alertExpression: "ok == 0",
        hostLocal: true,
      },
    });
    const index = buildArtifactIndex(makeModel([host], [service]));
    expect(index.hosts.get("web01")?.artifacts).toEqual([
      "agent/web01.yaml",
      "agent/web01/prober/config.yaml",
      "command-exporter/web01.yaml",
      "scrape/file_sd/cadvisor.json",
      "scrape/file_sd/managed-linux-command-exporter.json",
      "scrape/file_sd/managed-linux-heartbeat.json",
      "scrape/file_sd/managed-linux-prober.json",
      "scrape/file_sd/managed-linux.json",
      "scrape/file_sd/process-exporter.json",
    ]);
  });

  test("a heartbeat-opted-out host that still declares :9110 gets managed-linux-exporters, not a heartbeat artifact (issue #30)", () => {
    // Guards the artifact-index copy of isDedicatedManagedPort against drift from scrape.ts: with
    // heartbeat off, :9110 is no longer dedicated, so it must route to the custom exporters artifact
    // while the heartbeat artifact is dropped.
    const host: Host = {
      name: "dns01",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.8"],
      exporterPorts: [9100, 9110],
      cadvisor: false,
      heartbeat: false,
      deliveryForm: "systemd",
      commandSignals: [],
      provenance: PROV,
    };
    const index = buildArtifactIndex(makeModel([host], []));
    const paths = index.hosts.get("dns01")!.artifacts;
    expect(paths).toContain("scrape/file_sd/managed-linux-exporters.json");
    expect(paths).not.toContain("scrape/file_sd/managed-linux-heartbeat.json");
  });

  test("ungated reserved-looking ports remain custom in the artifact index", () => {
    const host: Host = {
      name: "web01",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.4"],
      exporterPorts: [8080, 9100, 9110, 9120, 9130, 9257],
      cadvisor: false,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: [],
      provenance: PROV,
    };
    const index = buildArtifactIndex(makeModel([host], []));
    expect(index.hosts.get("web01")?.artifacts).toEqual([
      "agent/web01.yaml",
      "scrape/file_sd/managed-linux-exporters.json",
      "scrape/file_sd/managed-linux-heartbeat.json",
      "scrape/file_sd/managed-linux.json",
    ]);
  });

  test("probe-only host's three artifacts are sorted via compareString", () => {
    const host: Host = { name: "edge01", collectionClass: "probe-only", addresses: ["10.0.0.9"], probe: { kind: "icmp", target: "10.0.0.9" }, provenance: PROV };
    const index = buildArtifactIndex(makeModel([host], []));
    const paths = index.hosts.get("edge01")?.artifacts;
    expect(paths).toEqual([...(paths ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("buildArtifactIndex — host scrape identities (02 §8.2)", () => {
  const cases: Array<[string, Host, WebScrapeTarget[]]> = [
    [
      "managed-linux node-exporter + heartbeat",
      { name: "web01", collectionClass: "managed-linux", addresses: ["10.0.0.4"], exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [], provenance: PROV },
      [
        { job: "managed-linux", instance: "10.0.0.4:9100" },
        { job: "managed-linux-heartbeat", instance: "10.0.0.4:9110" },
      ],
    ],
    [
      "managed-linux node-exporter only (heartbeat off)",
      { name: "dns01", collectionClass: "managed-linux", addresses: ["10.0.0.8"], exporterPorts: [9100], cadvisor: false, heartbeat: false, deliveryForm: "systemd", commandSignals: [], provenance: PROV },
      [{ job: "managed-linux", instance: "10.0.0.8:9100" }],
    ],
    [
      "hypervisor-api targets the raw apiEndpoint",
      { name: "pve1", collectionClass: "hypervisor-api", addresses: ["10.0.0.5"], apiEndpoint: "https://pve1:8006", credential: { kind: "env", raw: "${PVE}", varName: "PVE" }, provenance: PROV },
      [{ job: "hypervisor-api", instance: "https://pve1:8006" }],
    ],
    [
      "nas-api is a direct node_exporter scrape on the first address",
      { name: "nas1", collectionClass: "nas-api", addresses: ["10.0.0.6"], apiEndpoint: "https://nas1", credential: { kind: "env", raw: "${NAS}", varName: "NAS" }, provenance: PROV },
      [{ job: "nas-api", instance: "10.0.0.6:9100" }],
    ],
    [
      "probe-only targets the probe target",
      { name: "edge01", collectionClass: "probe-only", addresses: ["10.0.0.9"], probe: { kind: "icmp", target: "10.0.0.9" }, provenance: PROV },
      [{ job: "probe-only", instance: "10.0.0.9" }],
    ],
    [
      "excluded has no scrape target",
      { name: "old01", collectionClass: "excluded", addresses: ["10.0.0.99"], suppressed: { class: "excluded", rationale: "decommissioned" }, provenance: PROV },
      [],
    ],
  ];

  for (const [label, host, expected] of cases) {
    test(label, () => {
      const index = buildArtifactIndex(makeModel([host], []));
      expect(index.hosts.get(host.name)?.scrapeTargets).toEqual(expected);
    });
  }

  test("a fully-decked managed host emits one target per exporter identity, sorted by (job, instance)", () => {
    const host: Host = {
      name: "web01",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.4"],
      exporterPorts: [9100, 9256, 9300],
      cadvisor: true,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: [
        { output: "exposition", name: "gpu", command: ["/bin/gpu"], interval: "30s" },
      ],
      provenance: PROV,
    };
    const service = makeService({
      name: "local",
      host: "web01",
      deepHealth: {
        endpoint: "http://127.0.0.1/health",
        responseMapping: { ok: "$.ok" },
        alertExpression: "ok == 0",
        hostLocal: true,
      },
    });
    const index = buildArtifactIndex(makeModel([host], [service]));
    expect(index.hosts.get("web01")?.scrapeTargets).toEqual([
      { job: "cadvisor", instance: "10.0.0.4:8080" },
      { job: "managed-linux", instance: "10.0.0.4:9100" },
      { job: "managed-linux-command-exporter", instance: "10.0.0.4:9130" },
      { job: "managed-linux-exporters", instance: "10.0.0.4:9300" },
      { job: "managed-linux-heartbeat", instance: "10.0.0.4:9110" },
      { job: "managed-linux-prober", instance: "10.0.0.4:9120" },
      { job: "process-exporter", instance: "10.0.0.4:9256" },
    ]);
  });

  test("every job and instance is non-empty", () => {
    const host: Host = { name: "pve1", collectionClass: "hypervisor-api", addresses: ["10.0.0.5"], apiEndpoint: "https://pve1:8006", credential: { kind: "env", raw: "${PVE}", varName: "PVE" }, provenance: PROV };
    const targets = buildArtifactIndex(makeModel([host], [])).hosts.get("pve1")!.scrapeTargets;
    for (const t of targets) {
      expect(t.job.length).toBeGreaterThan(0);
      expect(t.instance.length).toBeGreaterThan(0);
    }
  });

  test("a managed host with no address is a fatal invariant, not an empty instance", () => {
    const host = { name: "broken", collectionClass: "managed-linux", addresses: [], exporterPorts: [9100], cadvisor: false, heartbeat: false, deliveryForm: "compose", commandSignals: [], provenance: PROV } as unknown as Host;
    expect(() => buildArtifactIndex(makeModel([host], []))).toThrow();
  });
});

describe("buildArtifactIndex — service artifact paths (02 §3.4)", () => {
  test("ingressUrl present -> [gatus/config.yaml]", () => {
    const svc = makeService({ name: "grafana", host: "web01", ingressUrl: "https://grafana.example.com" });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("web01/grafana")?.artifacts).toEqual(["gatus/config.yaml"]);
  });

  test("deepHealth declared -> [prober/config.yaml]", () => {
    const svc = makeService({
      name: "frigate",
      host: "nvr01",
      deepHealth: { endpoint: "https://nvr01/health", responseMapping: { cameras: "$.cameras" }, alertExpression: "cameras < 6" },
    });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("nvr01/frigate")?.artifacts).toEqual(["prober/config.yaml"]);
  });

  test("backupFreshness declared -> [prober/config.yaml]", () => {
    const svc = makeService({ name: "backups", host: "nas1", backupFreshness: { signal: "last_backup_ts", threshold: "24h" } });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("nas1/backups")?.artifacts).toEqual(["prober/config.yaml"]);
  });

  test("bare service (none of the conditions) -> none", () => {
    const svc = makeService({ name: "plain", host: "web01" });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("web01/plain")?.artifacts).toEqual([]);
  });

  test("deepHealth + backupFreshness dedupe to a single prober/config.yaml", () => {
    const svc = makeService({
      name: "frigate",
      host: "nvr01",
      deepHealth: { endpoint: "https://nvr01/health", responseMapping: { cameras: "$.cameras" }, alertExpression: "cameras < 6" },
      backupFreshness: { signal: "last_backup_ts", threshold: "24h" },
    });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("nvr01/frigate")?.artifacts).toEqual(["prober/config.yaml"]);
  });

  test("ingressUrl + deepHealth -> both files, sorted via compareString", () => {
    const svc = makeService({
      name: "grafana",
      host: "web01",
      ingressUrl: "https://grafana.example.com",
      deepHealth: { endpoint: "https://web01/health", responseMapping: { up: "$.up" }, alertExpression: "up == 1" },
    });
    const index = buildArtifactIndex(makeModel([], [svc]));
    // "gatus/config.yaml" < "prober/config.yaml" by code point.
    expect(index.services.get("web01/grafana")?.artifacts).toEqual(["gatus/config.yaml", "prober/config.yaml"]);
  });

  test("service key is '<host>/<service>'", () => {
    const svc = makeService({ name: "grafana", host: "web01", ingressUrl: "https://g" });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect([...index.services.keys()]).toContain("web01/grafana");
  });
});

describe("buildArtifactIndex — service Gatus endpoints (02 §8.2)", () => {
  test("a non-suppressed service with ingressUrl has endpoint '<host>/<service>'", () => {
    const svc = makeService({ name: "grafana", host: "web01", ingressUrl: "https://grafana.example.com" });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("web01/grafana")?.gatusEndpoints).toEqual(["web01/grafana"]);
  });

  test("a suppressed service with ingressUrl has no Gatus endpoint (matches gatus.ts), yet retains its gatus artifact", () => {
    const svc = makeService({
      name: "grafana",
      host: "web01",
      ingressUrl: "https://grafana.example.com",
      suppressed: { class: "known-expected", rationale: "muted" },
    });
    const rel = buildArtifactIndex(makeModel([], [svc])).services.get("web01/grafana")!;
    expect(rel.gatusEndpoints).toEqual([]);
    // The artifact relationship is NOT erased by suppression (02 §8.3).
    expect(rel.artifacts).toEqual(["gatus/config.yaml"]);
  });

  test("a service without ingressUrl has no Gatus endpoint (deep-health/backup are not endpoints)", () => {
    const svc = makeService({
      name: "frigate",
      host: "nvr01",
      deepHealth: { endpoint: "https://nvr01/health", responseMapping: { cameras: "$.cameras" }, alertExpression: "cameras < 6" },
    });
    const index = buildArtifactIndex(makeModel([], [svc]));
    expect(index.services.get("nvr01/frigate")?.gatusEndpoints).toEqual([]);
  });
});

describe("buildArtifactIndex — completeness, determinism, purity (02 §8.1)", () => {
  test("every declared host and service receives an entry, even with empty relationships", () => {
    const bareHost: Host = { name: "excluded01", collectionClass: "excluded", addresses: ["10.0.0.1"], suppressed: { class: "excluded", rationale: "gone" }, provenance: PROV };
    const bareSvc = makeService({ name: "plain", host: "excluded01" });
    const index = buildArtifactIndex(makeModel([bareHost], [bareSvc]));

    const host = index.hosts.get("excluded01");
    expect(host).toEqual({ artifacts: [], scrapeTargets: [] });
    const svc = index.services.get("excluded01/plain");
    expect(svc).toEqual({ artifacts: [], gatusEndpoints: [] });
  });

  test("building the same model twice yields deeply-equal indices", () => {
    const host: Host = { name: "web01", collectionClass: "managed-linux", addresses: ["10.0.0.4"], exporterPorts: [9100, 9300], cadvisor: true, heartbeat: true, deliveryForm: "compose", commandSignals: [], provenance: PROV };
    const svc = makeService({ name: "grafana", host: "web01", ingressUrl: "https://g" });
    const model = makeModel([host], [svc]);
    const a = buildArtifactIndex(model);
    const b = buildArtifactIndex(model);
    expect([...a.hosts.entries()]).toEqual([...b.hosts.entries()]);
    expect([...a.services.entries()]).toEqual([...b.services.entries()]);
  });

  test("builds a real model and touches the filesystem zero times", () => {
    const host: Host = { name: "web01", collectionClass: "managed-linux", addresses: ["10.0.0.4"], exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [], provenance: PROV };
    const svc = makeService({ name: "grafana", host: "web01", ingressUrl: "https://g" });
    const spies = [
      spyOn(fs, "readFileSync"),
      spyOn(fs, "writeFileSync"),
      spyOn(fs, "existsSync"),
      spyOn(fs, "statSync"),
      spyOn(fs, "readdirSync"),
      spyOn(fs, "mkdirSync"),
    ];
    try {
      buildArtifactIndex(makeModel([host], [svc]));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
