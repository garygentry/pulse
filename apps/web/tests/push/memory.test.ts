import { describe, expect, test } from "bun:test";

import { PUSH_LIMITS } from "../../src/server/push/constants.js";
import { createNotifiedMemory } from "../../src/server/push/memory.js";
import { PushInvariantError } from "../../src/server/push/refusal.js";

const A = "dev_AAAAAAAAAAA";
const B = "dev_BBBBBBBBBBB";

describe("createNotifiedMemory", () => {
  test("generations start at 1 and strictly increase across devices", () => {
    const m = createNotifiedMemory();
    const r1 = m.mark(A, "0000000000000001");
    const r2 = m.mark(B, "0000000000000001");
    const r3 = m.mark(A, "0000000000000002");
    const r4 = m.mark(A, "0000000000000001");
    expect([r1.generation, r2.generation, r3.generation, r4.generation]).toEqual([1, 2, 3, 4]);
    expect(r1).toEqual({ fingerprint: "0000000000000001", generation: 1 });
    expect(Object.isFrozen(r1)).toBe(true);
  });

  test("separate instances have separate counters", () => {
    createNotifiedMemory().mark(A, "f1");
    expect(createNotifiedMemory().mark(A, "f1").generation).toBe(1);
  });

  test("isMarked and size reflect marks; unknown device is 0 / false", () => {
    const m = createNotifiedMemory();
    expect(m.size(A)).toBe(0);
    expect(m.isMarked(A, "f1")).toBe(false);
    m.mark(A, "f1");
    m.mark(A, "f2");
    m.mark(A, "f1");
    expect(m.size(A)).toBe(2);
    expect(m.size(B)).toBe(0);
    expect(m.isMarked(A, "f1")).toBe(true);
    expect(m.isMarked(B, "f1")).toBe(false);
  });

  test("past the cap the oldest insertion is evicted", () => {
    const m = createNotifiedMemory(3);
    for (const fp of ["f1", "f2", "f3", "f4"]) m.mark(A, fp);
    expect(m.size(A)).toBe(3);
    expect(m.isMarked(A, "f1")).toBe(false);
    expect(m.isMarked(A, "f4")).toBe(true);
  });

  test("a re-mark moves to newest and survives the next eviction", () => {
    const m = createNotifiedMemory(3);
    m.mark(A, "f1");
    m.mark(A, "f2");
    m.mark(A, "f3");
    m.mark(A, "f1"); // f1 is now newest; f2 is oldest
    m.mark(A, "f4");
    expect(m.isMarked(A, "f1")).toBe(true);
    expect(m.isMarked(A, "f2")).toBe(false);
    expect(m.isMarked(A, "f3")).toBe(true);
    expect(m.isMarked(A, "f4")).toBe(true);
  });

  test("isMarked does not reorder", () => {
    const m = createNotifiedMemory(2);
    m.mark(A, "f1");
    m.mark(A, "f2");
    expect(m.isMarked(A, "f1")).toBe(true);
    m.mark(A, "f3");
    expect(m.isMarked(A, "f1")).toBe(false);
  });

  test("the cap is per device", () => {
    const m = createNotifiedMemory(1);
    m.mark(A, "f1");
    m.mark(B, "f2");
    expect(m.isMarked(A, "f1")).toBe(true);
    expect(m.isMarked(B, "f2")).toBe(true);
  });

  test("unmark is unconditional and a no-op when absent", () => {
    const m = createNotifiedMemory();
    m.mark(A, "f1");
    m.mark(A, "f1");
    m.unmark(A, "f1");
    expect(m.isMarked(A, "f1")).toBe(false);
    expect(m.size(A)).toBe(0);
    m.unmark(A, "f1");
    m.unmark(B, "nope");
    expect(m.size(B)).toBe(0);
  });

  test("unmarkIfCurrent removes only matching generations", () => {
    const m = createNotifiedMemory();
    const old = m.mark(A, "f1");
    const keep = m.mark(A, "f2");
    const newer = m.mark(A, "f1"); // re-fire's later mark
    m.unmarkIfCurrent(A, [old, keep]);
    expect(m.isMarked(A, "f1")).toBe(true);
    expect(m.isMarked(A, "f2")).toBe(false);
    m.unmarkIfCurrent(A, [newer]);
    expect(m.isMarked(A, "f1")).toBe(false);
    expect(m.size(A)).toBe(0);
  });

  test("unmarkIfCurrent is a no-op for absent device, evicted or resolved fingerprint, and other devices", () => {
    const m = createNotifiedMemory(1);
    const r1 = m.mark(A, "f1");
    m.mark(A, "f2"); // evicts f1
    m.unmarkIfCurrent(A, [r1]);
    expect(m.isMarked(A, "f2")).toBe(true);
    m.unmarkIfCurrent(B, [r1]);
    const r2 = m.mark(B, "f9");
    m.unmark(B, "f9");
    m.unmarkIfCurrent(B, [r2]);
    expect(m.size(B)).toBe(0);
    // A ref from another device with the same fingerprint and a different generation does nothing.
    const rb = m.mark(B, "f2");
    m.unmarkIfCurrent(A, [rb]);
    expect(m.isMarked(A, "f2")).toBe(true);
  });

  test("dropDevice clears one device only", () => {
    const m = createNotifiedMemory();
    m.mark(A, "f1");
    m.mark(A, "f2");
    m.mark(B, "f1");
    m.dropDevice(A);
    expect(m.size(A)).toBe(0);
    expect(m.isMarked(A, "f1")).toBe(false);
    expect(m.size(B)).toBe(1);
    m.dropDevice("dev_unknown0000");
  });

  test("the default cap is PUSH_LIMITS.memoryMaxPerDevice", () => {
    const m = createNotifiedMemory();
    for (let i = 0; i <= PUSH_LIMITS.memoryMaxPerDevice; i += 1) m.mark(A, `fp${i}`);
    expect(m.size(A)).toBe(PUSH_LIMITS.memoryMaxPerDevice);
    expect(m.isMarked(A, "fp0")).toBe(false);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "an invalid cap %p throws PushInvariantError",
    (cap) => {
      expect(() => createNotifiedMemory(cap)).toThrow(PushInvariantError);
    },
  );
});
