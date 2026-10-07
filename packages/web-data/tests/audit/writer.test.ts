// packages/web-data/tests/audit/writer.test.ts — durable JSONL audit writer evidence (09 §§6–8).
//
// Covers item 041 criteria 1–3: concurrent appends produce complete ordered canonical JSONL and
// loop on partial writes; success is acknowledged only after fsync; validation and
// open/write/partial/sync/close failures return exact bounded explicit results; close is idempotent
// after success; and the public factory exposes only an absolute path (no default/env/singleton).
//
// Deterministic failure cases inject an `open`/file-handle seam through the package-private internal
// factory; the integration cases use a real temp directory and read complete lines back with Node.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../../src/canonical.js";
import type { AuditEvent } from "../../src/audit/types.js";
import * as auditBarrel from "../../src/audit/index.js";
import { createJsonlAuditWriter } from "../../src/audit/index.js";
import {
  createJsonlAuditWriterInternal,
  type AuditFileHandle,
  type AuditOpen,
} from "../../src/audit/writer.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "pulse-audit-"));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

/** A synthetic, fully-valid audit event (all fixtures use synthetic identities only). */
function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    at: "2026-09-17T09:00:00.000Z",
    actor: { subject: "u-123", displayName: "Ada Operator", source: "proxy-header" },
    action: "silence.create",
    target: "alert:cpu-high",
    outcome: "attempted",
    requestId: "req-abc",
    correlationId: null,
    details: { severity: "critical", count: 3, dryRun: true, note: null },
    ...overrides,
  };
}

/** Decode the canonical line (without newline) the writer would produce for `e`. */
function canonicalLine(e: AuditEvent): string {
  return new TextDecoder().decode(canonicalJson(e));
}

interface FakeHandleOptions {
  readonly onWrite?: (chunk: Uint8Array) => number | "throw"; // returns bytesWritten, or "throw"
  readonly onSync?: () => void | "throw";
  readonly onClose?: () => void | "throw";
  readonly log?: string[];
}

/** An in-memory file handle recording its byte stream and an ordered op log. */
function fakeHandle(opts: FakeHandleOptions = {}): AuditFileHandle & { readonly bytes: () => Uint8Array } {
  const chunks: number[] = [];
  const log = opts.log ?? [];
  return {
    async write(data, offset, length) {
      const view = data.subarray(offset, offset + length);
      const decision = opts.onWrite ? opts.onWrite(view) : length;
      if (decision === "throw") {
        log.push("write:throw");
        throw new Error("injected write failure");
      }
      const n = Math.max(0, Math.min(decision, length));
      for (let i = 0; i < n; i += 1) chunks.push(view[i]!);
      log.push(`write:${n}`);
      return { bytesWritten: n };
    },
    async sync() {
      const decision = opts.onSync ? opts.onSync() : undefined;
      if (decision === "throw") {
        log.push("sync:throw");
        throw new Error("injected sync failure");
      }
      log.push("sync");
    },
    async close() {
      const decision = opts.onClose ? opts.onClose() : undefined;
      if (decision === "throw") {
        log.push("close:throw");
        throw new Error("injected close failure");
      }
      log.push("close");
    },
    bytes: () => new Uint8Array(chunks),
  };
}

// ── Public factory contract (criterion: absolute path only, no default) ──────────────────────────

describe("createJsonlAuditWriter — absolute path contract", () => {
  test("rejects an empty or relative path", () => {
    expect(() => createJsonlAuditWriter({ absolutePath: "" })).toThrow();
    expect(() => createJsonlAuditWriter({ absolutePath: "relative/audit.jsonl" })).toThrow();
    expect(() => createJsonlAuditWriter({ absolutePath: "./audit.jsonl" })).toThrow();
  });

  test("accepts an absolute path", () => {
    const path = join(TMP_ROOT, "accepts.jsonl");
    expect(() => createJsonlAuditWriter({ absolutePath: path })).not.toThrow();
  });
});

// ── Integration: real temp directory, complete ordered lines ─────────────────────────────────────

describe("durable JSONL integration", () => {
  test("one append writes exactly one canonical JSON object plus one newline", async () => {
    const path = join(TMP_ROOT, "single.jsonl");
    const writer = createJsonlAuditWriter({ absolutePath: path });
    const e = event();
    expect(await writer.append(e)).toEqual({ ok: true });
    expect((await writer.close()).ok).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(raw).toBe(`${canonicalLine(e)}\n`);
    // The line parses as JSON and its keys are canonically sorted.
    const parsed = JSON.parse(raw.trimEnd()) as Record<string, unknown>;
    expect(parsed.action).toBe("silence.create");
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });

  test(
    "concurrent appends produce complete, ordered, non-interleaved lines",
    async () => {
      const path = join(TMP_ROOT, "concurrent.jsonl");
      const writer = createJsonlAuditWriter({ absolutePath: path });
      const events = Array.from({ length: 12 }, (_, i) =>
        event({ requestId: `req-${i}`, details: { seq: i } }),
      );
      // Fire every append WITHOUT awaiting — the writer must serialize them in call order.
      const results = await Promise.all(events.map((e) => writer.append(e)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect((await writer.close()).ok).toBe(true);

      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines[lines.length - 1]).toBe(""); // trailing newline → empty final element
      const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as { requestId: string; details: { seq: number } });
      expect(parsed).toHaveLength(12);
      // Order preserved: seq 0..11 in call order, each a complete parseable object.
      expect(parsed.map((p) => p.details.seq)).toEqual(events.map((_, i) => i));
      expect(parsed.map((p) => p.requestId)).toEqual(events.map((_, i) => `req-${i}`));
    },
    // Each append performs a real fsync; under full-suite IO contention give it headroom.
    20_000,
  );
});

describe("AuditEvent.capability (M2 additive field)", () => {
  test("an event with capability \"ack\" is persisted verbatim in the JSONL line", async () => {
    const path = join(TMP_ROOT, "capability.jsonl");
    const writer = createJsonlAuditWriter({ absolutePath: path });
    const e = event({ action: "ack.set", capability: "ack" });
    expect(await writer.append(e)).toEqual({ ok: true });
    expect((await writer.close()).ok).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(raw).toBe(`${canonicalLine(e)}\n`);
    expect(raw).toContain('"capability":"ack"');
    expect((JSON.parse(raw.trimEnd()) as { capability?: string }).capability).toBe("ack");
  });
});

// ── Success follows fsync; partial-write loop ────────────────────────────────────────────────────

describe("write loop + durability ordering", () => {
  test("acknowledges success only after fsync completes", async () => {
    const log: string[] = [];
    const handle = fakeHandle({ log });
    const open: AuditOpen = async () => handle;
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    const result = await writer.append(event());
    expect(result).toEqual({ ok: true });
    // The op log ends with sync — success is never acknowledged before the line is synced.
    expect(log[log.length - 1]).toBe("sync");
    expect(log.includes("sync")).toBe(true);
    // The full canonical line + newline reached the handle.
    expect(new TextDecoder().decode(handle.bytes())).toBe(`${canonicalLine(event())}\n`);
  });

  test("loops on partial writes until every byte is written, then syncs", async () => {
    const log: string[] = [];
    // Write only 7 bytes per call to force the partial-write loop.
    const handle = fakeHandle({ log, onWrite: (chunk) => Math.min(7, chunk.length) });
    const open: AuditOpen = async () => handle;
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    const e = event();
    expect(await writer.append(e)).toEqual({ ok: true });
    const expected = `${canonicalLine(e)}\n`;
    expect(new TextDecoder().decode(handle.bytes())).toBe(expected);
    // More than one write call happened, and sync came last.
    expect(log.filter((x) => x.startsWith("write:")).length).toBeGreaterThan(1);
    expect(log[log.length - 1]).toBe("sync");
  });

  test("a zero-progress write is a bounded write failure (never an infinite loop)", async () => {
    const handle = fakeHandle({ onWrite: () => 0 });
    const open: AuditOpen = async () => handle;
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    expect(await writer.append(event())).toEqual({ ok: false, error: { kind: "write", message: expect.any(String) } });
  });
});

// ── Explicit failure mapping (criterion 2) ───────────────────────────────────────────────────────

describe("explicit failure results", () => {
  test("validation failure returns kind:write and never opens the file", async () => {
    let opens = 0;
    const open: AuditOpen = async () => {
      opens += 1;
      return fakeHandle();
    };
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });

    const bad: AuditEvent[] = [
      event({ action: "" }), // empty
      event({ target: "has\nnewline" }), // control char
      event({ outcome: "bogus" as AuditEvent["outcome"] }), // not in enum
      event({ requestId: "x".repeat(257) }), // > 256 bytes
      event({ at: "not-a-date" }), // unparseable timestamp
      event({ actor: { subject: "s", displayName: "d", source: "wrong" } as unknown as AuditEvent["actor"] }),
      event({ actor: { subject: "s", displayName: "d", source: "proxy-header", extra: 1 } as unknown as AuditEvent["actor"] }),
      event({ details: { nested: { a: 1 } } as unknown as AuditEvent["details"] }), // nested value
      event({ details: { n: Number.POSITIVE_INFINITY } as unknown as AuditEvent["details"] }), // non-finite
      event({ details: { authorization: "Bearer x" } }), // sensitive key
      // JSON.parse produces a real own enumerable "__proto__" key (a literal would set the prototype).
      event({ details: JSON.parse('{"__proto__":"x"}') as AuditEvent["details"] }), // prototype pollution
      event({ details: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])) }), // >32 entries
    ];
    for (const e of bad) {
      const r = await writer.append(e);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("write");
    }
    expect(opens).toBe(0); // a validation failure never touches the filesystem
  });

  test("open failure returns kind:open", async () => {
    const open: AuditOpen = async () => {
      throw new Error("EACCES");
    };
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    expect(await writer.append(event())).toEqual({ ok: false, error: { kind: "open", message: expect.any(String) } });
  });

  test("write failure returns kind:write", async () => {
    const open: AuditOpen = async () => fakeHandle({ onWrite: () => "throw" });
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    const r = await writer.append(event());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("write");
  });

  test("fsync failure returns kind:sync", async () => {
    const open: AuditOpen = async () => fakeHandle({ onSync: () => "throw" });
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    const r = await writer.append(event());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("sync");
  });

  test("close failure resolves kind:close and never rejects", async () => {
    const open: AuditOpen = async () => fakeHandle({ onClose: () => "throw" });
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    expect((await writer.append(event())).ok).toBe(true);
    const r = await writer.close(); // resolves, does not throw
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("close");
  });

  test("after a terminal write failure, the next append retries open (reset handle)", async () => {
    let opens = 0;
    let failNextWrite = true;
    const open: AuditOpen = async () => {
      opens += 1;
      return fakeHandle({ onWrite: (chunk) => (failNextWrite ? "throw" : chunk.length) });
    };
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });

    const first = await writer.append(event());
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.kind).toBe("write");
    expect(opens).toBe(1);

    failNextWrite = false;
    const second = await writer.append(event());
    expect(second.ok).toBe(true);
    expect(opens).toBe(2); // the torn handle was reset and open retried
  });
});

// ── Canonical determinism (criterion 1: complete, ordered, canonical JSONL) ──────────────────────
// The single-append integration test proves the TOP-LEVEL output keys are sorted, but not that the
// writer canonicalizes RECURSIVELY and INSERTION-ORDER-INDEPENDENTLY. A `JSON.stringify`-based
// writer would pass that test yet emit nested `details` keys in insertion order. These prove the
// writer uses the recursive canonical encoder (09 §6 "canonicalize key order so one event is
// deterministic"), which is the property a downstream log processor relies on.

describe("canonical determinism", () => {
  test("two deeply-equal events with different insertion order emit byte-identical lines", async () => {
    // Same data, but every object's keys are inserted in a DIFFERENT order (top-level and details).
    const a = {
      at: "2026-09-17T09:00:00.000Z",
      actor: { subject: "u-1", displayName: "Op", source: "proxy-header" },
      action: "silence.create",
      target: "alert:x",
      outcome: "attempted",
      requestId: "req-1",
      correlationId: null,
      details: { zeta: 1, alpha: "a", middle: true },
    } as unknown as AuditEvent;
    const b = {
      details: { middle: true, alpha: "a", zeta: 1 },
      correlationId: null,
      requestId: "req-1",
      outcome: "attempted",
      target: "alert:x",
      action: "silence.create",
      actor: { source: "proxy-header", displayName: "Op", subject: "u-1" },
      at: "2026-09-17T09:00:00.000Z",
    } as unknown as AuditEvent;

    const ha = fakeHandle();
    const hb = fakeHandle();
    const wa = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open: async () => ha });
    const wb = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open: async () => hb });
    expect((await wa.append(a)).ok).toBe(true);
    expect((await wb.append(b)).ok).toBe(true);

    const lineA = new TextDecoder().decode(ha.bytes());
    const lineB = new TextDecoder().decode(hb.bytes());
    expect(lineA).toBe(lineB); // insertion order is irrelevant → identical bytes

    // NESTED details keys are sorted in the emitted line (recursive canonicalization).
    const parsed = JSON.parse(lineA.trimEnd()) as { details: Record<string, unknown> };
    expect(Object.keys(parsed.details)).toEqual(["alpha", "middle", "zeta"]);
    // Non-vacuity: a JSON.stringify of the insertion-ordered `a` would NOT match the canonical line.
    expect(`${JSON.stringify(a)}\n`).not.toBe(lineA);
  });

  test("a non-null correlationId is accepted and canonicalized; a control-bearing one is rejected", async () => {
    const handle = fakeHandle();
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open: async () => handle });
    const e = event({ correlationId: "corr-42" });
    expect(await writer.append(e)).toEqual({ ok: true });
    expect(new TextDecoder().decode(handle.bytes())).toBe(`${canonicalLine(e)}\n`);
    const parsed = JSON.parse(new TextDecoder().decode(handle.bytes()).trimEnd()) as { correlationId: string };
    expect(parsed.correlationId).toBe("corr-42");

    // A non-null but control-bearing / oversized correlationId fails validation (never opens a 2nd line).
    const badControl = await writer.append(event({ correlationId: "corr\n42" }));
    expect(badControl).toEqual({ ok: false, error: { kind: "write", message: expect.any(String) } });
    const badLong = await writer.append(event({ correlationId: "c".repeat(257) }));
    expect(badLong.ok).toBe(false);
  });
});

// ── Bounded, value-free failure messages (criterion 2: "exact bounded explicit results"; §6) ─────
// Every AuditFailure.message is a fixed bounded operator diagnostic that never echoes event data or
// the audit path (types.ts: "never echoes event data or paths"). This is the audit analog of the
// package-wide source-client secret-leak assertions.

describe("bounded, value-free failure messages", () => {
  const MARKER = "SECRET-LEAK-MARKER-DO-NOT-SURFACE";

  /** Whether `s` contains any C0 (< 0x20), DEL (0x7f), or C1 (0x80–0x9f) control char. */
  function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
    }
    return false;
  }

  /** A message is safe: non-empty, single-line/control-free, bounded, and marker-free. */
  function assertSafeMessage(message: string): void {
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(hasControl(message)).toBe(false);
    expect(message).not.toContain(MARKER);
  }

  test("a validation failure never echoes the offending value into the message", async () => {
    let opens = 0;
    const writer = createJsonlAuditWriterInternal({
      absolutePath: "/audit.jsonl",
      open: async () => {
        opens += 1;
        return fakeHandle();
      },
    });
    // Each of these carries the MARKER inside the value/key that triggers rejection.
    const leaky: AuditEvent[] = [
      event({ target: `${MARKER}\nwith-newline` }), // control char in a bounded scalar
      event({ requestId: MARKER.repeat(10) }), // > 256 bytes
      event({ details: { note: MARKER.repeat(10) } }), // oversized detail value
      event({ details: { [`authorization-${MARKER}`]: "v" } }), // sensitive detail key
      event({ at: `not-a-date-${MARKER}` }), // unparseable timestamp
    ];
    for (const e of leaky) {
      const r = await writer.append(e);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("write");
        assertSafeMessage(r.error.message);
      }
    }
    expect(opens).toBe(0); // validation never touches the filesystem
  });

  test("open/write/sync/close failures return bounded messages that never echo the audit path", async () => {
    // The absolute path itself carries the MARKER; no failure message may echo it.
    const path = `/var/${MARKER}/audit.jsonl`;

    const openFail = createJsonlAuditWriterInternal({
      absolutePath: path,
      open: async () => {
        throw new Error(`EACCES ${MARKER}`);
      },
    });
    const openR = await openFail.append(event());
    expect(openR.ok).toBe(false);
    if (!openR.ok) {
      expect(openR.error.kind).toBe("open");
      assertSafeMessage(openR.error.message);
    }

    const writeFail = createJsonlAuditWriterInternal({
      absolutePath: path,
      open: async () => fakeHandle({ onWrite: () => "throw" }),
    });
    const writeR = await writeFail.append(event());
    expect(writeR.ok).toBe(false);
    if (!writeR.ok) assertSafeMessage(writeR.error.message);

    const syncFail = createJsonlAuditWriterInternal({
      absolutePath: path,
      open: async () => fakeHandle({ onSync: () => "throw" }),
    });
    const syncR = await syncFail.append(event());
    expect(syncR.ok).toBe(false);
    if (!syncR.ok) {
      expect(syncR.error.kind).toBe("sync");
      assertSafeMessage(syncR.error.message);
    }

    const closeFail = createJsonlAuditWriterInternal({
      absolutePath: path,
      open: async () => fakeHandle({ onClose: () => "throw" }),
    });
    expect((await closeFail.append(event())).ok).toBe(true);
    const closeR = await closeFail.close();
    expect(closeR.ok).toBe(false);
    if (!closeR.ok) {
      expect(closeR.error.kind).toBe("close");
      assertSafeMessage(closeR.error.message);
    }
  });
});

// ── Package surface: no default/singleton/leaked seam (criterion 3; §§7–8) ───────────────────────
// Criterion 3 forbids a production "path/default/singleton/…/rotation policy". The mutation-darkness
// guard proves no *reachable app* code constructs a writer; this proves the `/audit` PACKAGE surface
// itself ships nothing that could become one — the barrel's only runtime value export is the
// absolute-path factory. There is no pre-constructed singleton writer, no default-path/env constant,
// and the injectable internal seam (`createJsonlAuditWriterInternal`) is import-path-private and NOT
// re-exported to consumers.

describe("audit package surface — no default/singleton/leaked seam", () => {
  test("the /audit barrel's only runtime export is the createJsonlAuditWriter factory", () => {
    // Type-only exports are erased, so the runtime namespace holds exactly the value exports.
    expect(Object.keys(auditBarrel).sort()).toEqual(["createJsonlAuditWriter"]);
    // It is a factory function, not a pre-built singleton (an instance would expose append/close)
    // and not a default-path string constant.
    expect(typeof auditBarrel.createJsonlAuditWriter).toBe("function");
    // The injectable internal failure seam is never surfaced through the public barrel.
    expect((auditBarrel as Record<string, unknown>).createJsonlAuditWriterInternal).toBeUndefined();
  });

  test("two factory calls yield independent writers (no shared singleton state)", async () => {
    const ha = fakeHandle();
    const hb = fakeHandle();
    const wa = createJsonlAuditWriterInternal({ absolutePath: "/a.jsonl", open: async () => ha });
    const wb = createJsonlAuditWriterInternal({ absolutePath: "/b.jsonl", open: async () => hb });
    expect(wa).not.toBe(wb);
    // Closing one leaves the other fully usable — no module-level shared handle/state.
    expect((await wa.close()).ok).toBe(true);
    expect((await wb.append(event())).ok).toBe(true);
    expect(new TextDecoder().decode(hb.bytes())).toBe(`${canonicalLine(event())}\n`);
    // The closed writer stays closed (its own state), rejecting a later append.
    expect((await wa.append(event())).ok).toBe(false);
  });
});

// ── close() idempotency + serialization (criterion 2) ────────────────────────────────────────────

describe("close idempotency and serialization", () => {
  test("close is idempotent after a successful close", async () => {
    const open: AuditOpen = async () => fakeHandle();
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    expect((await writer.append(event())).ok).toBe(true);
    expect(await writer.close()).toEqual({ ok: true });
    expect(await writer.close()).toEqual({ ok: true }); // repeat → ok, no reject
    expect(await writer.close()).toEqual({ ok: true });
  });

  test("close waits for a prior in-flight append before closing", async () => {
    const log: string[] = [];
    const open: AuditOpen = async () => fakeHandle({ log });
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    // Do NOT await the append before calling close — close must sequence after it.
    const appendP = writer.append(event());
    const closeP = writer.close();
    const [a, c] = await Promise.all([appendP, closeP]);
    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
    // The append's write+sync happened before the close.
    expect(log).toEqual(["write:" + (canonicalLine(event()).length + 1), "sync", "close"]);
  });

  test("append after a successful close returns an explicit failure (no silent success)", async () => {
    const open: AuditOpen = async () => fakeHandle();
    const writer = createJsonlAuditWriterInternal({ absolutePath: "/audit.jsonl", open });
    expect((await writer.close()).ok).toBe(true);
    const r = await writer.append(event());
    expect(r.ok).toBe(false);
  });
});
