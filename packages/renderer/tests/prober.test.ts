/** prober.test.ts — the prober declaration emitter (02 §4.4, REQ-RND-01).
 *
 *  Asserts: prober/config.yaml is ABSENT when the estate declares no probe of any kind; a service
 *  with `deepHealth` yields a `deep-health` entry with responseMapping + opaque alertExpression; a
 *  service with `backupFreshness` yields a `backup-freshness` entry with opaque threshold; a
 *  service declaring BOTH yields two distinctly-named entries ('svc:h/s' and 'svc:h/s#backup'); a
 *  probe-only host yields a reachability entry carrying probe.expect into `note`; entries sorted by
 *  name; a deep-health credential flows through renderSecretRef — a ${ENV}/op:// reference emits
 *  only its raw string, an absent credential omits the key, and a poisoned literal is refused with
 *  a SECRET_LITERAL finding and no credential key; otherwise no findings. */

import { expect, test, describe } from "bun:test";
import { parse as parseYaml } from "yaml";

import type { EstateModel, Host, Provenance, SecretRef, Service } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import { emitProber } from "../src/render/prober.js";
import type { ProberEntry } from "../src/render/prober.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

function makeModel(over: { hosts?: Host[]; services?: Service[] }): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "test-estate",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "https://deadman.example.com/ping",
      provenance: PROV,
    },
    hosts: over.hosts ?? [],
    services: over.services ?? [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
}

const service = (over: Partial<Service>): Service =>
  ({ name: "svc", host: "h", kind: "app", managed: true, provenance: PROV, ...over } as Service);

const probeOnly = (name: string, over: Partial<Host> = {}): Host =>
  ({
    name,
    collectionClass: "probe-only",
    addresses: ["10.0.0.9"],
    probe: { kind: "icmp", target: "10.0.0.9" },
    provenance: PROV,
    ...over,
  } as Host);

/** Parse the emitted prober/config.yaml `probes` list, or undefined if the file is absent. */
function probes(model: EstateModel): ProberEntry[] | undefined {
  const { files } = emitProber(model);
  const file = files.find((f) => f.path === "prober/config.yaml");
  return file ? (parseYaml(file.contents).probes as ProberEntry[]) : undefined;
}

describe("emitProber — file presence", () => {
  test("prober/config.yaml is ABSENT when no probe of any kind is declared", () => {
    const { files, findings } = emitProber(
      makeModel({
        hosts: [
          {
            name: "web01",
            collectionClass: "managed-linux",
            cadvisor: false,
            heartbeat: true,
            deliveryForm: "compose",
            addresses: ["10.0.0.4"],
            exporterPorts: [9100],
            commandSignals: [],
            provenance: PROV,
          } as Host,
        ],
        services: [service({ ingressUrl: "https://svc.example.com" })],
      }),
    );
    expect(files).toEqual([]);
    expect(findings).toEqual([]);
  });

  test("emits the file when >=1 probe is declared, and never emits findings", () => {
    const { files, findings } = emitProber(makeModel({ hosts: [probeOnly("edge01")] }));
    expect(files.map((f) => f.path)).toEqual(["prober/config.yaml"]);
    expect(findings).toEqual([]);
  });
});

describe("emitProber — entry shapes (opaque pass-through)", () => {
  test("deep-health entry carries responseMapping + opaque alertExpression", () => {
    const entries = probes(
      makeModel({
        services: [
          service({
            host: "nvr01",
            name: "frigate",
            deepHealth: {
              endpoint: "https://nvr01.example.com/health",
              responseMapping: { camera_count: "$.cameras.online" },
              alertExpression: "camera_count < 6",
            },
          }),
        ],
      }),
    );
    expect(entries).toEqual([
      {
        name: "svc:nvr01/frigate",
        target: "https://nvr01.example.com/health",
        kind: "deep-health",
        responseMapping: { camera_count: "$.cameras.online" },
        alertExpression: "camera_count < 6",
      },
    ]);
  });

  test("backup-freshness entry carries opaque threshold, no parsing", () => {
    const entries = probes(
      makeModel({
        services: [
          service({
            host: "nas01",
            name: "backups",
            backupFreshness: { signal: "restic:last_snapshot", threshold: "24h" },
          }),
        ],
      }),
    );
    expect(entries).toEqual([
      {
        name: "svc:nas01/backups#backup",
        target: "restic:last_snapshot",
        kind: "backup-freshness",
        threshold: "24h",
      },
    ]);
  });

  test("probe-only host carries probe.expect into a note field when present", () => {
    const entries = probes(
      makeModel({ hosts: [probeOnly("edge01", { probe: { kind: "http", target: "https://edge01", expect: "200" } })] }),
    );
    expect(entries).toEqual([
      { name: "host:edge01", target: "https://edge01", kind: "http", note: "200" },
    ]);
  });

  test("probe-only host omits note when expect is absent", () => {
    const entries = probes(makeModel({ hosts: [probeOnly("edge01")] }));
    expect(entries![0]).not.toHaveProperty("note");
  });
});

describe("emitProber — deep-health credentials (renderSecretRef choke point)", () => {
  const envRef: SecretRef = { kind: "env", raw: "${FRIGATE_TOKEN}", varName: "FRIGATE_TOKEN" };
  const opRef: SecretRef = {
    kind: "op",
    raw: "op://vault/frigate/token",
    vault: "vault",
    item: "frigate",
    field: "token",
  };

  const withCredential = (credential: unknown): EstateModel =>
    makeModel({
      services: [
        service({
          host: "nvr01",
          name: "frigate",
          deepHealth: {
            endpoint: "https://nvr01.example.com/health",
            responseMapping: { camera_count: "$.cameras.online" },
            alertExpression: "camera_count < 6",
            ...(credential !== undefined ? { credential } : {}),
          } as Service["deepHealth"],
        }),
      ],
    });

  test("a ${ENV} credential emits only the raw reference string, no finding", () => {
    const model = withCredential(envRef);
    const { findings } = emitProber(model);
    expect(probes(model)![0].credential).toBe("${FRIGATE_TOKEN}");
    expect(findings).toEqual([]);
  });

  test("an op:// credential emits only the raw reference string, no finding", () => {
    const model = withCredential(opRef);
    const { findings } = emitProber(model);
    expect(probes(model)![0].credential).toBe("op://vault/frigate/token");
    expect(findings).toEqual([]);
  });

  test("an absent credential omits the credential key and emits no finding", () => {
    const model = withCredential(undefined);
    const { findings } = emitProber(model);
    expect(probes(model)![0]).not.toHaveProperty("credential");
    expect(findings).toEqual([]);
  });

  test("a poisoned literal is refused: no credential key + a precise SECRET_LITERAL finding", () => {
    const model = withCredential("super-secret-token"); // a literal, not a SecretRef
    const { findings } = emitProber(model);
    // The credential key is omitted from the emitted entry — never a literal in the tree.
    expect(probes(model)![0]).not.toHaveProperty("credential");
    // And no literal leaks into the serialized file at all.
    const { files } = emitProber(model);
    expect(files[0].contents).not.toContain("super-secret-token");
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].file).toBe("prober/config.yaml");
    expect(findings[0].path).toBe("svc:nvr01/frigate.credential");
  });
});

describe("emitProber — both probes + ordering", () => {
  test("a service with both deepHealth and backupFreshness yields two distinctly-named entries", () => {
    const entries = probes(
      makeModel({
        services: [
          service({
            host: "h",
            name: "s",
            deepHealth: {
              endpoint: "https://h/health",
              responseMapping: { up: "$.up" },
              alertExpression: "up == 0",
            },
            backupFreshness: { signal: "restic:last", threshold: "24h" },
          }),
        ],
      }),
    );
    const names = entries!.map((e) => e.name);
    expect(names).toContain("svc:h/s");
    expect(names).toContain("svc:h/s#backup");
    expect(new Set(names).size).toBe(2);
    expect(entries).toHaveLength(2);
  });

  test("entries are sorted by name (raw code-point)", () => {
    const entries = probes(
      makeModel({
        hosts: [probeOnly("zeta"), probeOnly("alpha")],
        services: [
          service({ host: "h", name: "s", backupFreshness: { signal: "sig", threshold: "1h" } }),
        ],
      }),
    );
    const names = entries!.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });

  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel({
      hosts: [probeOnly("edge01", { probe: { kind: "tcp", target: "10.0.0.9:22" } })],
      services: [service({ host: "h", name: "s", backupFreshness: { signal: "sig", threshold: "1h" } })],
    });
    expect(emitProber(model).files).toEqual(emitProber(model).files);
  });
});

describe("emitProber — host-local partition (issue #8)", () => {
  const local = (host: string, name: string): Service =>
    service({
      host,
      name,
      deepHealth: {
        endpoint: "http://127.0.0.1:5000/api/stats",
        responseMapping: { detectors: "$.detectors.count" },
        alertExpression: "pulse_deep_health_up == 0",
        hostLocal: true,
      },
    });

  /** Parse a per-host prober file's probes, or undefined if absent. */
  const perHost = (model: EstateModel, host: string): ProberEntry[] | undefined => {
    const file = emitProber(model).files.find((f) => f.path === `agent/${host}/prober/config.yaml`);
    return file ? (parseYaml(file.contents).probes as ProberEntry[]) : undefined;
  };

  test("a host_local deep-health probe renders to agent/<host>/prober/config.yaml, NOT central", () => {
    const model = makeModel({ services: [local("web01", "frigate")] });
    const paths = emitProber(model).files.map((f) => f.path);
    expect(paths).toEqual(["agent/web01/prober/config.yaml"]);
    expect(perHost(model, "web01")).toEqual([
      {
        name: "svc:web01/frigate",
        target: "http://127.0.0.1:5000/api/stats",
        kind: "deep-health",
        responseMapping: { detectors: "$.detectors.count" },
        alertExpression: "pulse_deep_health_up == 0",
      },
    ]);
  });

  test("central and host-local probes coexist, each in its own file", () => {
    const model = makeModel({
      services: [
        service({
          host: "web01",
          name: "portal",
          deepHealth: {
            endpoint: "https://portal.example.com/health",
            responseMapping: { up: "$.up" },
            alertExpression: "up == 0",
          },
        }),
        local("web01", "frigate"),
      ],
    });
    const paths = emitProber(model).files.map((f) => f.path).sort();
    expect(paths).toEqual(["agent/web01/prober/config.yaml", "prober/config.yaml"]);
    // The central file holds portal only; the per-host file holds frigate only.
    expect(probes(model)!.map((e) => e.name)).toEqual(["svc:web01/portal"]);
    expect(perHost(model, "web01")!.map((e) => e.name)).toEqual(["svc:web01/frigate"]);
  });

  test("host-local probes are grouped per host into distinct files", () => {
    const model = makeModel({
      services: [local("web01", "frigate"), local("app02", "nvr")],
    });
    const paths = emitProber(model).files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "agent/app02/prober/config.yaml",
      "agent/web01/prober/config.yaml",
    ]);
  });

  test("a host-local credential's SECRET_LITERAL finding names the PER-HOST file", () => {
    const model = makeModel({
      services: [
        service({
          host: "web01",
          name: "frigate",
          deepHealth: {
            endpoint: "http://127.0.0.1:5000/api/stats",
            responseMapping: { d: "$.d" },
            alertExpression: "d == 0",
            hostLocal: true,
            credential: "super-secret-token", // a literal, not a SecretRef
          } as Service["deepHealth"],
        }),
      ],
    });
    const { files, findings } = emitProber(model);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(findings[0].file).toBe("agent/web01/prober/config.yaml");
    expect(files.every((f) => !f.contents.includes("super-secret-token"))).toBe(true);
  });
});
