// stack/alerting/tests/contract-artifacts.test.ts
// Tier-A self-check for the two published contract artifacts under stack/alerting/contract/
// (authored per 05-contracts-and-integration.md §3/§4). Focused scope: assert
// severity-taxonomy.json mirrors SEVERITY_TAXONOMY / SEVERITY_TAXONOMY_VERSION from src/taxonomy.ts
// (severities, order, contractVersion, every routing field), that `deadman` never appears in the
// artifact (REQ-DEAD-03), and that webhook-event.schema.json parses as valid JSON and declares the
// draft 2020-12 $schema (05 §4.2). The full tri-view conformance (json⇄taxonomy.ts⇄.md) and the
// webhook payload-fixture validation live in items 012/013.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITY_TAXONOMY, SEVERITY_TAXONOMY_VERSION } from "../src/taxonomy.js";

const CONTRACT_DIR = join(import.meta.dir, "..", "contract");

interface TaxonomyRouting {
  channels: string;
  repeatInterval: string | null;
  groupWindow: string | null;
  bypassesQuietHours: boolean;
  sendsResolved: boolean;
}
interface TaxonomySeverity {
  name: string;
  response: string;
  routing: TaxonomyRouting;
}
interface TaxonomyArtifact {
  contractVersion: number;
  severities: TaxonomySeverity[];
  webhookMirror: Record<string, string>;
}

const TAXONOMY_RAW = readFileSync(join(CONTRACT_DIR, "severity-taxonomy.json"), "utf8");
const TAXONOMY = JSON.parse(TAXONOMY_RAW) as TaxonomyArtifact;

describe("contract/severity-taxonomy.json — mirrors src/taxonomy.ts (05 §3.1)", () => {
  test("contractVersion === SEVERITY_TAXONOMY_VERSION === 1", () => {
    expect(TAXONOMY.contractVersion).toBe(SEVERITY_TAXONOMY_VERSION);
    expect(TAXONOMY.contractVersion).toBe(1);
  });

  test("severity names and order equal SEVERITY_TAXONOMY (critical→warning→info)", () => {
    const jsonNames = TAXONOMY.severities.map((s) => s.name);
    const tsNames = SEVERITY_TAXONOMY.map((s) => s.name);
    expect(jsonNames).toEqual(["critical", "warning", "info"]);
    expect(jsonNames).toEqual(tsNames);
  });

  test("every severity's response + routing fields agree with SEVERITY_TAXONOMY", () => {
    for (const def of SEVERITY_TAXONOMY) {
      const artifact = TAXONOMY.severities.find((s) => s.name === def.name);
      expect(artifact, `severity ${def.name} missing from artifact`).toBeDefined();
      const s = artifact!;
      expect(s.response).toBe(def.response);
      expect(s.routing.channels).toBe(def.channels);
      expect(s.routing.repeatInterval).toBe(def.repeatInterval);
      expect(s.routing.groupWindow).toBe(def.groupWindow);
      expect(s.routing.bypassesQuietHours).toBe(def.bypassesQuietHours);
      expect(s.routing.sendsResolved).toBe(def.sendsResolved);
    }
  });

  test("webhookMirror map mirrors SEVERITY_TAXONOMY (critical:always, warning:if-selected, info:never)", () => {
    expect(TAXONOMY.webhookMirror).toEqual({
      critical: "always",
      warning: "if-selected",
      info: "never",
    });
    for (const def of SEVERITY_TAXONOMY) {
      expect(TAXONOMY.webhookMirror[def.name]).toBe(def.webhookMirror);
    }
  });

  test("`deadman` never appears in the taxonomy artifact (REQ-DEAD-03)", () => {
    expect(TAXONOMY.severities.some((s) => s.name === "deadman")).toBe(false);
    expect(Object.keys(TAXONOMY.webhookMirror)).not.toContain("deadman");
    expect(TAXONOMY_RAW.includes("deadman")).toBe(false);
  });
});

describe("contract/webhook-event.schema.json — valid JSON Schema (05 §4.2)", () => {
  const RAW = readFileSync(join(CONTRACT_DIR, "webhook-event.schema.json"), "utf8");

  test("parses as valid JSON and declares the draft 2020-12 $schema", () => {
    const schema = JSON.parse(RAW) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://pulse.dev/contracts/alerting/webhook-event.schema.json");
    expect(schema.additionalProperties).toBe(true);
    expect(schema.required).toEqual(["version", "status", "groupKey", "commonLabels", "alerts"]);
  });
});
