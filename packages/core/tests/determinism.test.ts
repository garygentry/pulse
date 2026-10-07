/** determinism.test.ts — byte-stable model + findings and insertion-order-independent
 *  collection (07 §3.2, REQ-DET-01, SC-05).
 *
 *  The loader/validator is a pure function of its input bytes: the same directory yields the
 *  same serialized model and findings every time, and the finding sort is independent of the
 *  order findings were added. This suite also guards against accidental non-determinism leaking
 *  into a finding — an absolute path or a wall-clock timestamp (a stray `Date.now()`). */

import { expect, test, describe } from "bun:test";
import { join, isAbsolute } from "node:path";

import { loadAndValidate } from "../src/index.js";
import { FindingCollector } from "../src/findings/collect.js";
import type { Finding } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("byte-identical model + findings across two loads (SC-05)", () => {
  test("valid-min serializes identically on two independent loads", () => {
    const a = loadAndValidate(join(FIXTURES, "valid-min"));
    const b = loadAndValidate(join(FIXTURES, "valid-min"));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return; // narrow for the model access below
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });

  test("a broken config serializes its findings identically on two loads", () => {
    const a = loadAndValidate(join(FIXTURES, "broken-semantic"));
    const b = loadAndValidate(join(FIXTURES, "broken-semantic"));
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });
});

describe("insertion-order-independent collector output (05 §6)", () => {
  test("two collectors fed the same findings in different orders drain() deeply-equal", () => {
    // A real, multi-finding set (5 semantic findings) — reversed for the second collector.
    const res = loadAndValidate(join(FIXTURES, "broken-semantic"));
    const findings = res.findings;
    expect(findings.length).toBeGreaterThan(1);

    const forward = new FindingCollector();
    findings.forEach((f) => forward.add(f));

    const reverse = new FindingCollector();
    [...findings].reverse().forEach((f) => reverse.add(f));

    expect(reverse.drain()).toEqual(forward.drain());
  });
});

describe("no non-determinism leaks into findings (REQ-DET-01)", () => {
  // Sweep every finding-producing fixture; the guards must hold for the entire corpus.
  const CORPUS = [
    "broken-min",
    "broken-semantic",
    "shape-bad",
    "duplicate-estate",
    "multi-file",
    "malformed",
    "bad-version/unsupported",
    "bad-version/missing",
  ];

  const allFindings: Finding[] = CORPUS.flatMap((dir) => loadAndValidate(join(FIXTURES, dir)).findings);

  test("the corpus actually produced findings to guard", () => {
    expect(allFindings.length).toBeGreaterThan(0);
  });

  test("no finding's file is an absolute path", () => {
    for (const f of allFindings) {
      expect(isAbsolute(f.file)).toBe(false);
      expect(f.file.startsWith("/")).toBe(false);
    }
  });

  test("no finding message or fix contains a digit-only timestamp (Date.now leakage)", () => {
    // A run of 10+ digits would be an epoch seconds/millis stamp; findings must carry none.
    const TIMESTAMPish = /\d{10,}/;
    for (const f of allFindings) {
      expect(TIMESTAMPish.test(f.message)).toBe(false);
      expect(TIMESTAMPish.test(f.fix)).toBe(false);
    }
  });
});
