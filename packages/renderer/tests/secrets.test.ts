/** secrets.test.ts — the secret-refusal choke-point (02 §7, REQ-RND-09, REQ-SEC-02).
 *
 *  Asserts: renderSecretRef returns the `.raw` reference for a valid env/op SecretRef and never a
 *  resolved value; a non-SecretRef yields { ok: false } with an ERROR secret_literal finding that
 *  names the site file/path and carries a non-empty fix (never throws). */

import { expect, test, describe } from "bun:test";

import { FINDING_CODES } from "@pulse/core";

import { renderSecretRef } from "../src/render/secrets.js";
import type { CredentialSite } from "../src/render/secrets.js";

const SITE: CredentialSite = { file: "alertmanager/routing.yaml", path: "receivers.chat.credential" };

describe("renderSecretRef — valid SecretRef", () => {
  test("env ref returns { ok: true, ref: value.raw }", () => {
    const value = { kind: "env", raw: "${SLACK_TOKEN}", varName: "SLACK_TOKEN" };
    const result = renderSecretRef(value, SITE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ref).toBe("${SLACK_TOKEN}");
  });

  test("op ref returns { ok: true, ref: value.raw }", () => {
    const value = { kind: "op", raw: "op://vault/item/field", vault: "vault", item: "item", field: "field" };
    const result = renderSecretRef(value, SITE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ref).toBe("op://vault/item/field");
  });

  test("returns the reference text, never a resolved/secret value on the object", () => {
    // A malicious/extra `resolved` field must be ignored — only `.raw` is ever read.
    const value = { kind: "env", raw: "${API_KEY}", varName: "API_KEY", resolved: "s3cr3t-plaintext" };
    const result = renderSecretRef(value, SITE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toBe("${API_KEY}");
      expect(result.ref).not.toContain("s3cr3t");
    }
  });
});

describe("renderSecretRef — refusal on a non-SecretRef", () => {
  const bad: Array<[string, unknown]> = [
    ["a bare string literal", "literally-a-password"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object with no discriminant", { raw: "${X}" }],
    ["an object with a bad kind", { kind: "vault", raw: "${X}" }],
    ["an object with a non-string raw", { kind: "env", raw: 123 }],
  ];

  for (const [label, value] of bad) {
    test(`${label} yields { ok: false } with a secret_literal error finding (no throw)`, () => {
      const result = renderSecretRef(value, SITE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const f = result.finding;
        expect(f.code).toBe(FINDING_CODES.SECRET_LITERAL);
        expect(f.severity).toBe("error");
        expect(f.file).toBe(SITE.file);
        expect(f.path).toBe(SITE.path);
        expect(f.file.length).toBeGreaterThan(0);
        expect(f.path.length).toBeGreaterThan(0);
        expect(f.fix && f.fix.length).toBeGreaterThan(0);
        expect(f.message.length).toBeGreaterThan(0);
      }
    });
  }

  test("never throws for any of the bad inputs", () => {
    for (const [, value] of bad) {
      expect(() => renderSecretRef(value, SITE)).not.toThrow();
    }
  });
});
