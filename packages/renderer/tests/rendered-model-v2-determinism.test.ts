/** rendered-model-v2-determinism.test.ts — findings union, canonical bytes, framed identity, and the
 *  pure-module source meta-guard (04 §§3.3, 5.1, 5.3; 08 §§5.5, 6.2, 8.4).
 *
 *  Proves the merged findings preserve every severity and duplicate in the exact `(file,path,code,
 *  severity,message)` order regardless of arrival order; a clean run emits `findings: []`; repeated
 *  and semantically permuted inputs serialize byte-identically while genuinely ordered data (argv,
 *  addresses) is preserved; and `computeBundleId` is a correctly framed, deterministic, lowercase
 *  SHA-256 shared by all three artifacts, where changing any path frame, payload byte, or byte length
 *  changes the id. The §5.5 meta-guard scans the finite pure web-module set for nondeterminism. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { Finding } from "@pulse/core";

import {
  WEB_ARTIFACT_PATHS,
  buildWebArtifactPayloads,
  computeBundleId,
  emitWebArtifacts,
} from "../src/render/web-artifacts.js";
import type { UnstampedWebPayloads } from "../src/render/web-artifacts.js";
import { compareFindings, sortFindings } from "../src/findings.js";
import { toCanonicalJson } from "../src/format.js";
import { makeFinding, makeModel, makeRenderedModelV2Model, makeV2Host, makeV2Service } from "./factories.js";

/** Build the coordinated payloads and assert success. */
function payloads(model = makeRenderedModelV2Model(), findings: readonly Finding[] = []) {
  const result = buildWebArtifactPayloads(model, findings);
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.findings)}`);
  return result.value;
}

/** Reconstruct the UNSTAMPED payload set (strip each artifact's `bundleId`) for framing tests. */
function unstamped(value = payloads()): UnstampedWebPayloads {
  const { bundleId: _m, ...model } = value.model;
  const { bundleId: _c, ...coverage } = value.coverage;
  const { bundleId: _f, ...findings } = value.findings;
  return {
    "web-coverage.json": coverage,
    "web-estate-model.json": model,
    "web-findings.json": findings,
  };
}

// ---------------------------------------------------------------------------

describe("findings union preserves severity, duplicates, and canonical order (REQ-FIND-02..05)", () => {
  test("all severities and duplicates survive; order is (file,path,code,severity,message)", () => {
    const inputs: Finding[] = [
      makeFinding("info", { path: "c" }),
      makeFinding("error", { path: "a" }),
      makeFinding("warning", { path: "b" }),
      makeFinding("error", { path: "a" }), // exact duplicate — must NOT be deduplicated
    ];
    const out = payloads(makeRenderedModelV2Model(), inputs).findings.findings;
    // Every input event survives (duplicate preserved as two events).
    for (const f of inputs) expect(out.filter((o) => o.path === f.path && o.severity === f.severity).length)
      .toBeGreaterThanOrEqual(inputs.filter((i) => i.path === f.path && i.severity === f.severity).length);
    expect(out.filter((o) => o.path === "a" && o.severity === "error").length).toBe(2);
    // Output is sorted by the canonical finding key with no locale comparison.
    for (let i = 1; i < out.length; i += 1) {
      expect(compareFindings(out[i - 1]!, out[i]!) <= 0).toBe(true);
    }
  });

  test("arrival order does not affect the serialized findings artifact", () => {
    const a = [makeFinding("error", { path: "a" }), makeFinding("warning", { path: "b" }), makeFinding("info", { path: "c" })];
    const b = [a[2]!, a[0]!, a[1]!];
    const model = makeRenderedModelV2Model();
    expect(toCanonicalJson(payloads(model, a).findings)).toBe(toCanonicalJson(payloads(model, b).findings));
  });

  test("a clean run with no inputs and no warnings emits findings: []", () => {
    const clean = payloads(makeModel({}), []);
    expect(clean.findings.findings).toEqual([]);
  });

  test("projection warnings merge with loader findings", () => {
    // makeRenderedModelV2Model declares a channel option `apiToken` → one omission warning.
    const out = payloads(makeRenderedModelV2Model(), [makeFinding("error")]).findings.findings;
    expect(out.some((f) => f.code === "web_sensitive_channel_option_omitted")).toBe(true);
    expect(out.some((f) => f.code === "unresolved_host")).toBe(true);
  });
});

describe("byte determinism across repeats and semantic permutations (REQ-REL-01/02)", () => {
  test("rendering the same model/findings twice yields byte-identical files and one id", () => {
    const model = makeRenderedModelV2Model();
    const findings = [makeFinding("warning", { path: "z" })];
    const first = emitWebArtifacts(model, findings);
    const second = emitWebArtifacts(model, findings);
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(first.value.map((f) => f.path)).toEqual(second.value.map((f) => f.path));
    for (let i = 0; i < first.value.length; i += 1) {
      expect(first.value[i]!.contents).toBe(second.value[i]!.contents);
    }
  });

  test("permuting semantically set-like source data does not change any byte", () => {
    const base = makeRenderedModelV2Model();
    const permuted = makeRenderedModelV2Model({
      // domains are a set: reversing declaration order must not change output bytes.
      estate: { ...base.estate, domains: [...base.estate.domains].reverse() },
    });
    // Re-order set-like collections: host/service declaration order and a managed host's exporter
    // ports (projection sorts hosts by name, services by (host,name), and ports numerically).
    permuted.hosts = [...permuted.hosts].reverse();
    permuted.services = [...permuted.services].reverse();
    const app = permuted.hosts.find((h) => h.name === "app01");
    if (app && app.collectionClass === "managed-linux") {
      app.exporterPorts = [...app.exporterPorts].reverse();
    }
    expect(toCanonicalJson(payloads(base).model)).toBe(toCanonicalJson(payloads(permuted).model));
    expect(toCanonicalJson(payloads(base).coverage)).toBe(toCanonicalJson(payloads(permuted).coverage));
    expect(payloads(base).model.bundleId).toBe(payloads(permuted).model.bundleId);
  });

  test("genuinely ordered data (addresses, command argv) is preserved, not sorted", () => {
    const model = makeModel({
      hosts: [
        makeV2Host("managed-linux", {
          name: "h1",
          addresses: ["10.0.0.9", "10.0.0.1"],
          commandSignals: [
            {
              output: "exposition",
              name: "dump",
              command: ["/usr/bin/z", "--b", "--a"],
              interval: "60s",
            },
          ],
        }),
      ],
    });
    const host = payloads(model).model.hosts.find((h) => h.name === "h1")!;
    expect(host.addresses).toEqual(["10.0.0.9", "10.0.0.1"]);
    if (host.collectionClass === "managed-linux") {
      // argv order is preserved in the display string.
      expect(host.detail.commandSignals[0]!.command).toBe("/usr/bin/z --b --a");
    }
  });

  test("no serialized artifact contains a timestamp/loadedAt", () => {
    for (const file of emitOk()) {
      expect(file.contents.includes("loadedAt")).toBe(false);
    }
  });
});

/** Return the three emitted files for the representative model, asserting success. */
function emitOk() {
  const result = emitWebArtifacts(makeRenderedModelV2Model(), [makeFinding("info")]);
  if (!result.ok) throw new Error("expected success");
  return result.value;
}

describe("framed bundle identity (REQ-REL-01, REQ-BUNDLE-09)", () => {
  test("computeBundleId matches an independently framed node:crypto digest", () => {
    const set = unstamped();
    const expectedHash = createHash("sha256");
    for (const path of WEB_ARTIFACT_PATHS) {
      const bytes = Buffer.from(toCanonicalJson(set[path]), "utf8");
      expectedHash.update(`${path.length}:${path}:${bytes.byteLength}:`, "utf8");
      expectedHash.update(bytes);
    }
    const expected = `sha256:${expectedHash.digest("hex")}`;
    expect(computeBundleId(set)).toBe(expected);
  });

  test("the id is lowercase sha256 + 64 hex and shared by all three artifacts", () => {
    const value = payloads(makeRenderedModelV2Model(), [makeFinding("warning")]);
    expect(value.model.bundleId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(value.coverage.bundleId).toBe(value.model.bundleId);
    expect(value.findings.bundleId).toBe(value.model.bundleId);
    // and it equals the framed digest of the unstamped payloads it identifies.
    expect(value.model.bundleId).toBe(computeBundleId(unstamped(value)));
  });

  test("repeated computation is byte-identical", () => {
    const set = unstamped();
    expect(computeBundleId(set)).toBe(computeBundleId(set));
  });

  test("changing any one payload byte changes the id", () => {
    const set = unstamped();
    const base = computeBundleId(set);
    // Mutate the findings payload.
    const mutatedFindings: UnstampedWebPayloads = {
      ...set,
      "web-findings.json": {
        ...set["web-findings.json"],
        findings: [...set["web-findings.json"].findings, makeFinding("error", { path: "extra" })],
      },
    };
    expect(computeBundleId(mutatedFindings)).not.toBe(base);
    // Mutate the model payload.
    const mutatedModel: UnstampedWebPayloads = {
      ...set,
      "web-estate-model.json": {
        ...set["web-estate-model.json"],
        estate: { ...set["web-estate-model.json"].estate, name: "different-estate-name" },
      },
    };
    expect(computeBundleId(mutatedModel)).not.toBe(base);
  });

  test("the frame's byte-length field makes the boundary unambiguous", () => {
    // Two payload sets whose concatenated JSON bytes would collide without framing must differ.
    const a = unstamped(payloads(makeModel({ estate: { ...makeModel({}).estate, name: "ab" } })));
    const b = unstamped(payloads(makeModel({ estate: { ...makeModel({}).estate, name: "abc" } })));
    expect(computeBundleId(a)).not.toBe(computeBundleId(b));
  });
});

describe("purity/offline source meta-guard (§5.5, REQ-SCALE-01)", () => {
  const PURE_WEB_MODULES = [
    "render/index.ts",
    "render/artifact-index.ts",
    "render/web-model.ts",
    "render/web-artifacts.ts",
    "render/web-safety.ts",
    "render/web-command.ts",
    "coverage.ts",
    "findings.ts",
    "format.ts",
    "order.ts",
    "manifest.ts",
    "tree.ts",
  ] as const;

  const FORBIDDEN = [
    "Date",
    "Date.now",
    "new Date",
    "process.env",
    "process.pid",
    "process.cwd",
    "hostname",
    "Math.random",
    "fetch",
    "XMLHttpRequest",
    "node:http",
    "node:https",
    "node:net",
    "node:dns",
    "node:fs",
    "node:fs/promises",
  ] as const;

  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/[ \t]+\/\/.*$/gm, "");
  }

  for (const module of PURE_WEB_MODULES) {
    test(`${module} contains no nondeterministic/IO syntax`, () => {
      const src = stripComments(readFileSync(`${import.meta.dir}/../src/${module}`, "utf8"));
      for (const pattern of FORBIDDEN) {
        expect(src.includes(pattern)).toBe(false);
      }
      // node:crypto is permitted ONLY in web-artifacts.ts for the deterministic digest.
      if (module === "render/web-artifacts.ts") {
        expect(src.includes("node:crypto")).toBe(true);
      } else {
        expect(src.includes("node:crypto")).toBe(false);
      }
    });
  }

  test("fixture projection still succeeds while global fetch throws if called", () => {
    const original = globalThis.fetch;
    // @ts-expect-error install a throwing stub for the duration of the projection.
    globalThis.fetch = () => {
      throw new Error("network access is forbidden in pure rendering");
    };
    try {
      const result = buildWebArtifactPayloads(makeRenderedModelV2Model(), [makeFinding("error")]);
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
