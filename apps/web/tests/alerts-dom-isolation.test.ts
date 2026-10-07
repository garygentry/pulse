import { afterEach, describe, expect, test } from "bun:test";
import { realGlobal, restoreGlobals, snapshotGlobals } from "./alerts-dom-isolation.js";

const KEY = "__alertsIsolationThrowingGetter";

function defineThrowing(): void {
  Object.defineProperty(realGlobal, KEY, {
    configurable: true,
    enumerable: true,
    get() {
      throw new TypeError("closed window");
    },
  });
}

afterEach(() => {
  delete realGlobal[KEY];
});

describe("alerts dom isolation", () => {
  test("snapshot does not throw on a throwing accessor global", () => {
    defineThrowing();
    let snap: ReturnType<typeof snapshotGlobals> | undefined;
    expect(() => {
      snap = snapshotGlobals();
    }).not.toThrow();
    expect(snap?.get(KEY)?.read.ok).toBe(false);
  });

  test("restore does not throw and restores a throwing accessor by descriptor", () => {
    defineThrowing();
    const snap = snapshotGlobals();
    const desc = Object.getOwnPropertyDescriptor(realGlobal, KEY);
    Object.defineProperty(realGlobal, KEY, { configurable: true, value: 1, writable: true });
    expect(() => restoreGlobals(snap)).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(realGlobal, KEY)?.get).toBe(desc?.get);
  });

  test("restore does not throw when the current getter throws", () => {
    realGlobal[KEY] = "orig";
    const snap = snapshotGlobals();
    defineThrowing();
    expect(() => restoreGlobals(snap)).not.toThrow();
    expect(realGlobal[KEY]).toBe("orig");
  });

  test("restore removes globals added after the snapshot", () => {
    const snap = snapshotGlobals();
    defineThrowing();
    restoreGlobals(snap);
    expect(Object.hasOwn(realGlobal, KEY)).toBe(false);
  });
});
