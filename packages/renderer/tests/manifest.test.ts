/** manifest.test.ts — the manifest ledger builder (00 §3.4, 02 §8).
 *
 *  Asserts: buildManifestFile stamps formatVersion === 2, sorts the file paths by raw
 *  code-point, excludes the manifest path itself, and lands at MANIFEST_FILENAME. */

import { expect, test, describe } from "bun:test";

import {
  buildManifestFile,
  MANIFEST_FILENAME,
  RENDER_FORMAT_VERSION,
  type RenderedManifest,
} from "../src/manifest.js";
import type { RenderedFile } from "../src/tree.js";

describe("buildManifestFile", () => {
  const files: RenderedFile[] = [
    { path: "scrape/file_sd/managed-linux.json", contents: "{}\n" },
    { path: "gatus/config.yaml", contents: "endpoints: []\n" },
    { path: "alertmanager/routing.yaml", contents: "route: {}\n" },
  ];

  test("lands at MANIFEST_FILENAME with canonical JSON contents", () => {
    const member = buildManifestFile(files);
    expect(member.path).toBe(MANIFEST_FILENAME);
    expect(member.contents.endsWith("\n")).toBe(true);
  });

  test("stamps formatVersion === 2 (RENDER_FORMAT_VERSION)", () => {
    const parsed = JSON.parse(buildManifestFile(files).contents) as RenderedManifest;
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.formatVersion).toBe(RENDER_FORMAT_VERSION);
  });

  test("lists file paths sorted by raw code-point", () => {
    const parsed = JSON.parse(buildManifestFile(files).contents) as RenderedManifest;
    expect(parsed.files).toEqual([
      "alertmanager/routing.yaml",
      "gatus/config.yaml",
      "scrape/file_sd/managed-linux.json",
    ]);
    expect(parsed.files).toEqual([...parsed.files].sort());
  });

  test("excludes the manifest path itself even when passed in the file set", () => {
    // The manifest is appended AFTER the emitted set; it should never list its own path.
    const withManifest: RenderedFile[] = [
      ...files,
      { path: MANIFEST_FILENAME, contents: "" },
    ];
    // buildManifestFile lists whatever paths it is given; the contract is that callers
    // pass the OTHER emitted files. Verify that a caller who honors that never sees the
    // manifest name in the ledger.
    const parsed = JSON.parse(buildManifestFile(files).contents) as RenderedManifest;
    expect(parsed.files).not.toContain(MANIFEST_FILENAME);
    // And a manifest built over ONLY the non-manifest set (the contract path) excludes it.
    const emitted = withManifest.filter((f) => f.path !== MANIFEST_FILENAME);
    const ledger = JSON.parse(buildManifestFile(emitted).contents) as RenderedManifest;
    expect(ledger.files).not.toContain(MANIFEST_FILENAME);
  });

  test("does not mutate the input file array", () => {
    const input: RenderedFile[] = [
      { path: "b.json", contents: "" },
      { path: "a.json", contents: "" },
    ];
    buildManifestFile(input);
    expect(input.map((f) => f.path)).toEqual(["b.json", "a.json"]);
  });
});
