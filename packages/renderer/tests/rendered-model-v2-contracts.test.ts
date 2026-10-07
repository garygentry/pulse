// packages/renderer/tests/rendered-model-v2-contracts.test.ts
//
// Type-contract tests for the rendered-model-v2 shared surface frozen in item 001. These
// prove the v2 model/artifact/result/path contracts compile and are re-exported from the
// @pulse/renderer barrel (`src/index.ts`). After the item-010 cutover `render` emits the
// coordinated v2 web bundle and returns the discriminated `RenderResult` union (asserted below).
import { describe, expect, test } from "bun:test";

import { makeModel } from "./factories.js";
import {
  WEB_ARTIFACT_PATHS,
  render,
  type BundleId,
  type RenderInputs,
  type UnstampedWebPayloads,
  type WebArtifactPath,
  type WebArtifactPayloads,
  type WebChannel,
  type WebCoverageArtifact,
  type WebCredentialReference,
  type WebEstateHostV2,
  type WebEstateModel,
  type WebEstateModelV2,
  type WebEstateServiceV2,
  type WebFindingsArtifact,
  type WebProjectionResult,
  type WebProvenance,
} from "../src/index.js";
import type { EstateModel, Finding } from "@pulse/core";

const BUNDLE_ID: BundleId = `sha256:${"a".repeat(64)}`;

const PROVENANCE: WebProvenance = { file: "estate.yaml", path: "hosts[0].name", line: 1, col: 1 };

describe("rendered-model-v2 path + identity contracts", () => {
  test("WEB_ARTIFACT_PATHS holds exactly the three sorted artifact names", () => {
    expect([...WEB_ARTIFACT_PATHS]).toEqual([
      "web-coverage.json",
      "web-estate-model.json",
      "web-findings.json",
    ]);
  });

  test("WebArtifactPath is the union of the three fixed names", () => {
    const each: WebArtifactPath[] = [
      "web-coverage.json",
      "web-estate-model.json",
      "web-findings.json",
    ];
    expect(each).toHaveLength(3);
  });
});

describe("rendered-model-v2 model + artifact contracts compile from the barrel", () => {
  test("a full v2 model constructs with every discriminant and safe projection", () => {
    const managedHost: WebEstateHostV2 = {
      name: "app-01",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.1"],
      suppressed: null,
      drilldownId: "host:app-01",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: PROVENANCE,
      scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
      artifacts: ["scrape/file_sd/managed-linux.json"],
      detail: {
        exporterPorts: [9100],
        cadvisor: true,
        heartbeat: false,
        deliveryForm: "systemd",
        commandSignals: [
          {
            name: "disk",
            interval: "1m",
            command: "df -h",
            credential: null,
            output: "scalar",
            metric: "disk_free",
            upMetric: "disk_up",
          },
          { name: "custom", interval: "5m", command: "node exp.js", credential: null, output: "exposition" },
        ],
      },
    };
    const excludedHost: WebEstateHostV2 = {
      name: "old-01",
      collectionClass: "excluded",
      addresses: [],
      suppressed: { class: "excluded", rationale: "decommissioned" },
      drilldownId: "host:old-01",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: PROVENANCE,
      scrapeTargets: [],
      artifacts: [],
      detail: {},
    };
    const credential: WebCredentialReference = { kind: "env", display: "${API_TOKEN}" };
    const service: WebEstateServiceV2 = {
      name: "web",
      host: "app-01",
      managed: true,
      deepHealth: true,
      ingressUrl: "https://app.example",
      suppressed: null,
      drilldownId: "svc:app-01/web",
      kind: "http",
      provenance: PROVENANCE,
      gatusEndpoints: ["app-01-web"],
      artifacts: ["gatus/app-01-web.yaml"],
      deepHealthDetail: {
        endpoint: "https://app.example/health",
        metrics: ["status"],
        responseMapping: { status: "$.status" },
        alertExpression: "status == 1",
        hostLocal: true,
        credential,
      },
      backupFreshness: null,
      alerts: [{ type: "telegram", enabled: true }],
    };
    const channel: WebChannel = {
      name: "ops",
      kind: "telegram",
      credential,
      options: { chatId: "123" },
      provenance: PROVENANCE,
    };
    const model: WebEstateModelV2 = {
      formatVersion: 2,
      bundleId: BUNDLE_ID,
      estate: {
        name: "homelab",
        domains: ["example.com"],
        timezone: "UTC",
        dnsResolver: null,
        retention: null,
        schemaMajor: 1,
        deadman: { configured: true, kind: "plain" },
      },
      hosts: [managedHost, excludedHost],
      services: [service],
      channels: [channel],
      routingOverrides: [{ severity: "error", channels: ["ops"], provenance: PROVENANCE }],
      suppressions: [
        {
          target: "old-01",
          class: "excluded",
          rationale: "decommissioned",
          provenance: PROVENANCE,
          resolves: ["host:old-01"],
        },
      ],
    };

    expect(model.formatVersion).toBe(2);
    expect(model.hosts).toHaveLength(2);
    // The v2 model is a strict superset — bundleId ties all three artifacts together.
    const coverage: WebCoverageArtifact = {
      formatVersion: 2,
      bundleId: model.bundleId,
      covered: [],
      gaps: [],
      suppressed: [],
    };
    const findings: WebFindingsArtifact = {
      formatVersion: 2,
      bundleId: model.bundleId,
      findings: [],
    };
    const payloads: WebArtifactPayloads = { model, coverage, findings };
    expect(payloads.coverage.bundleId).toBe(payloads.model.bundleId);
    expect(payloads.findings.bundleId).toBe(payloads.model.bundleId);

    // UnstampedWebPayloads omits bundleId on every member (the framing input for hashing).
    const unstamped: UnstampedWebPayloads = {
      "web-estate-model.json": { ...structuredClone(model), bundleId: undefined } as never,
      "web-coverage.json": { ...structuredClone(coverage), bundleId: undefined } as never,
      "web-findings.json": { ...structuredClone(findings), bundleId: undefined } as never,
    };
    expect(Object.keys(unstamped).sort()).toEqual([...WEB_ARTIFACT_PATHS]);
  });

  test("WebProjectionResult<T> models both the ok and fatal branches", () => {
    const ok: WebProjectionResult<number> = { ok: true, value: 7, findings: [] };
    const fatal: WebProjectionResult<number> = { ok: false, findings: [] };
    expect(ok.ok && ok.value).toBe(7);
    expect(fatal.ok).toBe(false);
  });

  test("RenderInputs carries optional loader findings", () => {
    const loaderFindings: Finding[] = [];
    const inputs: RenderInputs = { findings: loaderFindings };
    expect(inputs.findings).toBe(loaderFindings);
  });
});

describe("render runtime after the item-010 cutover", () => {
  test("render returns the discriminated all-or-nothing RenderResult with the v2 tree", () => {
    const result = render(makeModel());
    // Item-010 RenderResult is a discriminated union on `ok`, not the old `{ tree, findings }`.
    expect(typeof result.ok).toBe("boolean");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful render");
    expect(Array.isArray(result.tree)).toBe(true);
    expect(Array.isArray(result.findings)).toBe(true);
    // The coordinated web emitter now writes all three v2 artifacts into the tree.
    const paths = new Set(result.tree.map((f) => f.path));
    expect(paths.has("web-estate-model.json")).toBe(true);
    expect(paths.has("web-coverage.json")).toBe(true);
    expect(paths.has("web-findings.json")).toBe(true);
  });
});
