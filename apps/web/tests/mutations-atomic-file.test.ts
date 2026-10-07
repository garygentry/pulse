// apps/web/tests/mutations-atomic-file.test.ts — the crash-safe write primitive shared by the ack store
// (replace mode) and the proposal store (exclusive mode) (mutation-foundation
// 06-acks-store-and-cycle.md §2, §9; 10-testing-strategy.md §3.2; PRD §7 atomicity, REQ-ACK-03).
//
// Every test gets its own mkdtemp directory. Failures are injected root-proof: a missing parent
// directory (open → ENOENT) and a destination that is a non-empty directory (rename → EISDIR). The
// read-only-directory case only runs when not root, because root ignores directory permissions. The tmp
// name is observed by polling the directory during a large write.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AtomicWriteResult, writeFileAtomic } from "../src/server/mutations/stores/atomic-file.js";

const IS_ROOT = process.getuid?.() === 0;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-atomic-"));
});

afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // already removed or never restricted
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Entries in `d` that look like a tmp sibling of `base`. */
function tmpEntries(d: string, base: string): string[] {
  return readdirSync(d).filter((n) => n.startsWith(`${base}.tmp-`));
}

describe("writeFileAtomic replace mode (REQ-ACK-03, PRD §7 atomicity)", () => {
  test("writes the complete bytes to a new path and reports durable (PRD §7 atomicity)", async () => {
    const path = join(dir, "acks.json");
    const bytes = enc(`${"x".repeat(200_000)}\n`);
    const res = await writeFileAtomic(path, bytes);
    expect(res).toEqual({ ok: true, durable: true });
    expect(new Uint8Array(readFileSync(path)) as Uint8Array).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(["acks.json"]);
  });

  test("overwrites an existing file with the new bytes and leaves no tmp sibling (REQ-ACK-03)", async () => {
    const path = join(dir, "acks.json");
    writeFileSync(path, "old content that is longer than the new one\n");
    const res = await writeFileAtomic(path, enc("new\n"));
    expect(res).toEqual({ ok: true, durable: true });
    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(tmpEntries(dir, "acks.json")).toEqual([]);
  });

  test("an empty byte array produces an empty file", async () => {
    const path = join(dir, "empty.json");
    expect(await writeFileAtomic(path, new Uint8Array(0))).toEqual({ ok: true, durable: true });
    expect(readFileSync(path).byteLength).toBe(0);
  });

  test("the created file uses mode 0o640 by default and honours an explicit mode", async () => {
    const prev = process.umask(0o022);
    try {
      const a = join(dir, "a.json");
      const b = join(dir, "b.json");
      await writeFileAtomic(a, enc("a"));
      await writeFileAtomic(b, enc("b"), { mode: 0o600 });
      expect(statSync(a).mode & 0o777).toBe(0o640);
      expect(statSync(b).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(prev);
    }
  });

  test("a failed rename (destination is a non-empty directory) → io at step rename, destination intact, no tmp (PRD §7 atomicity)", async () => {
    const path = join(dir, "acks.json");
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "keep");
    const res = await writeFileAtomic(path, enc("new\n"));
    expect(res).toEqual({ ok: false, kind: "io", step: "rename", code: expect.any(String) });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(path)).toEqual(["keep.txt"]);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep");
    expect(tmpEntries(dir, "acks.json")).toEqual([]);
  });

  test.skipIf(IS_ROOT)(
    "a read-only directory → io with a non-null step, existing file byte-identical, no tmp (REQ-ACK-03, PRD §7 atomicity)",
    async () => {
      const path = join(dir, "acks.json");
      const original = enc('{"format":"pulse-acks/v1","acks":{}}\n');
      writeFileSync(path, original);
      chmodSync(dir, 0o555);
      const res = await writeFileAtomic(path, enc("replacement\n"));
      chmodSync(dir, 0o700);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res).toEqual({ ok: false, kind: "io", step: "open", code: "EACCES" });
      expect(new Uint8Array(readFileSync(path)) as Uint8Array).toEqual(original);
      expect(tmpEntries(dir, "acks.json")).toEqual([]);
    },
  );
});

describe("writeFileAtomic exclusive mode (REQ-ACK-03, PRD §7 atomicity)", () => {
  test("creates a new path with the exact bytes", async () => {
    const path = join(dir, "p-1.proposal.json");
    const bytes = enc('{"format":"pulse-proposal/v1"}\n');
    const res = await writeFileAtomic(path, bytes, { exclusive: true });
    expect(res).toEqual({ ok: true, durable: true });
    expect(new Uint8Array(readFileSync(path)) as Uint8Array).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(["p-1.proposal.json"]);
  });

  test("an existing path → exists at step link with EEXIST; the original is untouched and the tmp removed", async () => {
    const path = join(dir, "p-1.proposal.json");
    writeFileSync(path, "original\n");
    const res = await writeFileAtomic(path, enc("intruder\n"), { exclusive: true });
    expect(res).toEqual({ ok: false, kind: "exists", step: "link", code: "EEXIST" });
    expect(readFileSync(path, "utf8")).toBe("original\n");
    expect(readdirSync(dir)).toEqual(["p-1.proposal.json"]);
  });

  test("a non-EEXIST failure in exclusive mode is io, not exists", async () => {
    const res = await writeFileAtomic(join(dir, "missing", "p-1.proposal.json"), enc("x"), { exclusive: true });
    expect(res).toEqual({ ok: false, kind: "io", step: "open", code: "ENOENT" });
  });
});

describe("writeFileAtomic tmp sibling and failure contract (REQ-ACK-03, PRD §7 atomicity)", () => {
  test("the tmp sibling is named '<base>.tmp-<pid>-<n>' (observed in the directory mid-write)", async () => {
    const base = "acks.json";
    const path = join(dir, base);
    writeFileSync(path, "original\n");
    // A large payload keeps the tmp sibling on disk across several event-loop turns; poll the directory
    // until the write settles and record every tmp-looking name seen.
    const bytes = new Uint8Array(64 * 1024 * 1024).fill(0x61);
    let settled = false;
    const pending = writeFileAtomic(path, bytes).finally(() => void (settled = true));
    const seen = new Set<string>();
    while (!settled) {
      for (const n of tmpEntries(dir, base)) seen.add(n);
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(await pending).toEqual({ ok: true, durable: true });
    expect(seen.size).toBe(1);
    const [name] = [...seen];
    const m = /^acks\.json\.tmp-(\d+)-(\d+)$/.exec(name ?? "");
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(process.pid);
    expect(Number(m?.[2])).toBeGreaterThan(0);
    // Committed by rename: the destination holds the new bytes and the tmp is gone.
    expect(statSync(path).size).toBe(bytes.byteLength);
    expect(tmpEntries(dir, base)).toEqual([]);

    // The per-module counter makes the next call use a different name.
    const seen2 = new Set<string>();
    let settled2 = false;
    const pending2 = writeFileAtomic(path, bytes).finally(() => void (settled2 = true));
    while (!settled2) {
      for (const n of tmpEntries(dir, base)) seen2.add(n);
      await new Promise<void>((r) => setImmediate(r));
    }
    await pending2;
    const [name2] = [...seen2];
    expect(name2).toMatch(/^acks\.json\.tmp-\d+-\d+$/);
    expect(Number(/-(\d+)$/.exec(name2 ?? "")?.[1])).toBeGreaterThan(Number(m?.[2]));
  });

  test("successive writes to one path each succeed and leave no tmp sibling", async () => {
    const base = "seq.json";
    const path = join(dir, base);
    expect(await writeFileAtomic(path, enc("1"))).toEqual({ ok: true, durable: true });
    expect(await writeFileAtomic(path, enc("2"))).toEqual({ ok: true, durable: true });
    expect(readFileSync(path, "utf8")).toBe("2");
    expect(tmpEntries(dir, base)).toEqual([]);
  });

  test("never rejects: an invalid parent dir resolves to io at step open", async () => {
    const promise = writeFileAtomic(join(dir, "does", "not", "exist", "acks.json"), enc("x"));
    let res: AtomicWriteResult | undefined;
    let rejected = false;
    await promise.then(
      (r) => void (res = r),
      () => void (rejected = true),
    );
    expect(rejected).toBe(false);
    expect(res).toEqual({ ok: false, kind: "io", step: "open", code: "ENOENT" });
    expect(existsSync(join(dir, "does"))).toBe(false);
  });

  test("the failure result carries only bounded fields — no path and no error message", async () => {
    const secretish = join(dir, "missing-dir-canary", "acks.json");
    const res = await writeFileAtomic(secretish, enc("x"));
    expect(Object.keys(res).sort()).toEqual(["code", "kind", "ok", "step"]);
    const text = JSON.stringify(res);
    expect(text).not.toContain("missing-dir-canary");
    expect(text).not.toContain("no such file");
  });

  test("concurrent writes to different paths in one process never share a tmp name", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => join(dir, `f${i}.json`));
    const results = await Promise.all(paths.map((p, i) => writeFileAtomic(p, enc(`v${i}`))));
    for (const r of results) expect(r).toEqual({ ok: true, durable: true });
    paths.forEach((p, i) => expect(readFileSync(p, "utf8")).toBe(`v${i}`));
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
