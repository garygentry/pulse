/** scale.test.ts — scale sanity (07 §3.6, REQ-PERF-01).
 *
 *  Load a ~few-hundred host/service estate and assert it completes well under a trivial
 *  wall-clock bound and produces the expected element counts. The bound guards against an
 *  accidental O(n²) (e.g. in cross-reference resolution or provenance lookup) — it is NOT a
 *  performance target (core-contract is explicitly not engineered for thousands of targets,
 *  REQ-PERF-02). The scale fixture is committed and was generated deterministically by the
 *  factory (`scaleInventory()`, item 011). */

import { expect, test, describe } from "bun:test";
import { join } from "node:path";

import { loadAndValidate } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("scale fixture loads under a trivial bound with correct counts (REQ-PERF-01)", () => {
  test("loads ok, in well under 1s, with 300 hosts and 300 services", () => {
    const start = performance.now();
    const res = loadAndValidate(join(FIXTURES, "scale"));
    const elapsedMs = performance.now() - start;

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Element counts (guards against dropped/duplicated elements, not just timing).
    expect(res.model.hosts.length).toBe(300);
    expect(res.model.services.length).toBe(300);

    // Trivial wall-clock bound: a super-linear blowup would blow past this by orders of
    // magnitude. Generous enough to be robust on a loaded CI box.
    expect(elapsedMs).toBeLessThan(1000);
  });
});
