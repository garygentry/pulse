/** agent.test.ts — the per-host managed-linux agent bundle emitter
 *  (05-config-schema-and-integration.md §4.1, REQ-BUNDLE-05, REQ-CONT-01, REQ-DET-01).
 *
 *  Asserts: exactly one `agent/<host>.yaml` per managed-linux host and NOTHING for any other
 *  collection class; the rendered ports are node=9100 always, with cadvisor=8080 and heartbeat=9110
 *  each present IFF the host opted in (heartbeat defaults on; issue #30); both delivery forms
 *  round-trip; `agent` is a registered render kind that
 *  `renderOnly` / `--only agent` dispatches; emitted agent files appear in the manifest ledger; and
 *  rendering identical input twice is byte-identical with deterministic path/content ordering. */

import { expect, test, describe } from "bun:test";

import { parse as yamlParse } from "yaml";

import { emitAgent } from "../src/render/agent.js";
import { RENDER_KINDS, renderOnly } from "../src/render/index.js";
import { MANIFEST_FILENAME, type RenderedManifest } from "../src/manifest.js";
import { makeHost, makeModel } from "./factories.js";

interface AgentConfig {
  host: string;
  deliveryForm: "compose" | "systemd";
  cadvisor: boolean;
  heartbeat: boolean;
  scrapePorts: { node: number; cadvisor?: number; heartbeat?: number };
}

/** A managed-linux host with the ECR fields set. */
const managed = (name: string, over: Record<string, unknown> = {}) =>
  makeHost("managed-linux", { name, cadvisor: false, deliveryForm: "compose", ...over });

/** Parse the emitted agent config for one host name, or `undefined` if none was emitted. */
function agentFor(model: Parameters<typeof emitAgent>[0], host: string): AgentConfig | undefined {
  const file = emitAgent(model).files.find((f) => f.path === `agent/${host}.yaml`);
  return file ? (yamlParse(file.contents) as AgentConfig) : undefined;
}

describe("emitAgent — managed-linux only (REQ-BUNDLE-05, V-001)", () => {
  test("emits exactly one agent/<host>.yaml per managed-linux host", () => {
    const model = makeModel({ hosts: [managed("web01"), managed("web02")] });
    const { files, findings } = emitAgent(model);
    expect(files.map((f) => f.path)).toEqual(["agent/web01.yaml", "agent/web02.yaml"]);
    expect(findings).toEqual([]);
  });

  test("no file for hypervisor-api / nas-api / probe-only / excluded", () => {
    const model = makeModel({
      hosts: [
        managed("web01"),
        makeHost("hypervisor-api", { name: "pve1" }),
        makeHost("nas-api", { name: "nas1" }),
        makeHost("probe-only", { name: "edge1" }),
        makeHost("excluded", { name: "old1" }),
      ],
    });
    const { files } = emitAgent(model);
    // Only the managed-linux host contributes a file.
    expect(files.map((f) => f.path)).toEqual(["agent/web01.yaml"]);
  });

  test("an estate with no managed-linux hosts emits nothing", () => {
    const model = makeModel({ hosts: [makeHost("hypervisor-api", { name: "pve1" })] });
    expect(emitAgent(model).files).toEqual([]);
  });
});

describe("emitAgent — port contract (REQ-CONT-01)", () => {
  test("node=9100 is always present; heartbeat boolean + 9110 present by default", () => {
    const cfg = agentFor(makeModel({ hosts: [managed("web01")] }), "web01")!;
    expect(cfg.scrapePorts.node).toBe(9100);
    expect(cfg.heartbeat).toBe(true); // top-level gate (issue #33)
    expect(cfg.scrapePorts.heartbeat).toBe(9110);
  });

  test("heartbeat boolean + 9110 are dropped when the host opts out (issue #30/#33)", () => {
    const off = agentFor(
      makeModel({ hosts: [managed("dns01", { heartbeat: false })] }),
      "dns01",
    )!;
    // node stays mandatory; heartbeat boolean false + port absent → a node-exporter-only descriptor.
    expect(off.scrapePorts.node).toBe(9100);
    expect(off.heartbeat).toBe(false);
    expect("heartbeat" in off.scrapePorts).toBe(false);
  });

  test("the heartbeat and cadvisor gates are independent (issue #30/#33)", () => {
    // heartbeat off + cadvisor on: both top-level booleans + ports reflect it, the gates don't interfere.
    const cfg = agentFor(
      makeModel({ hosts: [managed("dns01", { heartbeat: false, cadvisor: true })] }),
      "dns01",
    )!;
    expect(cfg.heartbeat).toBe(false);
    expect(cfg.cadvisor).toBe(true);
    expect(cfg.scrapePorts.node).toBe(9100);
    expect(cfg.scrapePorts.cadvisor).toBe(8080);
    expect("heartbeat" in cfg.scrapePorts).toBe(false);
  });

  test("cadvisor=8080 is present IFF the host opts in", () => {
    const on = agentFor(makeModel({ hosts: [managed("web01", { cadvisor: true })] }), "web01")!;
    expect(on.cadvisor).toBe(true);
    expect(on.scrapePorts.cadvisor).toBe(8080);

    const off = agentFor(makeModel({ hosts: [managed("web02", { cadvisor: false })] }), "web02")!;
    expect(off.cadvisor).toBe(false);
    expect("cadvisor" in off.scrapePorts).toBe(false);
  });

  test("both delivery forms round-trip into the rendered config", () => {
    const compose = agentFor(makeModel({ hosts: [managed("web01", { deliveryForm: "compose" })] }), "web01")!;
    expect(compose.deliveryForm).toBe("compose");
    const systemd = agentFor(makeModel({ hosts: [managed("web02", { deliveryForm: "systemd" })] }), "web02")!;
    expect(systemd.deliveryForm).toBe("systemd");
  });

  test("the config carries exactly the AgentHostConfig field set", () => {
    const cfg = agentFor(makeModel({ hosts: [managed("web01", { cadvisor: true })] }), "web01")!;
    expect(Object.keys(cfg).sort()).toEqual(["cadvisor", "deliveryForm", "heartbeat", "host", "scrapePorts"]);
    expect(cfg.host).toBe("web01");
  });
});

describe("emitAgent — render-kind selection & manifest ledger", () => {
  test("`agent` is a registered render kind", () => {
    expect(RENDER_KINDS).toContain("agent");
  });

  test("--only agent renders only the agent files (plus the manifest)", () => {
    const model = makeModel({
      hosts: [managed("web01"), makeHost("hypervisor-api", { name: "pve1" })],
    });
    const { tree } = renderOnly(model, ["agent"]);
    const paths = tree.map((f) => f.path).filter((p) => p !== MANIFEST_FILENAME);
    expect(paths).toEqual(["agent/web01.yaml"]);
  });

  test("emitted agent files appear in the manifest ledger", () => {
    const model = makeModel({ hosts: [managed("web01"), managed("web02")] });
    const { tree } = renderOnly(model, RENDER_KINDS);
    const manifestFile = tree.find((f) => f.path === MANIFEST_FILENAME)!;
    const manifest = JSON.parse(manifestFile.contents) as RenderedManifest;
    expect(manifest.files).toContain("agent/web01.yaml");
    expect(manifest.files).toContain("agent/web02.yaml");
  });
});

describe("emitAgent — determinism (REQ-CFG-04/DET-01)", () => {
  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel({ hosts: [managed("web02"), managed("web01", { cadvisor: true })] });
    expect(emitAgent(model).files).toEqual(emitAgent(model).files);
  });

  test("files are ordered by path regardless of host declaration order", () => {
    const model = makeModel({ hosts: [managed("web09"), managed("web01"), managed("web05")] });
    expect(emitAgent(model).files.map((f) => f.path)).toEqual([
      "agent/web01.yaml",
      "agent/web05.yaml",
      "agent/web09.yaml",
    ]);
  });

  test("YAML keys are canonically sorted", () => {
    const { files } = emitAgent(makeModel({ hosts: [managed("web01", { cadvisor: true })] }));
    const body = files[0].contents;
    // Top-level keys sorted: cadvisor < deliveryForm < host < scrapePorts.
    expect(body.indexOf("cadvisor:")).toBeLessThan(body.indexOf("deliveryForm:"));
    expect(body.indexOf("deliveryForm:")).toBeLessThan(body.indexOf("host:"));
    expect(body.indexOf("host:")).toBeLessThan(body.indexOf("scrapePorts:"));
  });
});
