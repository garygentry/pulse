/** format.test.ts — the canonical serializers (02 §6.2).
 *
 *  Asserts: sortKeysDeep reorders keys at every depth without mutating input; toCanonicalJson
 *  is 2-space indented, code-point key-sorted at every depth, with exactly one trailing
 *  newline and byte-stable across runs; toCanonicalYaml sorts keys, disables wrapping, emits no
 *  anchors/aliases, ends in exactly one newline, and is byte-stable across runs. */

import { expect, test, describe } from "bun:test";
import { parse as yamlParse } from "yaml";

import { sortKeysDeep, toCanonicalJson, toCanonicalYaml } from "../src/format.js";

describe("sortKeysDeep", () => {
  test("reorders keys code-point at every depth", () => {
    const input = { b: 1, a: { z: 1, a: 2 }, Z: 3 };
    const out = sortKeysDeep(input);
    expect(Object.keys(out)).toEqual(["Z", "a", "b"]); // 'Z' (0x5A) < 'a' (0x61) < 'b'
    expect(Object.keys(out.a)).toEqual(["a", "z"]);
  });

  test("does not mutate the input object", () => {
    const input = { b: 1, a: 2 };
    const before = Object.keys(input);
    sortKeysDeep(input);
    expect(Object.keys(input)).toEqual(before); // insertion order preserved on the original
  });

  test("copies arrays element-wise preserving order, sorting nested object keys", () => {
    const input = { list: [{ b: 1, a: 2 }, { d: 4, c: 3 }] };
    const out = sortKeysDeep(input);
    expect(out.list).not.toBe(input.list); // fresh array
    expect(Object.keys(out.list[0]!)).toEqual(["a", "b"]);
    expect(Object.keys(out.list[1]!)).toEqual(["c", "d"]);
    expect(out.list.map((o) => ({ ...o }))).toEqual([{ a: 2, b: 1 }, { c: 3, d: 4 }]);
  });

  test("passes primitives and null through unchanged", () => {
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep("x")).toBe("x");
  });
});

describe("toCanonicalJson", () => {
  const value = {
    labels: { host: "web01", __pulse_credential__: "${T}", collection_class: "managed-linux" },
    targets: ["10.0.0.4:9100"],
  };

  test("2-space indent, code-point-sorted keys at every depth, single trailing newline", () => {
    const json = toCanonicalJson(value);
    expect(json.endsWith("\n")).toBe(true);
    expect(json.endsWith("\n\n")).toBe(false);
    // Top-level keys sorted: 'labels' < 'targets'.
    // Nested label keys sorted: '__pulse_credential__' < 'collection_class' < 'host'.
    expect(json).toBe(
      [
        "{",
        '  "labels": {',
        '    "__pulse_credential__": "${T}",',
        '    "collection_class": "managed-linux",',
        '    "host": "web01"',
        "  },",
        '  "targets": [',
        '    "10.0.0.4:9100"',
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("is byte-identical across two runs regardless of input key insertion order", () => {
    const a = toCanonicalJson({ b: 1, a: { y: 1, x: 2 } });
    const b = toCanonicalJson({ a: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(toCanonicalJson(value)).toBe(toCanonicalJson(value));
  });
});

describe("toCanonicalYaml", () => {
  const value = {
    endpoints: [
      { url: "https://grafana.example.com", name: "web01/grafana", group: "web01", conditions: ["[STATUS] == 200"] },
    ],
  };

  test("sorts map keys, ends in exactly one newline, and round-trips", () => {
    const yaml = toCanonicalYaml(value);
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
    // keys of the endpoint object appear code-point sorted: conditions < group < name < url
    const condIdx = yaml.indexOf("conditions");
    const groupIdx = yaml.indexOf("group");
    const nameIdx = yaml.indexOf("name");
    const urlIdx = yaml.indexOf("url");
    expect(condIdx).toBeGreaterThanOrEqual(0);
    expect(condIdx).toBeLessThan(groupIdx);
    expect(groupIdx).toBeLessThan(nameIdx);
    expect(nameIdx).toBeLessThan(urlIdx);
    // structurally equal after a parse round-trip
    expect(yamlParse(yaml)).toEqual(value);
  });

  test("emits no anchors/aliases even for a repeated object reference", () => {
    const shared = { a: 1, b: 2 };
    const yaml = toCanonicalYaml({ first: shared, second: shared });
    expect(yaml).not.toContain("&");
    expect(yaml).not.toContain("*");
    expect(yamlParse(yaml)).toEqual({ first: { a: 1, b: 2 }, second: { a: 1, b: 2 } });
  });

  test("is byte-identical across two runs regardless of input key insertion order", () => {
    const a = toCanonicalYaml({ b: 1, a: 2 });
    const b = toCanonicalYaml({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(toCanonicalYaml(value)).toBe(toCanonicalYaml(value));
  });
});
