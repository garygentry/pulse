// packages/renderer/src/render/agent.ts — per-host agent bundle config (host-agent's
// config.schema.json target — 05-config-schema-and-integration.md §2). Emits one
// rendered/agent/<host>.yaml PER managed-linux host; every other collection class emits
// NOTHING (REQ-BUNDLE-05, CON-01, tech-spec §3.6 V-001). Pure + deterministic (REQ-DET-01).
import type { EstateModel, Host } from "@pulse/core";

import { compareString } from "../order.js";
import { toCanonicalYaml } from "../format.js";
import type { EmitResult } from "./emit-result.js";

/** Published per-host bundle ports (host-agent's scrape-port contract, tech-spec §3.7).
 *  Re-declared locally because the renderer does NOT import `agent/` (CON-06, no dep edge);
 *  the shared scrape-port contract and the golden/structural tests hold them in sync. */
const NODE_EXPORTER_PORT = 9100;
const CADVISOR_PORT = 8080;
const HEARTBEAT_PORT = 9110;

/**
 * Emit `agent/<host>.yaml` for every `managed-linux` host — and ONLY those hosts
 * (REQ-BUNDLE-05, CON-01). `hypervisor-api`, `nas-api`, `probe-only`, and `excluded` hosts
 * contribute NO agent config (the guard `continue`s), mirroring the per-class switch in
 * `emitScrape`'s `hostEntry` (`render/scrape.ts`). Each file matches
 * `agent/contract/config.schema.json` (`AgentHostConfig`, 00 §4). Files carry canonical YAML
 * (`toCanonicalYaml`) for a byte-identical result (REQ-CFG-04/DET-01).
 *
 * @param model - The validated estate.
 * @returns One `RenderedFile` per managed-linux host; no findings (no credentials on this path).
 */
export function emitAgent(model: EstateModel): EmitResult {
  const files: EmitResult["files"] = [];
  for (const host of model.hosts) {
    if (host.collectionClass !== "managed-linux") continue; // MANAGED-LINUX ONLY (V-001)
    files.push({
      path: `agent/${host.name}.yaml`,
      contents: toCanonicalYaml(agentHostConfig(host)),
    });
  }
  // Sorted by the pipeline's single `compareString` on `path` (render/index.ts step 3); the local
  // sort here is redundant but harmless. Findings empty — this path carries no credential.
  files.sort((a, b) => compareString(a.path, b.path));
  return { files, findings: [] };
}

/** Build the `AgentHostConfig` value for one managed-linux host (00 §4). `cadvisor` and
 *  `heartbeat` are each emitted as a top-level boolean gate PLUS a scrape port present IFF the
 *  host opted in (REQ-CONT-01 / issue #30/#33) — symmetric, so deploy-toolkit reads one boolean
 *  per bundle member. The exactOptionalPropertyTypes spread keeps `rendered/agent/<host>.yaml`
 *  honest about what the host actually runs. node (:9100) is always present. */
function agentHostConfig(host: Extract<Host, { collectionClass: "managed-linux" }>) {
  return {
    host: host.name,
    deliveryForm: host.deliveryForm, // ECR field (REQ-BUNDLE-02)
    cadvisor: host.cadvisor, // ECR field (REQ-CONT-01)
    heartbeat: host.heartbeat, // ECR field (issue #30/#33)
    scrapePorts: {
      node: NODE_EXPORTER_PORT,
      ...(host.cadvisor ? { cadvisor: CADVISOR_PORT } : {}),
      ...(host.heartbeat ? { heartbeat: HEARTBEAT_PORT } : {}),
    },
  };
}
