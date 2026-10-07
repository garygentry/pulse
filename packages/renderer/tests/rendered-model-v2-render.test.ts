/** rendered-model-v2-render.test.ts — the coordinated web emitter (04 §§4.1–4.3, 08 §7.1).
 *
 *  Exercises `emitWebArtifacts` / `buildWebArtifactPayloads` / the public `buildWebEstateModel`
 *  directly: the emitter produces exactly the three fixed serialized paths, all three carry
 *  `formatVersion: 2` and one shared `bundleId`, loader findings are threaded once into
 *  `web-findings.json`, and the public `buildWebEstateModel(model)` value equals the emitted model
 *  byte-for-byte (its same-module delegation to the coordinated payload builder). A fatal unsafe
 *  provenance or recursive leak returns `{ ok: false, findings }` with no `value`/files and never
 *  echoes the unsafe value. Wiring these payloads into `renderOnly`/the manifest is item 010. */

import { describe, expect, test } from "bun:test";

import type { EstateModel, Provenance } from "@pulse/core";

import {
  buildWebArtifactPayloads,
  buildWebEstateModel,
  emitWebArtifacts,
} from "../src/render/web-artifacts.js";
import { toCanonicalJson } from "../src/format.js";
import { PROV, makeFinding, makeModel, makeRenderedModelV2Model, makeV2Host } from "./factories.js";

function emitOk(model: EstateModel, findings = [makeFinding("info")]) {
  const result = emitWebArtifacts(model, findings);
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.findings)}`);
  return result.value;
}

// ---------------------------------------------------------------------------

describe("three exact serialized paths and shared identity (REQ-RENDER-01, REQ-REL-01)", () => {
  test("emitWebArtifacts returns exactly the three fixed web paths in sorted order", () => {
    const files = emitOk(makeRenderedModelV2Model());
    expect(files.map((f) => f.path)).toEqual([
      "web-coverage.json",
      "web-estate-model.json",
      "web-findings.json",
    ]);
  });

  test("all three artifacts carry formatVersion 2 and one shared bundleId", () => {
    const parsed = emitOk(makeRenderedModelV2Model()).map((f) => JSON.parse(f.contents));
    for (const p of parsed) expect(p.formatVersion).toBe(2);
    const ids = new Set(parsed.map((p) => p.bundleId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("each emitted file is canonical JSON ending in exactly one newline", () => {
    for (const file of emitOk(makeRenderedModelV2Model())) {
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents.endsWith("\n\n")).toBe(false);
      expect(() => JSON.parse(file.contents)).not.toThrow();
    }
  });

  test("an empty estate still emits all three files with empty collections", () => {
    const files = emitOk(makeModel({}), []);
    expect(files.map((f) => f.path)).toEqual([
      "web-coverage.json",
      "web-estate-model.json",
      "web-findings.json",
    ]);
    const findings = JSON.parse(files.find((f) => f.path === "web-findings.json")!.contents);
    expect(findings.findings).toEqual([]);
  });
});

describe("findings threading (REQ-FIND-02, REQ-RENDER-03)", () => {
  test("loader findings appear once in web-findings.json", () => {
    const loader = makeFinding("error", { path: "hosts[0].name", message: "loader event" });
    const files = emitOk(makeRenderedModelV2Model(), [loader]);
    const findings = JSON.parse(files.find((f) => f.path === "web-findings.json")!.contents).findings;
    const matches = findings.filter(
      (f: { message: string }) => f.message === "loader event",
    );
    expect(matches.length).toBe(1);
  });
});

describe("public buildWebEstateModel delegates to the coordinated builder (08 §7.1)", () => {
  test("its success value equals the emitted model byte-for-byte, including bundleId", () => {
    const model = makeRenderedModelV2Model();
    const built = buildWebEstateModel(model);
    if (!built.ok) throw new Error("expected success");
    const emitted = emitWebArtifacts(model, []);
    if (!emitted.ok) throw new Error("expected success");
    const modelFile = emitted.value.find((f) => f.path === "web-estate-model.json")!;
    expect(JSON.parse(modelFile.contents)).toEqual(built.value);
    expect(toCanonicalJson(built.value)).toBe(modelFile.contents);
    expect(built.value.bundleId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("fatal outcomes expose findings only, never a partial generation (REQ-RENDER-08, REQ-REL-03)", () => {
  test("unsafe provenance returns ok:false with no value and never echoes the unsafe path", () => {
    const absolute: Provenance = { file: "/etc/estate.yaml", path: "hosts[0]", line: 1, col: 1 };
    const model = makeModel({
      hosts: [makeV2Host("managed-linux", { name: "h1", provenance: absolute })],
    });
    const result = buildWebArtifactPayloads(model);
    expect(result.ok).toBe(false);
    expect("value" in result).toBe(false);
    expect(result.findings.some((f) => f.code === "web_unsafe_provenance")).toBe(true);
    for (const f of result.findings) {
      expect(JSON.stringify(f).includes("/etc/estate.yaml")).toBe(false);
    }
    // The emitter serializes nothing on the fatal arm.
    const emitted = emitWebArtifacts(model);
    expect(emitted.ok).toBe(false);
    expect("value" in emitted).toBe(false);
  });

  test("a canary that reaches output triggers a fatal leak with no echoed value", () => {
    const canary = "ZZLEAKCANARYZZ";
    const model = makeModel({
      estate: {
        name: "estate",
        domains: [canary], // a plain deadman hook that also surfaces in output
        timezone: "UTC",
        deadmanHook: canary,
        provenance: PROV,
      },
      hosts: [makeV2Host("managed-linux", { name: "h1" })],
    });
    const result = emitWebArtifacts(model);
    expect(result.ok).toBe(false);
    expect("value" in result).toBe(false);
    expect(result.findings.some((f) => f.code === "web_artifact_leak_detected")).toBe(true);
    for (const f of result.findings) {
      expect(JSON.stringify(f).includes(canary)).toBe(false);
    }
  });
});
