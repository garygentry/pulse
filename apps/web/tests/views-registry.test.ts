// apps/web/tests/views-registry.test.ts — the frozen view-slots registry contract (08 §2, SC-05/06).
//
// Asserts VIEWS has exactly five entries in nav order, every entry sets nav.kiosk:true with
// nav.order matching its array index, and each of the four stub entries is backed by a
// `view.tsx` source file (V-001 — the filename that makes ViewHost's `views/<id>/view` chunk key
// match).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { VIEW_IDS, VIEWS } from "../src/client/views/registry.js";

const EXPECTED_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const;

describe("view-slots registry (08 §2)", () => {
  test("VIEW_IDS is the five M1 ids in nav order", () => {
    expect([...VIEW_IDS]).toEqual([...EXPECTED_IDS]);
  });

  test("VIEWS has exactly five entries in nav order", () => {
    expect(VIEWS).toHaveLength(5);
    expect(VIEWS.map((v) => v.id)).toEqual([...EXPECTED_IDS]);
  });

  test("every entry sets nav.kiosk:true and nav.order matching its array index", () => {
    VIEWS.forEach((v, i) => {
      expect(v.nav?.kiosk).toBe(true);
      expect(v.nav?.order).toBe(i);
    });
  });

  test("every entry carries an icon", () => {
    for (const v of VIEWS) expect(typeof v.icon).toBe("string");
  });

  test("every entry's load() resolves to a component", async () => {
    for (const view of VIEWS) expect(typeof (await view.load())).toBe("function");
  });

  test("each stub view id is backed by a view.tsx source file (V-001)", () => {
    for (const id of ["alerts", "estate", "engine", "timeline"] as const) {
      const file = resolve(import.meta.dir, `../src/client/views/${id}/view.tsx`);
      expect(existsSync(file)).toBe(true);
    }
  });
});
