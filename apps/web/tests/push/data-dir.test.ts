// Push data-directory probe: mkdir 0700, probe write 0600, unlink; every failure is reported with its step and
// errno code, and the probe never rejects.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NODE_PUSH_FS, probePushDataDir, type PushFs } from "../../src/server/push/data-dir.js";
import { memoryPushFs } from "./helpers/fakes.js";

let root: string;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "push-data-dir-"));
});

afterAll(() => {
  // Restore permissions so cleanup can descend into read-only fixtures.
  for (const name of ["readonly", "readonly-push"]) {
    const p = join(root, name);
    if (existsSync(p)) chmodSync(p, 0o700);
    const inner = join(p, "push");
    if (existsSync(inner)) chmodSync(inner, 0o700);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("probePushDataDir on the real filesystem", () => {
  test("ok: creates <dataDir>/push and leaves no probe file", async () => {
    const dataDir = join(root, "ok");
    mkdirSync(dataDir);
    const result = await probePushDataDir(dataDir, NODE_PUSH_FS, 4242);
    expect(result).toEqual({ ok: true, pushDir: join(dataDir, "push") });
    expect(readdirSync(join(dataDir, "push"))).toEqual([]);
    // A second probe (existing directory, same pid) also succeeds.
    expect((await probePushDataDir(dataDir, NODE_PUSH_FS, 4242)).ok).toBe(true);
  });

  test("a missing parent is created, with mode 0700", async () => {
    const dataDir = join(root, "missing", "parent");
    const result = await probePushDataDir(dataDir, NODE_PUSH_FS);
    expect(result.ok).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "push")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "missing")).mode & 0o777).toBe(0o700);
  });

  test.skipIf(isRoot)("a read-only data dir fails at mkdir with EACCES (skipped as root)", async () => {
    const dataDir = join(root, "readonly");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o500);
    const result = await probePushDataDir(dataDir, NODE_PUSH_FS);
    expect(result).toEqual({ ok: false, reason: "data-dir-unwritable", step: "mkdir", code: "EACCES" });
  });

  test.skipIf(isRoot)("a read-only push dir fails at write with EACCES (skipped as root)", async () => {
    const dataDir = join(root, "readonly-push");
    mkdirSync(join(dataDir, "push"), { recursive: true });
    chmodSync(join(dataDir, "push"), 0o500);
    const result = await probePushDataDir(dataDir, NODE_PUSH_FS);
    expect(result).toEqual({ ok: false, reason: "data-dir-unwritable", step: "write", code: "EACCES" });
  });
});

describe("probePushDataDir on the in-memory seam", () => {
  test("ok: mkdir, write 0600, unlink, in that order", async () => {
    const fs = memoryPushFs();
    const result = await probePushDataDir("/data", fs, 7);
    expect(result).toEqual({ ok: true, pushDir: "/data/push" });
    expect(fs.calls).toEqual(["mkdir /data/push", "writeFile /data/push/.probe-7", "unlink /data/push/.probe-7"]);
    expect(fs.dirs.get("/data/push")).toBe(0o700);
    expect(fs.files.size).toBe(0);
  });

  test("a stale probe file from a hard stop does not fail the probe", async () => {
    const fs = memoryPushFs();
    fs.seed("/data/push/.probe-1", "", 0o600);
    expect((await probePushDataDir("/data", fs, 1)).ok).toBe(true);
  });

  for (const [op, step] of [
    ["mkdir", "mkdir"],
    ["writeFile", "write"],
    ["unlink", "unlink"],
  ] as const) {
    test(`a ${op} failure reports step ${step} and its code`, async () => {
      const fs = memoryPushFs();
      fs.failNext(op, { code: "EROFS" });
      const result = await probePushDataDir("/data", fs, 1);
      expect(result).toEqual({ ok: false, reason: "data-dir-unwritable", step, code: "EROFS" });
    });
  }

  test("no unlink is attempted after a write failure", async () => {
    const fs = memoryPushFs();
    fs.failNext("writeFile", { code: "ENOSPC" });
    await probePushDataDir("/data", fs, 1);
    expect(fs.calls.some((c) => c.startsWith("unlink"))).toBe(false);
  });

  test("an error without a string code reports code null, and nothing rejects", async () => {
    const throwing: PushFs = {
      ...NODE_PUSH_FS,
      mkdir: () => Promise.reject(42),
    };
    expect(await probePushDataDir("/data", throwing)).toEqual({
      ok: false,
      reason: "data-dir-unwritable",
      step: "mkdir",
      code: null,
    });
    const fs = memoryPushFs();
    fs.failAlways("unlink", { code: null });
    expect(await probePushDataDir("/data", fs, 3)).toEqual({
      ok: false,
      reason: "data-dir-unwritable",
      step: "unlink",
      code: null,
    });
  });
});

describe("memoryPushFs store seams", () => {
  test("readFile rejects ENOENT for a missing file; storeWriteFile writes and can fail on demand", async () => {
    const fs = memoryPushFs();
    await expect(fs.storeReadFile("/data/push/devices.json")).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("/data/push", { recursive: true, mode: 0o700 });
    const bytes = new TextEncoder().encode("{}");
    expect(await fs.storeWriteFile("/data/push/devices.json", bytes, { mode: 0o600 })).toEqual({ ok: true, durable: true });
    expect(fs.text("/data/push/devices.json")).toBe("{}");
    expect(fs.files.get("/data/push/devices.json")?.mode).toBe(0o600);
    fs.failNext("storeWrite", { code: "ENOSPC", step: "rename" });
    expect(await fs.storeWriteFile("/data/push/devices.json", bytes, { mode: 0o600 })).toEqual({
      ok: false,
      kind: "io",
      step: "rename",
      code: "ENOSPC",
    });
    fs.failAlways("readFile", { code: "EACCES" });
    await expect(fs.storeReadFile("/data/push/devices.json")).rejects.toMatchObject({ code: "EACCES" });
    fs.failAlways("readFile", null);
    expect(new TextDecoder().decode(await fs.readFile("/data/push/devices.json"))).toBe("{}");
  });
});
