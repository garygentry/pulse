/** scrape.test.ts — the `file_sd` scrape emitter (02 §4.1, REQ-RND-01, REQ-SEC-02).
 *
 *  Asserts: one file per non-excluded, non-empty class with correct per-variant targets; excluded
 *  and zero-host classes emit no file; managed-linux targets are address:port per port; a
 *  hypervisor-api credential renders as the SecretRef `.raw` in __pulse_credential__ (never a
 *  resolved value); nas-api renders a direct node_exporter target with no credential (issue #4);
 *  a refused credential omits the label and adds a secret_literal finding; an unknown class
 *  degrades to an INVALID_ENUM error finding, never a crash. */

import { expect, test, describe } from "bun:test";

import type { EstateModel, Host, Provenance, Service } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import { emitScrape } from "../src/render/scrape.js";
import type { FileSdEntry } from "../src/render/scrape.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

function makeModel(hosts: Host[], services: Service[] = []): EstateModel {
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

/** Parse the emitted file for a class back into FileSdEntry[]. */
function fileFor(model: EstateModel, cls: string): FileSdEntry[] | undefined {
  const { files } = emitScrape(model);
  const file = files.find((f) => f.path === `scrape/file_sd/${cls}.json`);
  return file ? (JSON.parse(file.contents) as FileSdEntry[]) : undefined;
}

const managed = (over: Partial<Host> = {}): Host => ({
  name: "web01",
  collectionClass: "managed-linux",
  cadvisor: false,
  // heartbeat defaults ON (issue #30) to match the schema default; a test opts out with
  // `{ heartbeat: false }`.
  heartbeat: true,
  deliveryForm: "compose",
  addresses: ["10.0.0.4"],
  exporterPorts: [9100, 9256],
  commandSignals: [],
  provenance: PROV,
  ...over,
} as Host);

describe("emitScrape — file presence", () => {
  test("one file per non-excluded, non-empty class; excluded emits no file", () => {
    const model = makeModel([
      managed(),
      {
        name: "old01",
        collectionClass: "excluded",
        addresses: ["10.0.0.99"],
        suppressed: { class: "excluded", rationale: "decommissioned" },
        provenance: PROV,
      },
    ]);
    const { files } = emitScrape(model);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      "scrape/file_sd/managed-linux.json",
      "scrape/file_sd/process-exporter.json",
      "scrape/file_sd/managed-linux-heartbeat.json",
    ]);
    expect(paths).not.toContain("scrape/file_sd/excluded.json");
  });

  test("a zero-host class produces no file", () => {
    // Only managed-linux hosts declared → no hypervisor-api/nas-api/probe-only files.
    const { files } = emitScrape(makeModel([managed()]));
    expect(files.map((f) => f.path)).toEqual([
      "scrape/file_sd/managed-linux.json",
      "scrape/file_sd/process-exporter.json",
      "scrape/file_sd/managed-linux-heartbeat.json",
    ]);
  });

  test("an excluded host contributes no target in any class", () => {
    const model = makeModel([
      {
        name: "old01",
        collectionClass: "excluded",
        addresses: ["10.0.0.99"],
        suppressed: { class: "excluded", rationale: "gone" },
        provenance: PROV,
      },
    ]);
    const { files, findings } = emitScrape(model);
    expect(files).toEqual([]);
    expect(findings).toEqual([]);
  });
});

describe("emitScrape — per-variant targets", () => {
  test("managed-linux contains node-exporter 9100 only", () => {
    const model = makeModel([managed({ cadvisor: true, exporterPorts: [9256] })]);
    const entries = fileFor(model, "managed-linux");
    expect(entries).toBeDefined();
    expect(entries![0].targets).toEqual(["10.0.0.4:9100"]);
    expect(entries![0].labels).toEqual({ host: "web01", collection_class: "managed-linux" });
  });

  test("heartbeat 9110 is emitted in its own job by default", () => {
    const entries = fileFor(
      makeModel([managed({ exporterPorts: [] })]),
      "managed-linux-heartbeat",
    );
    expect(entries![0].targets).toEqual(["10.0.0.4:9110"]);
    expect(entries![0].labels.host).toBe("web01");
  });

  test("heartbeat 9110 is dropped when the host opts out; node-exporter 9100 stays (issue #30)", () => {
    const model = makeModel([managed({ heartbeat: false, exporterPorts: [9100] })]);
    // No heartbeat target at all…
    expect(fileFor(model, "managed-linux-heartbeat")).toBeUndefined();
    // …but the mandatory node-exporter job (HostDown's up{job="managed-linux"}) is still emitted.
    expect(fileFor(model, "managed-linux")![0].targets).toEqual(["10.0.0.4:9100"]);
  });

  test("an opted-out host that still declares :9110 renders it as a custom exporter, not a heartbeat job (issue #30)", () => {
    // With heartbeat off, :9110 is no longer a dedicated managed port, so a declared 9110 falls
    // through to managed-linux-exporters rather than silently vanishing.
    const model = makeModel([managed({ heartbeat: false, exporterPorts: [9100, 9110] })]);
    expect(fileFor(model, "managed-linux-heartbeat")).toBeUndefined();
    const custom = fileFor(model, "managed-linux-exporters")!;
    expect(custom.map((e) => e.targets[0])).toEqual(["10.0.0.4:9110"]);
    expect(custom[0].labels.exporter_port).toBe("9110");
  });

  test("cAdvisor 8080 is emitted separately iff the host opted in", () => {
    const onModel = makeModel([managed({ cadvisor: true, exporterPorts: [8080] })]);
    const on = fileFor(onModel, "cadvisor");
    expect(on![0].targets).toEqual(["10.0.0.4:8080"]);
    expect(fileFor(onModel, "managed-linux-exporters")).toBeUndefined();
    const off = fileFor(makeModel([managed({ cadvisor: false, exporterPorts: [] })]), "cadvisor");
    expect(off).toBeUndefined();
  });

  test("process-exporter gets its own job and ungated declared ports remain custom", () => {
    const model = makeModel([
      managed({ cadvisor: false, exporterPorts: [9100, 9110, 8080, 9120, 9130, 9257, 9256, 9256] }),
    ]);
    const custom = fileFor(model, "managed-linux-exporters")!;
    expect(fileFor(model, "process-exporter")![0].targets).toEqual(["10.0.0.4:9256"]);
    expect(custom.map((entry) => entry.targets[0])).toEqual([
      "10.0.0.4:8080",
      "10.0.0.4:9120",
      "10.0.0.4:9130",
      "10.0.0.4:9257",
    ]);
    expect(custom.map((entry) => entry.labels.exporter_port)).toEqual([
      "8080",
      "9120",
      "9130",
      "9257",
    ]);
    expect(fileFor(model, "cadvisor")).toBeUndefined();
    expect(fileFor(model, "managed-linux-prober")).toBeUndefined();
    expect(fileFor(model, "managed-linux-command-exporter")).toBeUndefined();
  });

  test("command-exporter 9130 is emitted separately iff the host has command signals", () => {
    const onModel = makeModel([
      managed({
        exporterPorts: [9130],
        commandSignals: [
          { output: "exposition", name: "gpu", command: ["/bin/gpu"], interval: "30s" },
        ],
      }),
    ]);
    const on = fileFor(onModel, "managed-linux-command-exporter");
    expect(on![0].targets).toEqual(["10.0.0.4:9130"]);
    expect(fileFor(onModel, "managed-linux-exporters")).toBeUndefined();
    const off = fileFor(
      makeModel([managed({ exporterPorts: [], commandSignals: [] })]),
      "managed-linux-command-exporter",
    );
    expect(off).toBeUndefined();
  });

  test("managed-linux includes per-host prober 9120 iff a service on it declares a host_local probe (issue #8)", () => {
    const hostLocalSvc: Service = {
      name: "frigate",
      host: "web01",
      kind: "http",
      managed: true,
      deepHealth: {
        endpoint: "http://127.0.0.1:5000/api/stats",
        responseMapping: { detectors: "$.detectors.count" },
        alertExpression: "pulse_deep_health_up == 0",
        hostLocal: true,
      },
      provenance: PROV,
    };
    const onModel = makeModel([managed({ exporterPorts: [9120] })], [hostLocalSvc]);
    const on = fileFor(onModel, "managed-linux-prober");
    expect(on![0].targets).toEqual(["10.0.0.4:9120"]);
    expect(fileFor(onModel, "managed-linux-exporters")).toBeUndefined();
    // A central (non-host-local) probe does NOT add :9120.
    const central: Service = {
      ...hostLocalSvc,
      deepHealth: { ...hostLocalSvc.deepHealth!, hostLocal: false },
    };
    const off = fileFor(
      makeModel([managed({ exporterPorts: [] })], [central]),
      "managed-linux-prober",
    );
    expect(off).toBeUndefined();
  });

  test("managed-linux jobs use the first address", () => {
    const model = makeModel([
      managed({ addresses: ["10.0.0.4", "10.0.0.5"], exporterPorts: [9256] }),
    ]);
    expect(fileFor(model, "managed-linux")![0].targets).toEqual(["10.0.0.4:9100"]);
    expect(fileFor(model, "managed-linux-heartbeat")![0].targets).toEqual(["10.0.0.4:9110"]);
    expect(fileFor(model, "process-exporter")![0].targets).toEqual(["10.0.0.4:9256"]);
  });

  test("probe-only carries __pulse_probe_kind__ and the probe target", () => {
    const host: Host = {
      name: "edge01",
      collectionClass: "probe-only",
      addresses: ["10.0.0.9"],
      probe: { kind: "icmp", target: "10.0.0.9" },
      provenance: PROV,
    };
    const entries = fileFor(makeModel([host]), "probe-only");
    expect(entries![0].targets).toEqual(["10.0.0.9"]);
    expect(entries![0].labels.__pulse_probe_kind__).toBe("icmp");
    expect(entries![0].labels.host).toBe("edge01");
  });

  test("entries within a file are ordered by host name", () => {
    const entries = fileFor(
      makeModel([managed({ name: "web02" }), managed({ name: "web01" })]),
      "managed-linux",
    );
    expect(entries!.map((e) => e.labels.host)).toEqual(["web01", "web02"]);
  });
});

describe("emitScrape — credential rendering (REQ-SEC-02)", () => {
  const hypervisor = (credential: unknown): Host =>
    ({
      name: "pve1",
      collectionClass: "hypervisor-api",
      addresses: ["10.0.0.5"],
      apiEndpoint: "https://pve1:8006",
      credential,
      provenance: PROV,
    } as Host);

  test("hypervisor-api target carries __pulse_credential__ equal to the ref .raw", () => {
    const model = makeModel([hypervisor({ kind: "env", raw: "${PVE_TOKEN}", varName: "PVE_TOKEN" })]);
    const entries = fileFor(model, "hypervisor-api");
    expect(entries![0].targets).toEqual(["https://pve1:8006"]);
    expect(entries![0].labels.__pulse_credential__).toBe("${PVE_TOKEN}");
  });

  test("nas-api renders a DIRECT node_exporter target with no credential label (issue #4)", () => {
    // The shipped nas-api path is a direct node_exporter scrape: <addresses[0]>:9100, no
    // __pulse_credential__ label and no relabel-through target.
    const nas: Host = {
      name: "nas1",
      collectionClass: "nas-api",
      addresses: ["10.0.0.6"],
      provenance: PROV,
    };
    const entries = fileFor(makeModel([nas]), "nas-api");
    expect(entries![0].targets).toEqual(["10.0.0.6:9100"]);
    expect(entries![0].labels).toEqual({ host: "nas1", collection_class: "nas-api" });
    expect(entries![0].labels.__pulse_credential__).toBeUndefined();
  });

  test("nas-api ignores the opt-in override fields — no credential ever reaches the target (issue #4)", () => {
    // Even when an operator declares the reserved apiEndpoint/credential override fields, the
    // shipped renderer routes node_exporter direct and never emits the credential here (the
    // override is wired by hand per the documented recipe).
    const nas = {
      name: "nas1",
      collectionClass: "nas-api",
      addresses: ["10.0.0.6"],
      apiEndpoint: "https://nas1/api",
      credential: { kind: "env", raw: "${NAS}", varName: "NAS", resolved: "s3cr3t" },
      provenance: PROV,
    } as unknown as Host;
    const entries = fileFor(makeModel([nas]), "nas-api");
    expect(entries![0].targets).toEqual(["10.0.0.6:9100"]);
    expect(JSON.stringify(entries)).not.toContain("s3cr3t");
    expect(JSON.stringify(entries)).not.toContain("__pulse_credential__");
  });

  test("a refused (non-SecretRef) credential omits the label and adds a secret_literal finding", () => {
    const model = makeModel([hypervisor("literally-a-password")]);
    const { files, findings } = emitScrape(model);
    const entries = JSON.parse(files[0].contents) as FileSdEntry[];
    expect(entries[0].labels.__pulse_credential__).toBeUndefined();
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(findings[0].severity).toBe("error");
  });
});

describe("emitScrape — defensive exhaustiveness (02 §4.1)", () => {
  test("a runtime unknown class becomes an INVALID_ENUM error finding, never a crash", () => {
    const rogue = {
      name: "mystery",
      collectionClass: "quantum-flux",
      addresses: ["10.0.0.1"],
      provenance: PROV,
    } as unknown as Host;
    let result!: ReturnType<typeof emitScrape>;
    expect(() => {
      result = emitScrape(makeModel([rogue]));
    }).not.toThrow();
    expect(result.files).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe(FINDING_CODES.INVALID_ENUM);
    expect(result.findings[0].severity).toBe("error");
    expect(result.findings[0].path).toBe("mystery");
  });
});

describe("emitScrape — determinism", () => {
  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel([managed(), managed({ name: "web02", exporterPorts: [9100] })]);
    const a = emitScrape(model);
    const b = emitScrape(model);
    expect(a.files).toEqual(b.files);
  });

  test("label keys are code-point sorted by the serializer", () => {
    const model = makeModel([
      {
        name: "pve1",
        collectionClass: "hypervisor-api",
        addresses: ["10.0.0.5"],
        apiEndpoint: "https://pve1:8006",
        credential: { kind: "env", raw: "${PVE}", varName: "PVE" },
        provenance: PROV,
      },
    ]);
    const { files } = emitScrape(model);
    // __pulse_credential__ < collection_class < host by code point.
    const idxCred = files[0].contents.indexOf("__pulse_credential__");
    const idxClass = files[0].contents.indexOf("collection_class");
    const idxHost = files[0].contents.indexOf('"host"');
    expect(idxCred).toBeGreaterThanOrEqual(0);
    expect(idxCred).toBeLessThan(idxClass);
    expect(idxClass).toBeLessThan(idxHost);
  });
});
