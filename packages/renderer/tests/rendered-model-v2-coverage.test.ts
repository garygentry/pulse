/** rendered-model-v2-coverage.test.ts — coordinated coverage over the shared relationship index
 *  (04 §§3.1–3.2, 08 §§6.1, 8.3).
 *
 *  Proves the coordinated web emitter derives model AND coverage from ONE `ArtifactIndex`, so every
 *  entity's relationships agree exactly: each declared entity appears in exactly one covered/gaps/
 *  suppressed bucket; suppression selects `suppressed` without erasing relationships; a service's
 *  class equals its owner host's class; a coverage entry's artifacts equal both the model entity's
 *  artifacts and the raw `buildArtifactIndex` facts (never a filename guess); scrape/Gatus identities
 *  equal the emitter facts; standalone `computeCoverage(model)` agrees with the coordinated payload;
 *  and an empty estate yields three empty buckets. */

import { describe, expect, test } from "bun:test";

import type { EstateModel } from "@pulse/core";

import { buildWebArtifactPayloads } from "../src/render/web-artifacts.js";
import { buildArtifactIndex } from "../src/render/artifact-index.js";
import { computeCoverage, computeCoverageFromIndex } from "../src/coverage.js";
import type { CoverageEntry, CoverageReport } from "../src/coverage.js";
import { PROV, makeModel, makeV2Host, makeV2Service } from "./factories.js";

/** A mixed estate exercising every coverage outcome that is constructible from valid host classes:
 *  a covered host and service, a gap service, an excluded (suppressed, artifact-free) host, a
 *  standalone-suppressed host that RETAINS its scrape artifacts, and an in-target-suppressed service
 *  that RETAINS its ingress artifact. */
function mixedModel(overrides: Partial<EstateModel> = {}): EstateModel {
  return makeModel({
    hosts: [
      makeV2Host("managed-linux", { name: "web01", addresses: ["10.0.0.10"] }),
      makeV2Host("hypervisor-api", { name: "hv01", addresses: ["10.0.0.11"] }),
      makeV2Host("excluded", { name: "old01", addresses: ["10.0.0.12"] }),
    ],
    services: [
      makeV2Service({ name: "api", host: "web01", ingressUrl: "https://api.example.com" }),
      makeV2Service({ name: "bare", host: "web01" }),
      makeV2Service({
        name: "muted",
        host: "web01",
        ingressUrl: "https://muted.example.com",
        suppressed: { class: "known-expected", rationale: "maintenance window" },
      }),
    ],
    suppressions: [
      { class: "known-expected", rationale: "decommissioning rack", target: "hv01", provenance: PROV },
    ],
    ...overrides,
  });
}

/** Run the coordinated transaction and return its stamped model + coverage payloads. */
function coordinated(model: EstateModel) {
  const result = buildWebArtifactPayloads(model);
  if (!result.ok) {
    throw new Error(`expected a successful projection: ${JSON.stringify(result.findings)}`);
  }
  return result.value;
}

function entryFor(bucket: CoverageEntry[], name: string): CoverageEntry | undefined {
  return bucket.find((e) => e.name === name);
}

function allEntries(report: CoverageReport): CoverageEntry[] {
  return [...report.covered, ...report.gaps, ...report.suppressed];
}

// ---------------------------------------------------------------------------

describe("one shared index drives both model and coverage (AC1)", () => {
  test("every host/service coverage artifact array equals the model entity and the raw index", () => {
    const model = mixedModel();
    const { model: webModel, coverage } = coordinated(model);
    const index = buildArtifactIndex(model);

    for (const host of webModel.hosts) {
      const cov = entryFor(allEntries(coverage), host.name);
      expect(cov).toBeDefined();
      // model artifacts === coverage artifacts === raw index facts (single shared index).
      expect(cov!.artifacts).toEqual(host.artifacts);
      expect(cov!.artifacts).toEqual(index.hosts.get(host.name)!.artifacts);
      // scrape identities are emitter facts, not filename guesses.
      expect(host.scrapeTargets).toEqual(index.hosts.get(host.name)!.scrapeTargets);
    }

    for (const svc of webModel.services) {
      const id = `${svc.host}/${svc.name}`;
      const cov = entryFor(allEntries(coverage), id);
      expect(cov).toBeDefined();
      expect(cov!.artifacts).toEqual(svc.artifacts);
      expect(cov!.artifacts).toEqual(index.services.get(id)!.artifacts);
      expect(svc.gatusEndpoints).toEqual(index.services.get(id)!.gatusEndpoints);
    }
  });

  test("a service coverage entry inherits its owning host's collection class", () => {
    const { coverage } = coordinated(mixedModel());
    expect(entryFor(coverage.covered, "web01/api")!.collectionClass).toBe("managed-linux");
  });
});

describe("exhaustive, disjoint buckets (REQ-COV-01/02)", () => {
  test("each declared entity occurs exactly once across covered/gaps/suppressed", () => {
    const model = mixedModel();
    const { coverage } = coordinated(model);
    const names = allEntries(coverage).map((e) => e.name);
    const expected = [
      "web01",
      "hv01",
      "old01",
      "web01/api",
      "web01/bare",
      "web01/muted",
    ];
    expect(names.length).toBe(expected.length);
    expect(new Set(names).size).toBe(expected.length);
    for (const name of expected) expect(names).toContain(name);
  });

  test("the coordinated buckets place each entity as expected", () => {
    const { coverage } = coordinated(mixedModel());
    expect(entryFor(coverage.covered, "web01")).toBeDefined();
    expect(entryFor(coverage.covered, "web01/api")).toBeDefined();
    expect(entryFor(coverage.gaps, "web01/bare")).toBeDefined();
    expect(entryFor(coverage.suppressed, "hv01")).toBeDefined();
    expect(entryFor(coverage.suppressed, "old01")).toBeDefined();
    expect(entryFor(coverage.suppressed, "web01/muted")).toBeDefined();
  });
});

describe("suppression selects the bucket, not relationship truth (REQ-COV-03/04)", () => {
  test("a standalone-suppressed host retains its real scrape artifacts", () => {
    const model = mixedModel();
    const { coverage } = coordinated(model);
    const index = buildArtifactIndex(model);
    const hv01 = entryFor(coverage.suppressed, "hv01")!;
    expect(hv01.suppressed).toEqual({ class: "known-expected", rationale: "decommissioning rack" });
    expect(hv01.artifacts).toEqual(index.hosts.get("hv01")!.artifacts);
    expect(hv01.artifacts.length).toBeGreaterThan(0);
  });

  test("an in-target-suppressed service retains its real ingress artifact", () => {
    const muted = entryFor(coordinated(mixedModel()).coverage.suppressed, "web01/muted")!;
    expect(muted.suppressed).toEqual({ class: "known-expected", rationale: "maintenance window" });
    expect(muted.artifacts).toEqual(["gatus/config.yaml"]);
  });

  test("an excluded host stays in suppressed with empty artifacts, never a gap", () => {
    const { coverage } = coordinated(mixedModel());
    const old01 = entryFor(coverage.suppressed, "old01")!;
    expect(old01.artifacts).toEqual([]);
    expect(entryFor(coverage.gaps, "old01")).toBeUndefined();
  });
});

describe("standalone and coordinated coverage agree (REQ-COV-05)", () => {
  test("computeCoverage(model) equals the coordinated payload buckets", () => {
    const model = mixedModel();
    const { coverage } = coordinated(model);
    const standalone = computeCoverage(model);
    expect(coverage.covered).toEqual(standalone.covered);
    expect(coverage.gaps).toEqual(standalone.gaps);
    expect(coverage.suppressed).toEqual(standalone.suppressed);
  });

  test("computeCoverage delegates through a freshly built index equal to the supplied one", () => {
    const model = mixedModel();
    const fromSupplied = computeCoverageFromIndex(model, buildArtifactIndex(model));
    expect(computeCoverage(model)).toEqual(fromSupplied);
  });
});

describe("gap routing and empty estate (REQ-COV-01/06)", () => {
  test("a non-suppressed unknown-class host routes to gaps with empty artifacts", () => {
    // No VALID class yields an unsuppressed zero-artifact host; exercise the routing with a
    // forward-compat class (coverage tolerates it; the strict v2 projection would reject it).
    const orphan = { ...makeV2Host("managed-linux", { name: "ghost" }), collectionClass: "future" };
    const model = makeModel({ hosts: [orphan as unknown as EstateModel["hosts"][number]] });
    const gap = entryFor(computeCoverage(model).gaps, "ghost");
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe("host");
    expect(gap!.artifacts).toEqual([]);
    expect(gap!.suppressed).toBeNull();
  });

  test("an empty estate produces three empty coordinated coverage buckets", () => {
    const { coverage } = coordinated(makeModel({}));
    expect(coverage.covered).toEqual([]);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.suppressed).toEqual([]);
    expect(coverage.formatVersion).toBe(2);
  });
});
