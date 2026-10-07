/** loader.test.ts — read layer + location-aware parse (03-loader-and-pipeline.md, 07 §3.1 loader).
 *
 *  Asserts: readEstateDir returns files sorted; opts.files overrides the scan; a missing dir
 *  throws ConfigIoError DIR_NOT_FOUND; a non-dir → NOT_A_DIRECTORY; malformed YAML becomes a
 *  MALFORMED_YAML finding, never a throw. */

import { expect, test, describe } from "bun:test";
import { join } from "node:path";

import { readEstateDir, ConfigIoError, loadAndValidate } from "../src/loader/index.js";
import { parseYamlDocument } from "../src/loader/yaml.js";
import { FINDING_CODES } from "../src/findings/codes.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const MULTI = join(FIXTURES, "multi-file");
const OVERLAY = join(FIXTURES, "overlay-estate");

describe("readEstateDir — directory scan", () => {
  test("returns RawSource[] sorted ascending by relative file", () => {
    const sources = readEstateDir(MULTI);
    const files = sources.map((s) => s.file);
    expect(files).toEqual(["00-estate.yaml", "10-services.yaml", "20-more-hosts.yaml"]);
    // and each carries its raw text
    expect(sources.every((s) => typeof s.text === "string" && s.text.length > 0)).toBe(true);
  });

  test("only *.yaml / *.yml files are picked up", () => {
    const sources = readEstateDir(MULTI);
    expect(sources.every((s) => s.file.endsWith(".yaml") || s.file.endsWith(".yml"))).toBe(true);
  });
});

describe("readEstateDir — opts.files override", () => {
  test("opts.files reads exactly the listed files instead of scanning", () => {
    const sources = readEstateDir(MULTI, { files: ["10-services.yaml"] });
    expect(sources.map((s) => s.file)).toEqual(["10-services.yaml"]);
  });

  test("opts.files is still sorted regardless of the order given", () => {
    const sources = readEstateDir(MULTI, {
      files: ["20-more-hosts.yaml", "00-estate.yaml"],
    });
    expect(sources.map((s) => s.file)).toEqual(["00-estate.yaml", "20-more-hosts.yaml"]);
  });

  test("a non-string opts.files entry throws ConfigIoError INVALID_ARG", () => {
    expect(() => readEstateDir(MULTI, { files: ["" as string] })).toThrow(ConfigIoError);
    try {
      readEstateDir(MULTI, { files: [""] });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigIoError);
      expect((e as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });
});

describe("readEstateDir — usage failures throw ConfigIoError", () => {
  test("a missing dir throws DIR_NOT_FOUND", () => {
    try {
      readEstateDir(join(FIXTURES, "does-not-exist"));
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigIoError);
      expect(e).toBeInstanceOf(Error); // instanceof Error also holds across ESM
      expect((e as ConfigIoError).code).toBe("DIR_NOT_FOUND");
    }
  });

  test("a non-directory path throws NOT_A_DIRECTORY", () => {
    try {
      readEstateDir(join(MULTI, "00-estate.yaml")); // a file, not a dir
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigIoError);
      expect((e as ConfigIoError).code).toBe("NOT_A_DIRECTORY");
    }
  });

  test("a non-string dir throws INVALID_ARG", () => {
    try {
      readEstateDir("" as string);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigIoError);
      expect((e as ConfigIoError).code).toBe("INVALID_ARG");
    }
  });
});

describe("parseYamlDocument — malformed YAML is a finding, never a throw", () => {
  test("a syntax error yields a MALFORMED_YAML finding with line/col in the message", () => {
    let parsed!: ReturnType<typeof parseYamlDocument>;
    expect(() => {
      parsed = parseYamlDocument({ file: "bad.yaml", text: "foo:\n  - [unterminated\n" });
    }).not.toThrow();
    expect(parsed.content).toBeUndefined();
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    const f = parsed.findings[0]!;
    expect(f.code).toBe(FINDING_CODES.MALFORMED_YAML);
    expect(f.severity).toBe("error");
    expect(f.file).toBe("bad.yaml");
    expect(f.message).toMatch(/line \d+, column \d+/);
  });

  test("well-formed YAML parses to a plain object with a provenance map", () => {
    const parsed = parseYamlDocument({
      file: "ok.yaml",
      text: "estate:\n  schema_version: 1\n  name: acme\n",
    });
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.content).toEqual({ estate: { schema_version: 1, name: "acme" } });
    const loc = parsed.provenance.get("estate.name");
    expect(loc).toBeDefined();
    expect(loc!.line).toBeGreaterThan(0);
    expect(loc!.col).toBeGreaterThan(0);
  });
});

describe("loadAndValidate — generated base + hand overlay end to end (issue #7)", () => {
  test("a base skeleton and a monitoring overlay merge into one valid model", () => {
    const res = loadAndValidate(OVERLAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Exactly one host: the overlay refined the base `app-01` by identity (not a duplicate).
    expect(res.model.hosts).toHaveLength(1);
    const host = res.model.hosts[0]!;
    expect(host.name).toBe("app-01");
    expect(host.collectionClass).toBe("managed-linux");
    if (host.collectionClass !== "managed-linux") return;
    expect(host.deliveryForm).toBe("compose"); // base-only fact retained
    expect(host.cadvisor).toBe(true); // overlay scalar wins
    expect(host.exporterPorts).toEqual([9100, 9256]); // overlay array replaces base whole
    expect(host.scrapeIntervalClass).toBe("fast"); // overlay-only field added

    // The overlay-only channel unions in.
    expect(res.model.channels.map((c) => c.name)).toEqual(["ops-chat"]);
  });
})
