import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_CREDENTIAL_PATTERN,
  DEVICE_ID_PATTERN,
  PAIR_TOKEN_PATTERN,
} from "@pulse/web-data/contract";

import { PUSH_CACHE_CONTROL, PUSH_LIMITS, PUSH_PATHS } from "../../src/server/push/constants.js";
import {
  newCredential,
  newDeviceId,
  newPairingToken,
  SYSTEM_CLOCK,
  SYSTEM_RANDOM,
  SYSTEM_TIMERS,
} from "../../src/server/push/ids.js";
import { PushInvariantError } from "../../src/server/push/refusal.js";
import { createFakeClock, createFakeTimers, createSeededRandom } from "./helpers/fakes.js";
import { createTestApnsKey, writeTestKeyFile } from "./helpers/keys.js";
import { amAlert, amNotification } from "./helpers/am-fixtures.js";

describe("identifier formats", () => {
  test("pairing tokens are 22 base64url chars from 16 bytes", () => {
    for (let i = 0; i < 200; i++) {
      const t = newPairingToken(SYSTEM_RANDOM);
      expect(t).toHaveLength(22);
      expect(t).toMatch(PAIR_TOKEN_PATTERN);
      expect(Buffer.from(t, "base64url")).toHaveLength(16);
    }
  });

  test("credentials are 43 base64url chars from 32 bytes", () => {
    for (let i = 0; i < 200; i++) {
      const c = newCredential(SYSTEM_RANDOM);
      expect(c).toHaveLength(43);
      expect(c).toMatch(DEVICE_CREDENTIAL_PATTERN);
      expect(Buffer.from(c, "base64url")).toHaveLength(32);
    }
  });

  test("device ids are dev_ + 11 base64url chars from 8 bytes", () => {
    for (let i = 0; i < 200; i++) {
      const id = newDeviceId(SYSTEM_RANDOM);
      expect(id).toHaveLength(15);
      expect(id).toMatch(DEVICE_ID_PATTERN);
      expect(Buffer.from(id.slice(4), "base64url")).toHaveLength(8);
    }
  });

  test("all-0xff bytes still match (url-safe alphabet, no padding)", () => {
    const ones = { bytes: (n: number) => new Uint8Array(n).fill(0xff), unit: () => 0 };
    expect(newPairingToken(ones)).toMatch(PAIR_TOKEN_PATTERN);
    expect(newCredential(ones)).toMatch(DEVICE_CREDENTIAL_PATTERN);
    expect(newDeviceId(ones)).toMatch(DEVICE_ID_PATTERN);
  });

  test("SYSTEM_RANDOM.unit is in [0, 1) and SYSTEM_CLOCK tracks Date.now", () => {
    for (let i = 0; i < 1000; i++) {
      const u = SYSTEM_RANDOM.unit();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
    expect(SYSTEM_RANDOM.bytes(5)).toHaveLength(5);
    const before = Date.now();
    const now = SYSTEM_CLOCK.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("seeded random", () => {
  test("the same seed yields the same bytes and ids", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    expect(a.bytes(16)).toEqual(b.bytes(16));
    expect(a.bytes(33)).toEqual(b.bytes(33));
    expect(a.unit()).toBe(b.unit());
    expect(newPairingToken(createSeededRandom(7))).toBe(newPairingToken(createSeededRandom(7)));
    expect(newDeviceId(createSeededRandom(7))).toBe(newDeviceId(createSeededRandom(7)));
  });

  test("different seeds differ and unit stays in [0, 1)", () => {
    expect(createSeededRandom(1).bytes(16)).not.toEqual(createSeededRandom(2).bytes(16));
    const r = createSeededRandom(3);
    for (let i = 0; i < 1000; i++) {
      const u = r.unit();
      expect(u >= 0 && u < 1).toBe(true);
    }
  });
});

describe("SYSTEM_TIMERS", () => {
  test("handles are unref'd", () => {
    const t = SYSTEM_TIMERS.setTimeout(() => {}, 60_000) as { hasRef?: () => boolean };
    const i = SYSTEM_TIMERS.setInterval(() => {}, 60_000) as { hasRef?: () => boolean };
    try {
      if (typeof t.hasRef === "function") expect(t.hasRef()).toBe(false);
      if (typeof i.hasRef === "function") expect(i.hasRef()).toBe(false);
    } finally {
      SYSTEM_TIMERS.clearTimeout(t);
      SYSTEM_TIMERS.clearInterval(i);
    }
  });

  test("a cleared timeout never fires", async () => {
    let fired = false;
    const h = SYSTEM_TIMERS.setTimeout(() => {
      fired = true;
    }, 10);
    SYSTEM_TIMERS.clearTimeout(h);
    await Bun.sleep(30);
    expect(fired).toBe(false);
  });

  test("an unref'd timeout still fires while something else keeps the process alive", async () => {
    const fired = await new Promise<boolean>((resolve) => {
      const guard = setTimeout(() => resolve(false), 1000);
      SYSTEM_TIMERS.setTimeout(() => {
        clearTimeout(guard);
        resolve(true);
      }, 5);
    });
    expect(fired).toBe(true);
  });

  test("a pending timer does not keep a subprocess alive", async () => {
    const idsPath = join(import.meta.dir, "../../src/server/push/ids.ts");
    const script = `const { SYSTEM_TIMERS } = await import(${JSON.stringify(idsPath)});
SYSTEM_TIMERS.setTimeout(() => {}, 60000);
SYSTEM_TIMERS.setInterval(() => {}, 60000);`;
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
    const killer = setTimeout(() => proc.kill(), 15_000);
    const code = await proc.exited;
    clearTimeout(killer);
    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 20_000);
});

describe("fake timers", () => {
  test("run in due-time order, then insertion order", () => {
    const clock = createFakeClock(1_000);
    const timers = createFakeTimers(clock);
    const order: string[] = [];
    timers.setTimeout(() => order.push("b@20"), 20);
    timers.setTimeout(() => order.push("a@10"), 10);
    timers.setTimeout(() => order.push("c@20"), 20);
    timers.setTimeout(() => order.push("d@0"), 0);
    expect(timers.pending()).toBe(4);
    expect(timers.runDue()).toBe(1);
    expect(order).toEqual(["d@0"]);
    clock.advance(20);
    expect(timers.runDue()).toBe(3);
    expect(order).toEqual(["d@0", "a@10", "b@20", "c@20"]);
    expect(timers.pending()).toBe(0);
  });

  test("cleared timers never run; runDue runs timers scheduled for now by a callback", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const order: string[] = [];
    const h = timers.setTimeout(() => order.push("cleared"), 5);
    timers.setTimeout(() => {
      order.push("first");
      timers.setTimeout(() => order.push("chained"), 0);
    }, 5);
    timers.clearTimeout(h);
    clock.advance(5);
    timers.runDue();
    expect(order).toEqual(["first", "chained"]);
  });

  test("intervals repeat until cleared; advance steps the clock to each due time", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const seen: number[] = [];
    const h = timers.setInterval(() => seen.push(clock.nowMs()), 100);
    expect(timers.advance(350)).toBe(3);
    expect(seen).toEqual([100, 200, 300]);
    expect(clock.nowMs()).toBe(350);
    timers.clearInterval(h);
    expect(timers.pending()).toBe(0);
    expect(timers.advance(1_000)).toBe(0);
  });

  test("runAll drains timeouts and refuses to spin forever on an interval", () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const order: number[] = [];
    timers.setTimeout(() => order.push(2), 2_000);
    timers.setTimeout(() => order.push(1), 1_000);
    expect(timers.runAll()).toBe(2);
    expect(order).toEqual([1, 2]);
    expect(clock.nowMs()).toBe(2_000);
    timers.setInterval(() => {}, 10);
    expect(() => timers.runAll(50)).toThrow();
  });
});

describe("constants and invariant error", () => {
  test("pinned values", () => {
    expect(PUSH_LIMITS.summaryThreshold).toBe(5);
    expect(PUSH_LIMITS.tokenTtlMs).toBe(600_000);
    expect(PUSH_LIMITS.testRetryDelaysMs).toEqual([1_000, 2_000, 4_000]);
    expect(PUSH_PATHS.redeem).toBe("/api/push/pairings/redeem");
    expect(PUSH_CACHE_CONTROL).toBe("private, no-store");
    expect(Object.isFrozen(PUSH_LIMITS)).toBe(true);
  });

  test("PushInvariantError carries its code", () => {
    const err = new PushInvariantError("broken");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PUSH_INVARIANT");
    expect(err.message).toBe("broken");
  });
});

describe("helpers", () => {
  test("test keys are fresh P-256 PKCS#8 keys", () => {
    const a = createTestApnsKey();
    const b = createTestApnsKey();
    expect(a.pem).not.toBe(b.pem);
    expect(a.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  test("writeTestKeyFile writes the PEM with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-push-keys-"));
    try {
      const key = writeTestKeyFile(dir);
      expect(statSync(key.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(key.path, "utf8")).toBe(key.pem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Alertmanager fixtures use placeholder labels", () => {
    const body = amNotification({ alerts: [amAlert(), amAlert({ status: "resolved", fingerprint: "fedcba9876543210" })] });
    expect(body.version).toBe("4");
    expect(body.status).toBe("firing");
    expect(body.alerts[0]?.labels).toEqual({ alertname: "HostDown", severity: "critical", instance: "web-01.example.com" });
    expect(amNotification({ alerts: [amAlert({ status: "resolved" })] }).status).toBe("resolved");
  });
});
