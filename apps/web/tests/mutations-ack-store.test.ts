// apps/web/tests/mutations-ack-store.test.ts — the durable Pulse-local ack store
// (mutation-foundation 06-acks-store-and-cycle.md §3, §9; 10-testing-strategy.md §3.2).
//
// Every test gets its own mkdtemp directory and a fake WritePath that records markFailed calls.
// Persist failures are injected root-proof: the acks.json path is replaced by a non-empty directory
// after load, so `rename(tmp, path)` fails (EISDIR). File writes are counted by spying on the
// atomic-file module export the store calls.

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AlertmanagerAlert, AlertmanagerAlertState, SourceRecord } from "@pulse/web-data/sources";
import {
  ackFileSchema,
  createAckStore,
  fingerprintSchema,
  storedNoteSchema,
  type AckFileV1,
  type AckRecord,
  type AckStore,
  type StoreWriteResult,
} from "../src/server/mutations/stores/ack-store.js";
import * as atomicFile from "../src/server/mutations/stores/atomic-file.js";
import type { StoreStatus, WritePath, WritePathSnapshot } from "../src/server/mutations/write-path.js";
import { __resetMetricsForTest, renderMetrics } from "../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../src/server/refresh.js";

/** ACK_FILE_MAX_BYTES is module-private in ack-store.ts (06 §3.1); pinned here as a literal. */
const ACK_FILE_MAX_BYTES = 16 * 1024 * 1024;

type MarkCall = readonly [store: string, reason: string];

interface FakeWritePath extends WritePath {
  readonly marks: MarkCall[];
}

function fakeWritePath(): FakeWritePath {
  const marks: MarkCall[] = [];
  return {
    marks,
    snapshot: () => ({}) as WritePathSnapshot,
    markFailed(store, reason) {
      marks.push([store, reason]);
    },
    probe: async () => ({}) as WritePathSnapshot,
  };
}

function rec(displayName: string, note: string | null = null, at = "2026-09-28T14:03:11.000Z"): AckRecord {
  return { actor: { subject: `${displayName}-subject-canary`, displayName }, at, note };
}

function amAlert(fingerprint: string, state: AlertmanagerAlertState = "firing"): AlertmanagerAlert {
  return {
    fingerprint,
    state,
    name: "DiskFull",
    severity: "critical",
    startsAt: "2026-09-28T13:00:00.000Z",
    endsAt: "2026-09-28T15:00:00.000Z",
    labels: { alertname: "DiskFull" },
    annotations: {},
    receivers: [],
    silencedBy: state === "silenced" ? ["s1"] : [],
    inhibitedBy: state === "inhibited" ? ["a0"] : [],
    group: null,
  } as unknown as AlertmanagerAlert;
}

function okRecord(alerts: readonly AlertmanagerAlert[]): SourceRecord<readonly AlertmanagerAlert[]> {
  return {
    latest: { attemptedAt: "2026-09-28T14:10:00.000Z", result: { ok: true, data: alerts } },
    lastGood: { at: "2026-09-28T14:10:00.000Z", data: alerts },
  };
}

function failedRecord(withLastGood: boolean): SourceRecord<readonly AlertmanagerAlert[]> {
  return {
    latest: {
      attemptedAt: "2026-09-28T14:10:00.000Z",
      result: { ok: false, error: { kind: "timeout", message: "timed out", status: null } },
    },
    lastGood: withLastGood ? { at: "2026-09-28T14:00:00.000Z", data: [] } : null,
  };
}

function metricsText(): string {
  return renderMetrics(getRuntimeStatus(), Date.now());
}

let dir = "";
let path = "";
let logSpy: Mock<typeof console.log>;
let writeSpy: Mock<typeof atomicFile.writeFileAtomic>;

function logLines(): Record<string, unknown>[] {
  return logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

beforeEach(() => {
  __resetMetricsForTest();
  dir = mkdtempSync(join(tmpdir(), "pulse-acks-"));
  path = join(dir, "acks.json");
  logSpy = spyOn(console, "log").mockImplementation(() => undefined);
  writeSpy = spyOn(atomicFile, "writeFileAtomic");
});

afterEach(() => {
  logSpy.mockRestore();
  writeSpy.mockRestore();
  __resetMetricsForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** Replace acks.json with a non-empty directory, so the next atomic rename fails. */
function breakDestination(): void {
  rmSync(path, { force: true });
  mkdirSync(join(path, "blocker"), { recursive: true });
}

describe("ack store exports (00 §11.1)", () => {
  test("schemas and types are exported", () => {
    const file: AckFileV1 = { format: "pulse-acks/v1", acks: { fp1: rec("Alice") } };
    const ok: StoreWriteResult<boolean> = { ok: true, value: true };
    expect(ackFileSchema.safeParse(file).success).toBe(true);
    expect(fingerprintSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(fingerprintSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(fingerprintSchema.safeParse("a\u0007").success).toBe(false);
    expect(fingerprintSchema.safeParse("").success).toBe(false);
    expect(storedNoteSchema.safeParse("line1\nline2").success).toBe(true);
    expect(storedNoteSchema.safeParse("x".repeat(280)).success).toBe(true);
    expect(storedNoteSchema.safeParse("x".repeat(281)).success).toBe(false);
    expect(storedNoteSchema.safeParse("a\tb").success).toBe(false);
    expect(storedNoteSchema.safeParse("").success).toBe(false);
    expect(ok.ok).toBe(true);
  });
});

describe("ack store load and restart (REQ-ACK-03, REQ-CFG-02)", () => {
  test("missing file → loadStatus ok, empty foldView, no markFailed (REQ-ACK-03)", async () => {
    const wp = fakeWritePath();
    const store = await createAckStore(path, { writePath: wp });
    expect(store.loadStatus).toEqual({ ok: true, reason: null });
    expect(store.foldView().size).toBe(0);
    expect(wp.marks).toEqual([]);
  });

  test("a valid file round-trips across a re-created store (restart, REQ-ACK-03)", async () => {
    const first = await createAckStore(path, { writePath: fakeWritePath() });
    expect(await first.set("fp1", rec("Alice", "Investigating\nswap at 16:00"))).toEqual({
      ok: true,
      value: rec("Alice", "Investigating\nswap at 16:00"),
    });
    expect((await first.set("fp2", rec("Bob"))).ok).toBe(true);

    const second = await createAckStore(path, { writePath: fakeWritePath() });
    expect(second.loadStatus).toEqual({ ok: true, reason: null });
    expect(second.get("fp1")).toEqual(rec("Alice", "Investigating\nswap at 16:00"));
    expect(second.get("fp2")).toEqual(rec("Bob"));
    expect([...second.foldView().entries()]).toEqual([...first.foldView().entries()]);
  });

  test("the file is canonical: sorted keys at every level, 2-space indent, trailing newline", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("zz", rec("Zed", "n"));
    await store.set("aa", rec("Ann"));
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(text) as AckFileV1;
    expect(text).toBe(
      `${JSON.stringify(
        {
          acks: {
            aa: { actor: { displayName: "Ann", subject: "Ann-subject-canary" }, at: rec("Ann").at, note: null },
            zz: { actor: { displayName: "Zed", subject: "Zed-subject-canary" }, at: rec("Zed").at, note: "n" },
          },
          format: "pulse-acks/v1",
        },
        null,
        2,
      )}\n`,
    );
    expect(parsed.format).toBe("pulse-acks/v1");
  });

  const validRecord = { actor: { subject: "gary", displayName: "Gary" }, at: "2026-09-28T14:03:11.000Z", note: null };
  const CORRUPT_CASES: readonly (readonly [string, string])[] = [
    ["garbage JSON", "{not json"],
    ["an extra top-level key", JSON.stringify({ format: "pulse-acks/v1", acks: {}, extra: 1 })],
    ["an extra record key", JSON.stringify({ format: "pulse-acks/v1", acks: { fp: { ...validRecord, x: 1 } } })],
    [
      "a 281-code-point note",
      JSON.stringify({ format: "pulse-acks/v1", acks: { fp: { ...validRecord, note: "é".repeat(281) } } }),
    ],
    ["a 129-byte fingerprint key", JSON.stringify({ format: "pulse-acks/v1", acks: { ["f".repeat(129)]: validRecord } })],
    ["a wrong format", JSON.stringify({ format: "pulse-acks/v2", acks: {} })],
  ];

  for (const [name, content] of CORRUPT_CASES) {
    test(`${name} → corrupt, file preserved, writes refused (REQ-CFG-02)`, async () => {
      writeFileSync(path, content);
      const before = readFileSync(path);
      const mtimeBefore = statSync(path).mtimeMs;
      const wp = fakeWritePath();
      const store = await createAckStore(path, { writePath: wp });

      expect(store.loadStatus).toEqual({ ok: false, reason: "corrupt" });
      expect(wp.marks).toEqual([["acks", "corrupt"]]);
      const corruptLogs = logLines().filter((l) => l["event"] === "ack_store_corrupt");
      expect(corruptLogs).toHaveLength(1);
      expect(corruptLogs[0]).toMatchObject({ ok: false, path });
      expect(store.foldView().size).toBe(0);

      expect(await store.set("fp", rec("Alice"))).toEqual({ ok: false, error: "write-failed" });
      expect(await store.remove("fp")).toEqual({ ok: false, error: "write-failed" });
      expect(await store.set("fp2", rec("Bob"))).toEqual({ ok: false, error: "write-failed" });
      expect(await store.reconcile(okRecord([]))).toBe(0);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(readFileSync(path)).toEqual(before);
      expect(statSync(path).mtimeMs).toBe(mtimeBefore);
    });
  }

  test(`a file larger than ${ACK_FILE_MAX_BYTES} bytes → corrupt (REQ-CFG-02)`, async () => {
    writeFileSync(path, Buffer.alloc(ACK_FILE_MAX_BYTES + 1, 0x20));
    const wp = fakeWritePath();
    const store = await createAckStore(path, { writePath: wp });
    expect(store.loadStatus).toEqual({ ok: false, reason: "corrupt" });
    expect(wp.marks).toEqual([["acks", "corrupt"]]);
    expect(statSync(path).size).toBe(ACK_FILE_MAX_BYTES + 1);
  });

  test("a read error other than ENOENT (path is a directory) → unwritable, no corrupt log (REQ-CFG-02)", async () => {
    mkdirSync(path);
    const wp = fakeWritePath();
    const store = await createAckStore(path, { writePath: wp });
    expect(store.loadStatus).toEqual({ ok: false, reason: "unwritable" });
    expect(wp.marks).toEqual([["acks", "unwritable"]]);
    expect(logLines().some((l) => l["event"] === "ack_store_corrupt")).toBe(false);
    expect(await store.set("fp", rec("Alice"))).toEqual({ ok: false, error: "write-failed" });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(statSync(path).isDirectory()).toBe(true);
  });
});

describe("ack store writes (REQ-ACK-05)", () => {
  test("set replaces an existing record — last writer wins (REQ-ACK-05)", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("fp1", rec("Alice", "first"));
    const second = rec("Bob", "second", "2026-09-28T14:05:00.000Z");
    expect(await store.set("fp1", second)).toEqual({ ok: true, value: second });
    expect(store.get("fp1")).toEqual(second);
    expect(store.foldView().get("fp1")).toEqual({ by: "Bob", at: second.at, note: "second" });
    const reloaded = await createAckStore(path, { writePath: fakeWritePath() });
    expect(reloaded.get("fp1")).toEqual(second);
  });

  test("remove of an existing ack → value true and persisted", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("fp1", rec("Alice"));
    expect(await store.remove("fp1")).toEqual({ ok: true, value: true });
    expect(store.get("fp1")).toBeUndefined();
    const reloaded = await createAckStore(path, { writePath: fakeWritePath() });
    expect(reloaded.get("fp1")).toBeUndefined();
  });

  test("remove of an absent fingerprint → {ok:true,value:false} and no file write", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("fp1", rec("Alice"));
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    writeSpy.mockClear();
    expect(await store.remove("absent")).toEqual({ ok: true, value: false });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  test("remove on a fresh store with no file creates no file", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    expect(await store.remove("absent")).toEqual({ ok: true, value: false });
    expect(() => statSync(path)).toThrow();
  });

  test("an injected persist failure rolls back: get/foldView unchanged, markFailed('acks','write-failed')", async () => {
    const wp = fakeWritePath();
    const store = await createAckStore(path, { writePath: wp });
    await store.set("fp1", rec("Alice", "kept"));
    const viewBefore = store.foldView();
    const snapshot = [...viewBefore.entries()];
    breakDestination();

    expect(await store.set("fp1", rec("Mallory", "lost"))).toEqual({ ok: false, error: "write-failed" });
    expect(await store.set("fp2", rec("Bob"))).toEqual({ ok: false, error: "write-failed" });
    expect(await store.remove("fp1")).toEqual({ ok: false, error: "write-failed" });

    expect(store.get("fp1")).toEqual(rec("Alice", "kept"));
    expect(store.get("fp2")).toBeUndefined();
    expect(store.foldView()).toBe(viewBefore);
    expect([...store.foldView().entries()]).toEqual(snapshot);
    expect(wp.marks).toEqual([
      ["acks", "write-failed"],
      ["acks", "write-failed"],
      ["acks", "write-failed"],
    ]);
  });

  test("concurrent set() calls serialize: the file ends in the state of the last-enqueued set", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => store.set("fp", rec(`User${i}`, `note ${i}`))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.get("fp")).toEqual(rec(`User${n - 1}`, `note ${n - 1}`));
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as AckFileV1;
    expect(onDisk.acks["fp"]).toEqual(rec(`User${n - 1}`, `note ${n - 1}`));

    // Mixed concurrent sets on distinct keys all land.
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.set(`k${i}`, rec(`K${i}`))));
    const reloaded = await createAckStore(path, { writePath: fakeWritePath() });
    for (let i = 0; i < 10; i++) expect(reloaded.get(`k${i}`)).toEqual(rec(`K${i}`));
  });
});

describe("ack store foldView (REQ-SEC-06)", () => {
  test("foldView entries contain only by/at/note — no 'subject' anywhere (REQ-SEC-06)", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("fp1", rec("Alice", "n1"));
    await store.set("fp2", rec("Bob"));
    for (const entry of store.foldView().values()) {
      expect(Object.keys(entry).sort()).toEqual(["at", "by", "note"]);
    }
    expect(store.foldView().get("fp1")).toEqual({ by: "Alice", at: rec("Alice").at, note: "n1" });
    const serialized = JSON.stringify([...store.foldView().entries()]);
    expect(serialized).not.toContain("subject");
    expect(serialized).not.toContain("subject-canary");
  });

  test("foldView returns the same instance until the next commit", async () => {
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    await store.set("fp1", rec("Alice"));
    const a = store.foldView();
    expect(store.foldView()).toBe(a);
    await store.remove("absent");
    expect(store.foldView()).toBe(a);
    await store.set("fp2", rec("Bob"));
    expect(store.foldView()).not.toBe(a);
  });
});

describe("ack store reconcile — auto-clear (REQ-ACK-04, REQ-OBS-01)", () => {
  async function seeded(wp: WritePath = fakeWritePath()): Promise<AckStore> {
    const store = await createAckStore(path, { writePath: wp });
    await store.set("fp-a", rec("Alice"));
    await store.set("fp-b", rec("Bob"));
    await store.set("fp-c", rec("Carol"));
    writeSpy.mockClear();
    logSpy.mockClear();
    return store;
  }

  function autoClearLines(): Record<string, unknown>[] {
    return logLines().filter((l) => l["event"] === "ack_auto_cleared");
  }

  test("a not-ok latest with lastGood (stale) → 0 and no clear (REQ-ACK-04)", async () => {
    const store = await seeded();
    expect(await store.reconcile(failedRecord(true))).toBe(0);
    expect(store.foldView().size).toBe(3);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(autoClearLines()).toHaveLength(0);
  });

  test("a not-ok latest without lastGood (unavailable) → 0 and no clear (REQ-ACK-04)", async () => {
    const store = await seeded();
    expect(await store.reconcile(failedRecord(false))).toBe(0);
    expect(store.foldView().size).toBe(3);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("an ok latest listing silenced/inhibited alerts keeps their acks (REQ-ACK-04)", async () => {
    const store = await seeded();
    const n = await store.reconcile(
      okRecord([amAlert("fp-a", "firing"), amAlert("fp-b", "silenced"), amAlert("fp-c", "inhibited")]),
    );
    expect(n).toBe(0);
    expect([...store.foldView().keys()].sort()).toEqual(["fp-a", "fp-b", "fp-c"]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(autoClearLines()).toHaveLength(0);
    expect(metricsText()).toContain("pulse_web_ack_auto_clears_total 0");
  });

  test("an ok latest missing fingerprints clears them with one write, one metric increment and one log line (REQ-ACK-04, REQ-OBS-01)", async () => {
    const store = await seeded();
    const n = await store.reconcile(okRecord([amAlert("fp-b", "silenced"), amAlert("fp-other")]));
    expect(n).toBe(2);
    expect(store.get("fp-a")).toBeUndefined();
    expect(store.get("fp-c")).toBeUndefined();
    expect(store.get("fp-b")).toEqual(rec("Bob"));
    expect([...store.foldView().keys()]).toEqual(["fp-b"]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(metricsText()).toContain("pulse_web_ack_auto_clears_total 2");

    const lines = autoClearLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "ack_auto_cleared", ok: true, count: 2 });
    const raw = String(logSpy.mock.calls.find((c) => String(c[0]).includes("ack_auto_cleared"))?.[0]);
    expect(raw).not.toContain("fp-a");
    expect(raw).not.toContain("fp-c");

    const reloaded = await createAckStore(path, { writePath: fakeWritePath() });
    expect([...reloaded.foldView().keys()]).toEqual(["fp-b"]);

    // A second current cycle with no change writes nothing and does not bump the counter.
    expect(await store.reconcile(okRecord([amAlert("fp-b")]))).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(metricsText()).toContain("pulse_web_ack_auto_clears_total 2");
  });

  test("no change → no write, no log, no metric (REQ-ACK-04)", async () => {
    const store = await seeded();
    const bytes = readFileSync(path);
    expect(await store.reconcile(okRecord([amAlert("fp-a"), amAlert("fp-b"), amAlert("fp-c")]))).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(autoClearLines()).toHaveLength(0);
  });

  test("a persist failure → returns 0, acks kept, markFailed('acks','write-failed') (REQ-ACK-04)", async () => {
    const wp = fakeWritePath();
    const store = await seeded(wp);
    breakDestination();
    expect(await store.reconcile(okRecord([]))).toBe(0);
    expect([...store.foldView().keys()].sort()).toEqual(["fp-a", "fp-b", "fp-c"]);
    expect(wp.marks).toEqual([["acks", "write-failed"]]);
    expect(autoClearLines()).toHaveLength(0);
    expect(metricsText()).toContain("pulse_web_ack_auto_clears_total 0");
  });

  test("reconcile never throws on a malformed record", async () => {
    const store = await seeded();
    const bad = { latest: null } as unknown as SourceRecord<readonly AlertmanagerAlert[]>;
    expect(await store.reconcile(bad)).toBe(0);
  });
});

describe("ack store capacity (REQ-SCALE-01, 06 §3.8)", () => {
  test("1,024 worst-case records persist ≤ 16 MiB and reload with loadStatus ok (REQ-SCALE-01)", async () => {
    const records = new Map<string, AckRecord>();
    for (let i = 0; i < 1024; i++) {
      const id = i.toString(16).padStart(4, "0");
      const fp = id + "f".repeat(124); // 128 bytes
      const record: AckRecord = {
        actor: { subject: id + "s".repeat(508), displayName: id + "n".repeat(508) }, // 512 bytes each
        at: "2026-09-28T14:03:11.000Z",
        note: "\u{1F600}".repeat(280), // 280 code points, 1,120 bytes
      };
      records.set(fp, record);
    }
    const entries = [...records];
    const [lastFp, lastRecord] = entries[entries.length - 1]!;
    // Seed 1,023 records as a valid v1 file, then let the store persist the full 1,024-entry map.
    const seed: AckFileV1 = { format: "pulse-acks/v1", acks: Object.fromEntries(entries.slice(0, -1)) };
    writeFileSync(path, JSON.stringify(seed));
    const store = await createAckStore(path, { writePath: fakeWritePath() });
    expect(store.loadStatus).toEqual({ ok: true, reason: null });
    expect(await store.set(lastFp, lastRecord)).toEqual({ ok: true, value: lastRecord });

    const size = statSync(path).size;
    expect(size).toBeLessThanOrEqual(ACK_FILE_MAX_BYTES);
    expect(size).toBeGreaterThan(1024 * 2000);

    const reloaded = await createAckStore(path, { writePath: fakeWritePath() });
    expect(reloaded.loadStatus satisfies StoreStatus).toEqual({ ok: true, reason: null });
    expect(reloaded.foldView().size).toBe(1024);
    for (const [fp, r] of records) expect(reloaded.get(fp)).toEqual(r);
  }, 60_000);
});
