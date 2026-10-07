/** coverage.test.ts — computeCoverage() bucketing, suppression precedence, purity, determinism,
 *  and the golden↔coverage cross-check (03 §5, 07 §3.5; item 011).
 *
 *  - Bucketing: a non-suppressed unmonitored host/service lands in `gaps`; an `excluded` host and a
 *    `suppressed` service land in `suppressed` (with class+rationale) even with empty artifacts and
 *    NEVER in `gaps`; a monitored entity lands in `covered` with its artifact paths.
 *  - Suppression wins over the artifact test; `expectedChurn` is NOT a suppression (→ covered).
 *  - Purity: computeCoverage touches the filesystem zero times (no prior render needed, REQ-COV-03).
 *  - Determinism: all three buckets sorted by (name, kind); computing twice yields identical reports.
 *  - Golden↔coverage cross-check (multiclass): every covered artifact EXISTS in the rendered tree,
 *    and every per-entity artifact file is claimed by ≥1 covered entry (estate-scoped files exempt). */

import * as fs from "node:fs";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { EstateModel, Host } from "@pulse/core";

import { computeCoverage, computeCoverageFromIndex } from "../src/coverage.js";
import type { CoverageEntry } from "../src/coverage.js";
import { MANIFEST_FILENAME } from "../src/manifest.js";
import { buildArtifactIndex } from "../src/render/artifact-index.js";
import { render } from "../src/render/index.js";
import { makeHost, makeModel, makeService } from "./factories.js";
import { multiclassModel } from "./fixtures/multiclass/model.js";

/** Find the (single) entry for `name` in a bucket, or undefined. */
function entryFor(bucket: CoverageEntry[], name: string): CoverageEntry | undefined {
  return bucket.find((e) => e.name === name);
}

describe("computeCoverage() bucketing (REQ-COV-01/02)", () => {
  test("a managed service with no ingress/deep-health/backup-freshness lands in gaps", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [makeService({ name: "bare", host: "web01" })],
    });
    const report = computeCoverage(model);
    const gap = entryFor(report.gaps, "web01/bare");
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe("service");
    expect(gap!.artifacts).toEqual([]);
    expect(gap!.suppressed).toBeNull();
    // A covered host and a gap service are disjoint buckets.
    expect(entryFor(report.covered, "web01/bare")).toBeUndefined();
    expect(entryFor(report.suppressed, "web01/bare")).toBeUndefined();
  });

  test("a non-suppressed host mapping to no artifact lands in gaps", () => {
    // No VALID v1 class yields an unsuppressed zero-artifact host (excluded is always suppressed),
    // so exercise the host gap-routing path with a forward-compat/unknown class (maps to []).
    const orphan = { ...makeHost("managed-linux", { name: "ghost" }), collectionClass: "future" };
    const model = makeModel({ hosts: [orphan as unknown as Host] });
    const report = computeCoverage(model);
    const gap = entryFor(report.gaps, "ghost");
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe("host");
    expect(gap!.artifacts).toEqual([]);
    expect(gap!.suppressed).toBeNull();
  });

  test("an excluded host lands in suppressed with class+rationale and empty artifacts", () => {
    const model = makeModel({
      hosts: [
        makeHost("excluded", {
          name: "old01",
          suppressed: { class: "excluded", rationale: "decommissioned" },
        }),
      ],
    });
    const report = computeCoverage(model);
    const supp = entryFor(report.suppressed, "old01");
    expect(supp).toBeDefined();
    expect(supp!.kind).toBe("host");
    expect(supp!.artifacts).toEqual([]);
    expect(supp!.suppressed).toEqual({ class: "excluded", rationale: "decommissioned" });
    // NEVER a gap, even though the artifact list is empty (REQ-COV-02).
    expect(entryFor(report.gaps, "old01")).toBeUndefined();
  });

  test("a suppressed service lands in suppressed with class+rationale, never in gaps", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [
        makeService({
          name: "staging",
          host: "web01",
          suppressed: { class: "known-expected", rationale: "flaky staging box" },
        }),
      ],
    });
    const report = computeCoverage(model);
    const supp = entryFor(report.suppressed, "web01/staging");
    expect(supp).toBeDefined();
    expect(supp!.kind).toBe("service");
    expect(supp!.artifacts).toEqual([]);
    expect(supp!.suppressed).toEqual({ class: "known-expected", rationale: "flaky staging box" });
    expect(entryFor(report.gaps, "web01/staging")).toBeUndefined();
  });

  test("suppression wins over the artifact test (a monitored-but-suppressed service → suppressed)", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [
        makeService({
          name: "grafana",
          host: "web01",
          ingressUrl: "https://grafana.example.com", // would otherwise be covered
          suppressed: { class: "known-expected", rationale: "temporarily muted" },
        }),
      ],
    });
    const report = computeCoverage(model);
    expect(entryFor(report.suppressed, "web01/grafana")).toBeDefined();
    // Suppression changes the bucket, NOT relationship truth: the entry RETAINS its real artifacts
    // (the ingress → gatus/config.yaml edge) while staying out of both covered and gaps (04 §3.2,
    // REQ-COV-04).
    expect(entryFor(report.suppressed, "web01/grafana")!.artifacts).toEqual(["gatus/config.yaml"]);
    expect(entryFor(report.covered, "web01/grafana")).toBeUndefined();
    expect(entryFor(report.gaps, "web01/grafana")).toBeUndefined();
  });

  test("a suppressed entity retains the SAME artifacts as the shared index (never cleared)", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [
        makeService({
          name: "grafana",
          host: "web01",
          ingressUrl: "https://grafana.example.com",
          deepHealth: { endpoint: "https://web01/health", responseMapping: { up: "$.up" }, alertExpression: "up == 1" },
          suppressed: { class: "known-expected", rationale: "muted" },
        }),
      ],
    });
    const supp = entryFor(computeCoverage(model).suppressed, "web01/grafana");
    expect(supp).toBeDefined();
    // Identical to the model's index relationships — suppression never empties them (REQ-COV-04).
    expect(supp!.artifacts).toEqual(buildArtifactIndex(model).services.get("web01/grafana")!.artifacts);
    expect(supp!.artifacts).toEqual(["gatus/config.yaml", "prober/config.yaml"]);
  });

  test("a standalone suppression (bare name and composite id) suppresses a service", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [makeService({ name: "bare", host: "web01" })],
      suppressions: [
        { target: "web01/bare", class: "known-expected", rationale: "expected", provenance: makeService().provenance },
      ],
    });
    expect(entryFor(computeCoverage(model).suppressed, "web01/bare")).toBeDefined();
    // Also resolves on the bare service name.
    const byBare = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" })],
      services: [makeService({ name: "bare", host: "web01" })],
      suppressions: [
        { target: "bare", class: "known-expected", rationale: "expected", provenance: makeService().provenance },
      ],
    });
    expect(entryFor(computeCoverage(byBare).suppressed, "web01/bare")).toBeDefined();
  });

  test("a monitored host is covered with the artifact index's paths", () => {
    const model = makeModel({ hosts: [makeHost("managed-linux", { name: "web01" })] });
    const report = computeCoverage(model);
    const covered = entryFor(report.covered, "web01");
    expect(covered).toBeDefined();
    expect(covered!.kind).toBe("host");
    expect(covered!.collectionClass).toBe("managed-linux");
    // Artifacts come straight from the SHARED index — never re-derived (REQ-COV-03).
    expect(covered!.artifacts).toEqual(buildArtifactIndex(model).hosts.get("web01")!.artifacts);
    expect(covered!.suppressed).toBeNull();
  });

  test("an expectedChurn host is covered, NOT suppressed", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "churny", expectedChurn: true })],
    });
    const report = computeCoverage(model);
    expect(entryFor(report.covered, "churny")).toBeDefined();
    expect(entryFor(report.suppressed, "churny")).toBeUndefined();
    expect(entryFor(report.gaps, "churny")).toBeUndefined();
  });

  test("a service's class is its owning host's class", () => {
    const model = makeModel({
      hosts: [makeHost("nas-api", { name: "nas1" })],
      services: [makeService({ name: "vol", host: "nas1", ingressUrl: "https://nas1/health" })],
    });
    const covered = entryFor(computeCoverage(model).covered, "nas1/vol");
    expect(covered!.collectionClass).toBe("nas-api");
  });
});

describe("computeCoverage() purity (REQ-COV-03)", () => {
  afterEach(() => {
    // Nothing to restore beyond the spies created per-test (restored inline).
  });

  test("runs on a never-rendered model and touches the filesystem zero times", () => {
    const spies = [
      spyOn(fs, "readFileSync"),
      spyOn(fs, "writeFileSync"),
      spyOn(fs, "existsSync"),
      spyOn(fs, "statSync"),
      spyOn(fs, "readdirSync"),
      spyOn(fs, "mkdirSync"),
    ];
    try {
      computeCoverage(multiclassModel);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("computeCoverage() determinism (REQ-DET-01)", () => {
  test("all three buckets are sorted by (name, kind)", () => {
    // Scramble insertion order across every bucket.
    const model = makeModel({
      hosts: [
        makeHost("managed-linux", { name: "zeta" }),
        makeHost("managed-linux", { name: "alpha" }),
        makeHost("excluded", { name: "yankee", suppressed: { class: "excluded", rationale: "x" } }),
        makeHost("excluded", { name: "bravo", suppressed: { class: "excluded", rationale: "x" } }),
      ],
      services: [
        makeService({ name: "svcZ", host: "zeta" }), // gap
        makeService({ name: "svcA", host: "alpha" }), // gap
      ],
    });
    const report = computeCoverage(model);
    const sorted = (b: CoverageEntry[]): string[] => b.map((e) => e.name);
    for (const bucket of [report.covered, report.gaps, report.suppressed]) {
      const names = sorted(bucket);
      expect(names).toEqual([...names].sort());
    }
    expect(sorted(report.covered)).toEqual(["alpha", "zeta"]);
    expect(sorted(report.gaps)).toEqual(["alpha/svcA", "zeta/svcZ"]);
    expect(sorted(report.suppressed)).toEqual(["bravo", "yankee"]);
  });

  test("computing the same model twice yields identical reports", () => {
    expect(computeCoverage(multiclassModel)).toEqual(computeCoverage(multiclassModel));
  });
});

describe("computeCoverageFromIndex + exhaustiveness (04 §3.2)", () => {
  test("computeCoverage delegates to the shared index; supplied-index path yields the same report", () => {
    const model = makeModel({
      hosts: [makeHost("managed-linux", { name: "web01" }), makeHost("nas-api", { name: "nas1" })],
      services: [
        makeService({ name: "grafana", host: "web01", ingressUrl: "https://g" }),
        makeService({ name: "bare", host: "web01" }),
      ],
    });
    const index = buildArtifactIndex(model);
    expect(computeCoverageFromIndex(model, index)).toEqual(computeCoverage(model));
  });

  test("computeCoverageFromIndex copies the index arrays (later mutation cannot corrupt the index)", () => {
    const model = makeModel({ hosts: [makeHost("managed-linux", { name: "web01" })] });
    const index = buildArtifactIndex(model);
    const before = [...index.hosts.get("web01")!.artifacts];
    const report = computeCoverageFromIndex(model, index);
    report.covered[0]!.artifacts.push("mutated");
    expect(index.hosts.get("web01")!.artifacts).toEqual(before);
  });

  test("every host and service appears in exactly one of covered/gaps/suppressed", () => {
    const model = makeModel({
      hosts: [
        makeHost("managed-linux", { name: "web01" }), // covered
        makeHost("excluded", { name: "old01", suppressed: { class: "excluded", rationale: "gone" } }), // suppressed
      ],
      services: [
        makeService({ name: "grafana", host: "web01", ingressUrl: "https://g" }), // covered
        makeService({ name: "bare", host: "web01" }), // gap
        makeService({ name: "muted", host: "web01", suppressed: { class: "known-expected", rationale: "x" } }), // suppressed
      ],
    });
    const report = computeCoverage(model);
    const names = [...report.covered, ...report.gaps, ...report.suppressed].map((e) => e.name);
    const expected = ["web01", "old01", "web01/grafana", "web01/bare", "web01/muted"];
    expect(names.slice().sort()).toEqual(expected.slice().sort());
    // Exactly once each: no entity appears in two buckets.
    expect(new Set(names).size).toBe(expected.length);
    expect(names.length).toBe(expected.length);
  });

  test("a service whose owner host is undeclared is an invariant failure, not an `excluded` fallback", () => {
    const model = makeModel({ services: [makeService({ name: "orphan", host: "ghosthost" })] });
    expect(() => computeCoverage(model)).toThrow();
  });
});

describe("golden↔coverage cross-check (multiclass, 07 §3.5)", () => {
  // Estate-scoped artifacts are NOT entity edges: they are never claimed by a coverage entry.
  // DNS-only gatus endpoints are also estate-scoped, but multiclass's gatus/config.yaml also
  // carries service + probe endpoints, so it IS claimed by ≥1 covered entry here.
  const ESTATE_SCOPED = new Set([
    "alertmanager/routing.yaml",
    // The coordinated v2 web bundle artifacts are estate-scoped, not per-entity edges.
    "web-estate-model.json",
    "web-coverage.json",
    "web-findings.json",
    MANIFEST_FILENAME,
  ]);

  const model: EstateModel = multiclassModel;
  const renderedPaths = new Set(render(model).tree.map((f) => f.path));
  const report = computeCoverage(model);
  const claimed = new Set(report.covered.flatMap((e) => e.artifacts));

  test("(A) every covered entry's artifact path exists in the rendered golden tree", () => {
    for (const entry of report.covered) {
      expect(entry.artifacts.length).toBeGreaterThan(0);
      for (const path of entry.artifacts) {
        expect(renderedPaths.has(path)).toBe(true);
      }
    }
  });

  test("(B) every per-entity artifact file is claimed by ≥1 covered entry", () => {
    for (const path of renderedPaths) {
      if (ESTATE_SCOPED.has(path)) continue; // estate-scoped artifacts are exempt
      expect(claimed.has(path)).toBe(true);
    }
  });
});
