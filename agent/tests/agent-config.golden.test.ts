/**
 * host-agent schema-validation of the renderer's agent goldens (06-testing-strategy.md §6).
 *
 * `pulse-cli`'s `emitAgent()` (05 §4) renders `rendered/agent/<host>.yaml` VALUES; host-agent
 * authors `agent/contract/config.schema.json` (05 §2). The two features carry NO dependency edge
 * (CON-06) — they align ONLY by this shared schema. This suite is that alignment proof: it reads
 * the committed renderer goldens on disk (never importing the renderer package) and validates each
 * against the schema host-agent authored, covering both delivery forms and both cAdvisor states.
 *
 * Determinism note (06 §6): the byte-identical RE-RENDER witness (identical estate input ⇒
 * identical bytes) lives in `pulse-cli`'s own golden suite (`packages/renderer/tests/golden.test.ts`
 * — the whole-tree compare + the render-twice + the agent/manifest idempotence test), where
 * `render()` is importable. host-agent's contribution here is the schema correctness of those
 * committed outputs plus a completeness cross-check (the manifest ledger lists exactly the agent
 * goldens present on disk). If the renderer golden tree is not present on this branch, the suite
 * document-and-skips rather than failing silently (06 §6).
 *
 * Constants/helpers come from ./harness (the single non-test support module, 06 §1).
 */

/// <reference path="./bun-test.d.ts" />

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import { CADVISOR_PORT, HEARTBEAT_PORT, NODE_EXPORTER_PORT } from "../contract/constants.js";
import type { AgentHostConfig } from "../contract/types.js";
import {
  CONFIG_SCHEMA_PATH,
  RENDERER_AGENT_GOLDEN_DIR,
  RENDERER_MANIFEST_PATH,
  validateJsonSchema,
} from "./harness.js";

const configSchema: unknown = JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, "utf8"));

/** The committed renderer agent goldens, if the tree is present on this branch. */
function agentGoldenFiles(): string[] {
  if (!existsSync(RENDERER_AGENT_GOLDEN_DIR)) return [];
  return readdirSync(RENDERER_AGENT_GOLDEN_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
}

const GOLDEN_FILES = agentGoldenFiles();
/** Present-when-the-renderer-half-has-landed. Absent ⇒ document-and-skip (06 §6), never a
 *  silent false green: a skipped describe is visible in the runner output. */
const GOLDENS_PRESENT = GOLDEN_FILES.length > 0;
const goldenDescribe = GOLDENS_PRESENT ? describe : describe.skip;

if (!GOLDENS_PRESENT) {
  // Visible note so the skip is documented, not silent (06 §6).
  console.log(
    `[agent-config.golden] renderer agent golden tree absent (${RENDERER_AGENT_GOLDEN_DIR}) — ` +
      "skipping schema-validation of goldens until pulse-cli's emitAgent() goldens land on this branch.",
  );
}

/** Parse one committed agent golden into its typed config. */
function readGolden(file: string): AgentHostConfig {
  return parseYaml(readFileSync(join(RENDERER_AGENT_GOLDEN_DIR, file), "utf8")) as AgentHostConfig;
}

goldenDescribe("renderer agent goldens validate against config.schema.json (05 §6)", () => {
  test("every committed agent golden is schema-valid", () => {
    for (const file of GOLDEN_FILES) {
      const config = readGolden(file);
      expect(validateJsonSchema(configSchema, config), `${file} failed schema validation`).toEqual([]);
    }
  });

  test("the golden set covers both delivery forms and both cAdvisor states (AC)", () => {
    const configs = GOLDEN_FILES.map(readGolden);
    const deliveryForms = new Set(configs.map((c) => c.deliveryForm));
    const cadvisorStates = new Set(configs.map((c) => c.cadvisor));
    // Both delivery forms are exercised by the committed goldens (compose + systemd) ...
    expect(deliveryForms.has("compose"), "no compose golden present").toBe(true);
    expect(deliveryForms.has("systemd"), "no systemd golden present").toBe(true);
    // ... as are both cAdvisor opt-in states (true + false).
    expect(cadvisorStates.has(true), "no cadvisor:true golden present").toBe(true);
    expect(cadvisorStates.has(false), "no cadvisor:false golden present").toBe(true);
    // ... and both heartbeat states — issue #30/#33 added the node-exporter-only (heartbeat-off) host.
    const heartbeatStates = new Set(configs.map((c) => c.heartbeat));
    expect(heartbeatStates.has(true), "no heartbeat-on golden present").toBe(true);
    expect(heartbeatStates.has(false), "no heartbeat-off (node-exporter-only) golden present").toBe(true);
  });

  test("each golden carries the published port contract, with cAdvisor/heartbeat iff opted-in (REQ-CONT-01, issue #30/#33)", () => {
    for (const file of GOLDEN_FILES) {
      const config = readGolden(file);
      // node is always present at its contract port (tech-spec §3.7, REQ-NODE-01).
      expect(config.scrapePorts.node, `${file} node port`).toBe(NODE_EXPORTER_PORT);
      // heartbeat port present IFF the host opted in — symmetric with cAdvisor (issue #33).
      if (config.heartbeat) {
        expect(config.scrapePorts.heartbeat, `${file} opted into heartbeat but has no port`).toBe(HEARTBEAT_PORT);
      } else {
        expect(config.scrapePorts.heartbeat, `${file} did not opt into heartbeat but carries a port`).toBeUndefined();
      }
      // cAdvisor port present IFF the host opted in — the schema's coherence rule, checked on values.
      if (config.cadvisor) {
        expect(config.scrapePorts.cadvisor, `${file} opted into cadvisor but has no port`).toBe(CADVISOR_PORT);
      } else {
        expect(config.scrapePorts.cadvisor, `${file} did not opt into cadvisor but carries a port`).toBeUndefined();
      }
    }
  });

  test("a node-exporter-only config (heartbeat: false, no heartbeat port) is accepted by the schema (issue #30/#33)", () => {
    // A managed-linux host that opts out of heartbeat renders heartbeat: false + scrapePorts with
    // node only. The contract schema must accept it — heartbeat is no longer a required scrape port.
    const base = readGolden(GOLDEN_FILES[0] as string);
    const nodeOnly = {
      ...base,
      cadvisor: false,
      heartbeat: false,
      scrapePorts: { node: NODE_EXPORTER_PORT },
    };
    expect(validateJsonSchema(configSchema, nodeOnly).length).toBe(0);
  });

  test("a config that violates the cAdvisor coherence rule is rejected (schema negative control)", () => {
    // Derive an incoherent variant from a real golden: opt out of cAdvisor but keep the port (with
    // heartbeat left coherent). This proves the schema (not just the renderer) enforces REQ-CONT-01.
    const base = readGolden(GOLDEN_FILES[0] as string);
    const incoherent = {
      ...base,
      cadvisor: false,
      heartbeat: true,
      scrapePorts: { node: NODE_EXPORTER_PORT, cadvisor: CADVISOR_PORT, heartbeat: HEARTBEAT_PORT },
    };
    expect(validateJsonSchema(configSchema, incoherent).length).not.toBe(0);
  });

  test("a config that violates the heartbeat coherence rule is rejected (schema negative control, issue #33)", () => {
    // opt out of heartbeat but keep the port (cadvisor left coherent). Proves the schema enforces
    // the heartbeat IFF rule on the committed shape, symmetric with cAdvisor.
    const base = readGolden(GOLDEN_FILES[0] as string);
    const incoherent = {
      ...base,
      cadvisor: false,
      heartbeat: false,
      scrapePorts: { node: NODE_EXPORTER_PORT, heartbeat: HEARTBEAT_PORT },
    };
    expect(validateJsonSchema(configSchema, incoherent).length).not.toBe(0);
  });
});

/* ===========================================================================================
 * §6 — Determinism/completeness cross-check on the committed outputs.
 *
 * The byte-identical re-render is proven in the renderer suite. Here we assert the committed
 * manifest ledger lists EXACTLY the agent goldens present on disk — a completeness witness that
 * the deterministic emit set and the checked-in artifacts agree (a stale/missing agent file in
 * either place fails this).
 * ========================================================================================= */

goldenDescribe("the rendered manifest lists exactly the committed agent goldens (05 §6)", () => {
  test("manifest agent entries equal the on-disk agent goldens", () => {
    const manifest = JSON.parse(readFileSync(RENDERER_MANIFEST_PATH, "utf8")) as { files: string[] };
    // The agent BUNDLE configs are `agent/<host>.yaml`. The per-host prober config (issue #8) also
    // lives under agent/ (agent/<host>/prober/config.yaml) but is a prober artifact, not a bundle
    // golden — match only the bundle configs so this completeness witness stays scoped.
    const manifestAgentFiles = manifest.files.filter((p) => /^agent\/[^/]+\.yaml$/.test(p)).sort();
    const onDiskAgentFiles = GOLDEN_FILES.map((f) => `agent/${f}`).sort();
    expect(manifestAgentFiles).toEqual(onDiskAgentFiles);
  });
});
