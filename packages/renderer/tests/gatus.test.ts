/** gatus.test.ts — the Gatus endpoint/check emitter (02 §4.2, REQ-RND-01, REQ-DET-01).
 *
 *  Asserts: gatus always emits exactly one gatus/config.yaml with endpoints sorted by name,
 *  covering service ingress (suppressed omitted), probe-only hosts by kind (correct url forms),
 *  and per-domain DNS endpoints; no credentials → no findings. */

import { expect, test, describe } from "bun:test";

import type { EstateModel, Host, Service, Provenance } from "@pulse/core";
import { parse as parseYaml } from "yaml";

import { emitGatus } from "../src/render/gatus.js";
import type { GatusEndpoint } from "../src/render/gatus.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

function makeModel(over: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "test-estate",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "https://deadman.example.com/ping",
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

function service(over: Partial<Service> & Pick<Service, "name" | "host">): Service {
  return { kind: "web", managed: true, provenance: PROV, ...over };
}

function probeHost(name: string, kind: string, target: string): Host {
  return { name, collectionClass: "probe-only", addresses: [target], probe: { kind, target }, provenance: PROV };
}

/** Parse the single emitted gatus/config.yaml into its endpoints list. */
function endpointsOf(model: EstateModel): GatusEndpoint[] {
  const { files, findings } = emitGatus(model);
  expect(findings).toEqual([]);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("gatus/config.yaml");
  return (parseYaml(files[0].contents) as { endpoints: GatusEndpoint[] }).endpoints;
}

describe("emitGatus — file presence", () => {
  test("always emits exactly one gatus/config.yaml, even with no endpoints beyond DNS", () => {
    const { files, findings } = emitGatus(makeModel({ estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV } }));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("gatus/config.yaml");
    expect(findings).toEqual([]);
    // Empty endpoints list still serializes a stable file.
    const parsed = parseYaml(files[0].contents) as { endpoints: unknown[] };
    expect(parsed.endpoints).toEqual([]);
  });
});

describe("emitGatus — service ingress", () => {
  test("a service with ingressUrl becomes an HTTPS status check", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      services: [service({ name: "grafana", host: "web01", ingressUrl: "https://grafana.example.com" })],
    });
    const eps = endpointsOf(model);
    expect(eps).toEqual([
      { name: "web01/grafana", group: "web01", url: "https://grafana.example.com", conditions: ["[STATUS] == 200"] },
    ]);
  });

  test("a suppressed service produces no endpoint", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      services: [
        service({
          name: "grafana",
          host: "web01",
          ingressUrl: "https://grafana.example.com",
          suppressed: { class: "known-expected", rationale: "in maintenance" },
        }),
      ],
    });
    expect(endpointsOf(model)).toEqual([]);
  });

  test("a service without ingressUrl produces no endpoint", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      services: [service({ name: "plain", host: "web01" })],
    });
    expect(endpointsOf(model)).toEqual([]);
  });

  test("a service alerts: binding emits endpoints[].alerts with kebab-case keys (issue #15)", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      services: [
        service({
          name: "grafana",
          host: "web01",
          ingressUrl: "https://grafana.example.com",
          alerts: [
            {
              type: "custom",
              description: "Grafana ingress synthetic check failing",
              failureThreshold: 3,
              successThreshold: 2,
              sendOnResolved: true,
            },
          ],
        }),
      ],
    });
    expect(endpointsOf(model)).toEqual([
      {
        name: "web01/grafana",
        group: "web01",
        url: "https://grafana.example.com",
        conditions: ["[STATUS] == 200"],
        alerts: [
          {
            type: "custom",
            description: "Grafana ingress synthetic check failing",
            "failure-threshold": 3,
            "success-threshold": 2,
            "send-on-resolved": true,
          },
        ],
      },
    ]);
  });

  test("an alerts: binding with only type inherits provider defaults (no extra keys emitted)", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      services: [
        service({ name: "grafana", host: "web01", ingressUrl: "https://g", alerts: [{ type: "custom" }] }),
      ],
    });
    const [ep] = endpointsOf(model);
    expect(ep.alerts).toEqual([{ type: "custom" }]);
  });
});

describe("emitGatus — probe-only hosts by kind", () => {
  test("http → [STATUS] == 200 on the bare target", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [probeHost("edge-http", "http", "https://edge/health")],
    });
    expect(endpointsOf(model)).toEqual([
      { name: "host:edge-http", group: "edge-http", url: "https://edge/health", conditions: ["[STATUS] == 200"] },
    ]);
  });

  test("tcp → tcp://<target> with [CONNECTED] == true", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [probeHost("edge-tcp", "tcp", "10.0.0.9:22")],
    });
    expect(endpointsOf(model)).toEqual([
      { name: "host:edge-tcp", group: "edge-tcp", url: "tcp://10.0.0.9:22", conditions: ["[CONNECTED] == true"] },
    ]);
  });

  test("icmp → icmp://<target> with [CONNECTED] == true", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [probeHost("edge-icmp", "icmp", "10.0.0.9")],
    });
    expect(endpointsOf(model)).toEqual([
      { name: "host:edge-icmp", group: "edge-icmp", url: "icmp://10.0.0.9", conditions: ["[CONNECTED] == true"] },
    ]);
  });

  test("any other kind → reachability form on the bare target", () => {
    const model = makeModel({
      estate: { name: "e", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [probeHost("edge-x", "grpc", "10.0.0.9:50051")],
    });
    expect(endpointsOf(model)).toEqual([
      { name: "host:edge-x", group: "edge-x", url: "10.0.0.9:50051", conditions: ["[CONNECTED] == true"] },
    ]);
  });
});

describe("emitGatus — DNS + ordering", () => {
  test("each estate domain becomes a dns:<domain> check with a resolver, dns block, and condition", () => {
    const model = makeModel({ estate: { name: "e", domains: ["a.com", "b.com"], timezone: "UTC", deadmanHook: "x", provenance: PROV } });
    const eps = endpointsOf(model);
    expect(eps).toEqual([
      { name: "dns:a.com", url: "1.1.1.1", dns: { "query-name": "a.com", "query-type": "A" }, conditions: ["[DNS_RCODE] == NOERROR"] },
      { name: "dns:b.com", url: "1.1.1.1", dns: { "query-name": "b.com", "query-type": "A" }, conditions: ["[DNS_RCODE] == NOERROR"] },
    ]);
  });

  test("an estate resolver override applies to every domain", () => {
    const model = makeModel({
      estate: {
        name: "e",
        domains: ["a.internal", "b.internal"],
        dnsResolver: "10.0.0.53",
        timezone: "UTC",
        deadmanHook: "x",
        provenance: PROV,
      },
    });
    expect(endpointsOf(model).map((endpoint) => endpoint.url)).toEqual([
      "10.0.0.53",
      "10.0.0.53",
    ]);
  });

  test("endpoints are sorted by name across all sources", () => {
    const model = makeModel({
      estate: { name: "e", domains: ["z.com"], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [probeHost("aaa", "icmp", "10.0.0.1")],
      services: [service({ name: "svc", host: "mmm", ingressUrl: "https://svc" })],
    });
    const names = endpointsOf(model).map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // dns:z.com < host:aaa < mmm/svc by code point.
    expect(names).toEqual(["dns:z.com", "host:aaa", "mmm/svc"]);
  });

  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel({
      hosts: [probeHost("edge", "icmp", "10.0.0.9")],
      services: [service({ name: "grafana", host: "web01", ingressUrl: "https://g" })],
    });
    expect(emitGatus(model).files).toEqual(emitGatus(model).files);
  });
});
