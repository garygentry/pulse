/** merge.test.ts — content-based merge + provenance (03-loader-and-pipeline.md §4.5, 07 §3.1 merge).
 *
 *  Asserts: two files contributing different sections merge into one model; a duplicate host
 *  identity across files → exactly one DUPLICATE_IDENTITY naming BOTH locations; a second estate
 *  block → DUPLICATE_ESTATE; ProvenanceIndex.lookup resolves an element path to the originating
 *  file and a real line/col. */

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseYamlDocument } from "../src/loader/yaml.js";
import { mergeSources } from "../src/loader/merge.js";
import { FINDING_CODES } from "../src/findings/codes.js";

const MULTI = join(import.meta.dir, "fixtures", "multi-file");

/** Parse a fixture file under multi-file/ into a ParsedSource. */
function src(file: string) {
  return parseYamlDocument({ file, text: readFileSync(join(MULTI, file), "utf8") });
}

describe("mergeSources — content-based union across files", () => {
  test("two files contributing different sections merge into one content object", () => {
    // 00-estate.yaml → estate + hosts[shared-host]; 10-services.yaml → services + channels.
    const merged = mergeSources([src("00-estate.yaml"), src("10-services.yaml")]);
    expect(merged.findings).toHaveLength(0); // no collisions between these two
    expect(merged.content.estate).toBeDefined();
    expect(merged.content.hosts).toHaveLength(1);
    expect(merged.content.services).toHaveLength(1);
    expect(merged.content.channels).toHaveLength(1);
    // merged collections are plain insertion-ordered arrays (never Map/Set)
    expect(Array.isArray(merged.content.hosts)).toBe(true);
    expect(Array.isArray(merged.content.services)).toBe(true);
  });
});

describe("mergeSources — duplicate host identity across files", () => {
  test("yields exactly one DUPLICATE_IDENTITY naming BOTH locations", () => {
    // 00-estate.yaml and 20-more-hosts.yaml both declare `shared-host`.
    const merged = mergeSources([src("00-estate.yaml"), src("20-more-hosts.yaml")]);
    const dups = merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_IDENTITY);
    expect(dups).toHaveLength(1);
    const f = dups[0]!;
    expect(f.severity).toBe("error");
    // The message names BOTH the first and the redeclaring file location.
    expect(f.message).toContain("00-estate.yaml");
    expect(f.message).toContain("20-more-hosts.yaml");
    expect(f.message).toContain("shared-host");
    // First occurrence retained: exactly one merged host survives.
    expect(merged.content.hosts).toHaveLength(1);
  });
});

describe("mergeSources — duplicate host identity within one file", () => {
  test("two same-identity hosts in a single document → one DUPLICATE_IDENTITY naming both locations", () => {
    // A single source declaring `dup-host` twice — the same-file collision shape.
    const one = parseYamlDocument({
      file: "one.yaml",
      text:
        "hosts:\n" +
        "  - name: dup-host\n" +
        "    collection_class: managed-linux\n" +
        "    addresses:\n" +
        "      - 10.3.0.1\n" +
        "  - name: dup-host\n" +
        "    collection_class: probe-only\n" +
        "    addresses:\n" +
        "      - 10.3.0.2\n",
    });
    const merged = mergeSources([one]);
    const dups = merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_IDENTITY);
    expect(dups).toHaveLength(1);
    const f = dups[0]!;
    expect(f.severity).toBe("error");
    // Both locations name the same file at two distinct element paths.
    expect(f.message).toContain("one.yaml:hosts[0]");
    expect(f.message).toContain("one.yaml:hosts[1]");
    expect(f.message).toContain("dup-host");
    // First occurrence retained: exactly one merged host survives.
    expect(merged.content.hosts).toHaveLength(1);
  });
});

describe("mergeSources — second estate block", () => {
  test("a second estate block → exactly one DUPLICATE_ESTATE naming both locations", () => {
    const a = parseYamlDocument({ file: "a.yaml", text: "estate:\n  schema_version: 1\n  name: a\n" });
    const b = parseYamlDocument({ file: "b.yaml", text: "estate:\n  schema_version: 1\n  name: b\n" });
    const merged = mergeSources([a, b]);
    const dups = merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_ESTATE);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.message).toContain("a.yaml");
    expect(dups[0]!.message).toContain("b.yaml");
    // First estate wins.
    expect((merged.content.estate as { name: string }).name).toBe("a");
  });
});

// ── Layered overlays (issue #7) ─────────────────────────────────────────────────────────────────

/** Parse inline YAML text as one ParsedSource (fictional; no fixture file needed). */
function doc(file: string, text: string) {
  return parseYamlDocument({ file, text });
}

const HOST = (extra: string) =>
  `hosts:\n  - name: web-01\n    collection_class: managed-linux\n${extra}`;

describe("mergeSources — base + overlay deep-merge (issue #7)", () => {
  test("an overlay refines a base host by identity: overlay scalars win, arrays replace whole, base-only fields kept", () => {
    const base = doc(
      "00-base.generated.yaml",
      "layer: base\n" +
        HOST("    addresses:\n      - 10.0.0.4\n    exporter_ports:\n      - 9100\n    cadvisor: false\n"),
    );
    const overlay = doc(
      "10-monitoring.overlay.yaml",
      "layer: overlay\n" +
        HOST("    cadvisor: true\n    exporter_ports:\n      - 9100\n      - 9256\n    scrape_interval_class: fast\n"),
    );
    const merged = mergeSources([base, overlay]);
    expect(merged.findings).toHaveLength(0); // cross-layer → merge, NOT a duplicate
    expect(merged.content.hosts).toHaveLength(1);
    const host = merged.content.hosts[0] as Record<string, unknown>;
    expect(host.collection_class).toBe("managed-linux");
    expect(host.addresses).toEqual(["10.0.0.4"]); // base-only field retained
    expect(host.cadvisor).toBe(true); // overlay scalar wins
    expect(host.exporter_ports).toEqual([9100, 9256]); // overlay array replaces base whole
    expect(host.scrape_interval_class).toBe("fast"); // overlay-only field added
  });

  test("overlay wins regardless of read order (overlay file sorts BEFORE base file)", () => {
    const overlay = doc(
      "00-a.overlay.yaml",
      "layer: overlay\n" + HOST("    addresses:\n      - 10.0.0.9\n    cadvisor: true\n"),
    );
    const base = doc(
      "99-z.base.yaml",
      "layer: base\n" + HOST("    addresses:\n      - 10.0.0.4\n    cadvisor: false\n    exporter_ports:\n      - 9100\n"),
    );
    // Sorted read order puts the overlay first; the overlay must still win the scalar.
    const merged = mergeSources([overlay, base]);
    expect(merged.findings).toHaveLength(0);
    const host = merged.content.hosts[0] as Record<string, unknown>;
    expect(host.cadvisor).toBe(true); // overlay wins even when read first
    expect(host.addresses).toEqual(["10.0.0.9"]); // overlay array wins
    expect(host.exporter_ports).toEqual([9100]); // base-only field retained
  });

  test("an overlay may ADD a new identity absent from the base layer", () => {
    const base = doc("00-base.yaml", "layer: base\n" + HOST("    addresses:\n      - 10.0.0.4\n"));
    const overlay = doc(
      "10-extra.overlay.yaml",
      "layer: overlay\nhosts:\n  - name: edge-01\n    collection_class: probe-only\n    addresses:\n      - 10.0.0.9\n    probe:\n      kind: icmp\n      target: 10.0.0.9\n",
    );
    const merged = mergeSources([base, overlay]);
    expect(merged.findings).toHaveLength(0);
    expect(merged.content.hosts.map((h) => (h as { name: string }).name)).toEqual(["web-01", "edge-01"]);
  });

  test("nested objects merge recursively while the overlay wins the leaf", () => {
    const base = doc(
      "00-base.yaml",
      "layer: base\nservices:\n  - name: portal\n    host: web-01\n    kind: http\n    managed: true\n    deep_health:\n      endpoint: /healthz\n      alert_expression: up == 1\n      response_mapping:\n        status: $.status\n",
    );
    const overlay = doc(
      "10-ov.overlay.yaml",
      "layer: overlay\nservices:\n  - name: portal\n    host: web-01\n    kind: http\n    managed: true\n    deep_health:\n      alert_expression: up == 0\n",
    );
    const merged = mergeSources([base, overlay]);
    expect(merged.findings).toHaveLength(0);
    const dh = (merged.content.services[0] as { deep_health: Record<string, unknown> }).deep_health;
    expect(dh.endpoint).toBe("/healthz"); // base-only nested field retained
    expect(dh.alert_expression).toBe("up == 0"); // overlay leaf wins
    expect(dh.response_mapping).toEqual({ status: "$.status" }); // base-only nested object retained
  });
});

describe("mergeSources — same-layer duplicate still errors under layering (issue #7)", () => {
  test("two BASE files declaring the same identity → DUPLICATE_IDENTITY (overlays do not silence a same-layer dup)", () => {
    const a = doc("00-a.base.yaml", "layer: base\n" + HOST("    addresses:\n      - 10.0.0.1\n"));
    const b = doc("10-b.base.yaml", "layer: base\n" + HOST("    addresses:\n      - 10.0.0.2\n"));
    const merged = mergeSources([a, b]);
    const dups = merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_IDENTITY);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.message).toContain("00-a.base.yaml");
    expect(dups[0]!.message).toContain("10-b.base.yaml");
    expect(merged.content.hosts).toHaveLength(1); // first retained
  });

  test("two OVERLAY files declaring the same identity → DUPLICATE_IDENTITY", () => {
    const a = doc("00-a.overlay.yaml", "layer: overlay\n" + HOST("    cadvisor: true\n"));
    const b = doc("10-b.overlay.yaml", "layer: overlay\n" + HOST("    cadvisor: false\n"));
    const merged = mergeSources([a, b]);
    expect(merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_IDENTITY)).toHaveLength(1);
  });
});

describe("mergeSources — estate base+overlay (issue #7)", () => {
  test("an overlay estate refines the base estate; overlay scalars win, base-only fields kept", () => {
    const base = doc(
      "00-base.yaml",
      "layer: base\nestate:\n  schema_version: 1\n  name: ref\n  domains: [a.example]\n  timezone: UTC\n  deadman_hook: ${D}\n  retention: 3mo\n",
    );
    const overlay = doc("10-ov.overlay.yaml", "layer: overlay\nestate:\n  retention: 6mo\n");
    const merged = mergeSources([base, overlay]);
    expect(merged.findings).toHaveLength(0); // cross-layer estate merge, NOT DUPLICATE_ESTATE
    const estate = merged.content.estate as Record<string, unknown>;
    expect(estate.name).toBe("ref"); // base-only field retained
    expect(estate.schema_version).toBe(1); // base-only field retained
    expect(estate.retention).toBe("6mo"); // overlay scalar wins
  });

  test("a SAME-LAYER second estate block is still DUPLICATE_ESTATE", () => {
    const a = doc("00-a.base.yaml", "layer: base\nestate:\n  schema_version: 1\n  name: a\n");
    const b = doc("10-b.base.yaml", "layer: base\nestate:\n  schema_version: 1\n  name: b\n");
    const merged = mergeSources([a, b]);
    const dups = merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_ESTATE);
    expect(dups).toHaveLength(1);
    expect((merged.content.estate as { name: string }).name).toBe("a"); // first (base) retained
  });
});

describe("mergeSources — layer marker validation + default (issue #7)", () => {
  test("an unrecognized layer value → one INVALID_LAYER finding (treated as base)", () => {
    const merged = mergeSources([doc("bad.yaml", "layer: overlays\n" + HOST("    addresses:\n      - 10.0.0.1\n"))]);
    const bad = merged.findings.filter((f) => f.code === FINDING_CODES.INVALID_LAYER);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe("error");
    expect(bad[0]!.file).toBe("bad.yaml");
  });

  test("an absent layer defaults to base — an unmarked duplicate still errors (back-compat)", () => {
    const a = doc("00-a.yaml", HOST("    addresses:\n      - 10.0.0.1\n"));
    const b = doc("10-b.yaml", HOST("    addresses:\n      - 10.0.0.2\n"));
    const merged = mergeSources([a, b]);
    expect(merged.findings.filter((f) => f.code === FINDING_CODES.DUPLICATE_IDENTITY)).toHaveLength(1);
    expect(merged.findings.filter((f) => f.code === FINDING_CODES.INVALID_LAYER)).toHaveLength(0);
  });

  test("a base host and an overlay host under the same identity merge with a merged-provenance path", () => {
    const base = doc("00-base.yaml", "layer: base\n" + HOST("    addresses:\n      - 10.0.0.4\n"));
    const overlay = doc("10-ov.overlay.yaml", "layer: overlay\n" + HOST("    cadvisor: true\n"));
    const merged = mergeSources([base, overlay]);
    // The merged host is attributed to the overlay file (the hand-edited surface).
    const prov = merged.provenance.lookup("hosts[0].cadvisor");
    expect(prov.file).toBe("10-ov.overlay.yaml");
    expect(prov.line).toBeGreaterThan(0);
  });
});

describe("ProvenanceIndex.lookup — merged path → origin file + real line/col", () => {
  test("resolves a nested host field to its originating file and a 1-based line/col", () => {
    const merged = mergeSources([src("00-estate.yaml")]);
    const prov = merged.provenance.lookup("hosts[0].exporter_ports");
    expect(prov.file).toBe("00-estate.yaml"); // relative, never absolute
    expect(prov.line).toBeGreaterThan(0);
    expect(prov.col).toBeGreaterThan(0);
    expect(prov.path).toContain("hosts[0]");
  });

  test("a never-captured field falls back to its nearest present ancestor", () => {
    const merged = mergeSources([src("00-estate.yaml")]);
    const prov = merged.provenance.lookup("hosts[0].not_a_field");
    // Resolves to the host element's location rather than throwing.
    expect(prov.file).toBe("00-estate.yaml");
    expect(prov.line).toBeGreaterThan(0);
  });
});
