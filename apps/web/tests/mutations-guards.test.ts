// apps/web/tests/mutations-guards.test.ts — the pure, never-throwing mutation request guards
// (mutation-foundation 03-mutation-dispatcher.md §3; 10-testing-strategy.md §3.2).
//
// Pure unit suite: no router, no DOM, no port. Synthetic Requests set `Host` explicitly (03 §3.2 note: a
// Request built from a URL does not add it). Proves REQ-SEAM-03 (guard reasons), REQ-SEC-02 (same-origin),
// REQ-SEC-03 (bounded, strict body) and REQ-IDEM-01 (key grammar).

import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

import { INVALID_FIELDS_MAX_BYTES, MUTATION_BODY_MAX_BYTES } from "../src/server/mutations/constants.js";
import {
  checkContentType,
  checkSameOrigin,
  formatInvalidFields,
  type GuardResult,
  parseIdempotencyKey,
  parseStrictBody,
  readBoundedJson,
  zodIssuePaths,
} from "../src/server/mutations/guards.js";
import { newRequestId } from "../src/server/mutations/request-id.js";

const URL_ = "http://pulse.lan/api/mutations/acks";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

/** A counting stream of `total` bytes in `chunk`-sized pieces whose cancel() sets a flag. */
function countingStream(total: number, chunk = 1024): { stream: ReadableStream<Uint8Array>; state: { pulls: number; cancelled: boolean } } {
  const state = { pulls: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function post(body: BodyInit | null, extra: Record<string, string> = {}): Request {
  return new Request(URL_, { method: "POST", body, headers: { host: "pulse.lan", ...extra } });
}

function reasonOf<T>(r: GuardResult<T>): string {
  return r.ok ? "pass" : r.reason;
}

describe("newRequestId (REQ-SEAM-03)", () => {
  test("returns a fresh v4 UUID string", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("checkSameOrigin — 03 §3.2 truth table (REQ-SEC-02, REQ-SEAM-03)", () => {
  // [row, headers, expected, alternates?] — rows with "any / absent" or "or" cells expand to several cases.
  const rows: readonly (readonly [number, readonly Record<string, string>[], "pass" | "cross-origin"])[] = [
    [1, [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin", origin: "null", host: "pulse.lan" }, { "sec-fetch-site": "same-origin", origin: "not a url" }], "pass"],
    [2, [{ "sec-fetch-site": "same-origin", origin: "https://evil.test", host: "pulse.lan" }], "pass"],
    [3, [{ "sec-fetch-site": "same-site", host: "pulse.lan" }], "cross-origin"],
    [4, [{ "sec-fetch-site": "cross-site" }], "cross-origin"],
    [5, [{ "sec-fetch-site": "none" }], "cross-origin"],
    [6, [{ "sec-fetch-site": "Same-Origin" }], "cross-origin"],
    [7, [{ origin: "https://pulse.lan", host: "pulse.lan" }], "pass"],
    [8, [{ origin: "https://pulse.lan", host: "pulse.lan:443" }], "pass"],
    [9, [{ origin: "http://pulse.lan:8080", host: "pulse.lan:8080" }], "pass"],
    [10, [{ origin: "https://PULSE.lan", host: "pulse.lan" }], "pass"],
    [11, [{ origin: "https://evil.test", host: "pulse.lan" }], "cross-origin"],
    [12, [{ origin: "https://pulse.lan:8443", host: "pulse.lan" }], "cross-origin"],
    [13, [{ origin: "http://pulse.lan", host: "pulse.lan:443" }], "cross-origin"],
    [14, [{ host: "pulse.lan" }], "cross-origin"],
    [15, [{ origin: "null", host: "pulse.lan" }], "cross-origin"],
    [16, [{ origin: "not a url", host: "pulse.lan" }], "cross-origin"],
    [17, [{ origin: "file:///x", host: "pulse.lan" }], "cross-origin"],
    [18, [{ origin: "https://pulse.lan/a", host: "pulse.lan" }], "cross-origin"],
    [19, [{ origin: "https://pulse.lan" }, { origin: "https://pulse.lan", host: "" }, { origin: "https://pulse.lan", host: "   " }], "cross-origin"],
    [20, [{ origin: "https://pulse.lan", host: "pulse.lan/x" }, { origin: "https://pulse.lan", host: "a@pulse.lan" }], "cross-origin"],
  ];

  test("the table has all 20 rows", () => {
    expect(rows.map(([n]) => n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  for (const [row, cases, expected] of rows) {
    test(`row ${row} → ${expected}`, () => {
      for (const init of cases) expect(reasonOf(checkSameOrigin(headers(init)))).toBe(expected);
    });
  }
});

describe("checkContentType (REQ-SEC-03, REQ-SEAM-03)", () => {
  test.each(["application/json", 'Application/JSON; charset="UTF-8"', "application/json; charset=utf-8", "application/json;"])(
    "accepts %p",
    (ct) => {
      expect(checkContentType(headers({ "content-type": ct }))).toEqual({ ok: true, value: null });
    },
  );

  test.each(["text/plain", "application/json; charset=latin1", "application/json; boundary=x", "application/jsonx", "application/json; charset"])(
    "rejects %p with invalid-body",
    (ct) => {
      expect(checkContentType(headers({ "content-type": ct }))).toEqual({ ok: false, reason: "invalid-body" });
    },
  );

  test("rejects a missing header with invalid-body", () => {
    expect(checkContentType(headers({}))).toEqual({ ok: false, reason: "invalid-body" });
  });
});

describe("readBoundedJson (REQ-SEC-03)", () => {
  test("Content-Length 16385 → body-too-large without reading the stream", async () => {
    const { stream, state } = countingStream(MUTATION_BODY_MAX_BYTES + 1);
    const req = post(stream, { "content-length": String(MUTATION_BODY_MAX_BYTES + 1) });
    const getReader = spyOn(req.body!, "getReader");
    const r = await readBoundedJson(req, MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "body-too-large" });
    expect(getReader).not.toHaveBeenCalled();
    expect(state.cancelled).toBe(true);
  });

  test("streamed 16385 B with no Content-Length → body-too-large and the reader is cancelled", async () => {
    const { stream, state } = countingStream(MUTATION_BODY_MAX_BYTES + 1);
    const req = post(stream);
    expect(req.headers.get("content-length")).toBeNull();
    const r = await readBoundedJson(req, MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "body-too-large" });
    expect(state.cancelled).toBe(true);
  });

  test("streamed 16385 B with a lying Content-Length → body-too-large and the reader is cancelled", async () => {
    const { stream, state } = countingStream(MUTATION_BODY_MAX_BYTES + 1);
    const req = post(stream, { "content-length": "10" });
    const r = await readBoundedJson(req, MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "body-too-large" });
    expect(state.cancelled).toBe(true);
  });

  test("exactly 16384 B passes with the exact bytes", async () => {
    const { stream, state } = countingStream(MUTATION_BODY_MAX_BYTES, 1000);
    const r = await readBoundedJson(post(stream), MUTATION_BODY_MAX_BYTES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.byteLength).toBe(MUTATION_BODY_MAX_BYTES);
      expect(r.value.every((b) => b === 0x20)).toBe(true);
    }
    expect(state.cancelled).toBe(false);
  });

  test("a small string body passes with a matching Content-Length", async () => {
    const text = '{"fingerprint":"abc"}';
    const r = await readBoundedJson(post(text, { "content-length": String(text.length) }), MUTATION_BODY_MAX_BYTES);
    expect(r.ok && new TextDecoder().decode(r.value)).toBe(text);
  });

  test.each(["abc", "-1", "1.5", "", "1234567890123456"])("non-numeric Content-Length %p → invalid-body", async (cl) => {
    const r = await readBoundedJson(post("{}", { "content-length": cl }), MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
  });

  test("a null body → invalid-body", async () => {
    const r = await readBoundedJson(post(null), MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
  });

  test("a stream error mid-body → invalid-body (never rejects)", async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        n += 1;
        if (n > 1) controller.error(new Error("client aborted"));
        else controller.enqueue(new Uint8Array(10));
      },
    });
    const r = await readBoundedJson(post(stream), MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
  });

  test("an already-consumed body → invalid-body (never rejects)", async () => {
    const req = post("{}");
    await req.text();
    const r = await readBoundedJson(req, MUTATION_BODY_MAX_BYTES);
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
  });
});

describe("parseIdempotencyKey (REQ-IDEM-01)", () => {
  const refused = { ok: false, reason: "missing-idempotency-key" } as const;

  test("absent → missing-idempotency-key", () => {
    expect(parseIdempotencyKey(headers({}))).toEqual(refused);
  });

  test.each([
    ["7 chars", "abcdefg"],
    ["129 chars", "a".repeat(129)],
    ["illegal char", "abcd.efgh"],
    ["space", "abcd efgh"],
    ["empty", ""],
  ])("malformed (%s) → missing-idempotency-key", (_label, key) => {
    expect(parseIdempotencyKey(headers({ "idempotency-key": key }))).toEqual(refused);
  });

  test.each(["abcdefgh", "a".repeat(128), "Ab-_09xyZ_-", "q7Rk2V-8xY_mZ3pL0aBcDe"])("accepts %p", (key) => {
    expect(parseIdempotencyKey(headers({ "Idempotency-Key": key }))).toEqual({ ok: true, value: key });
  });
});

describe("parseStrictBody (REQ-SEC-03, REQ-SEAM-03)", () => {
  const schema = z
    .object({
      fingerprint: z.string().min(1),
      note: z.string().max(5).optional(),
      matchers: z.array(z.object({ name: z.string(), value: z.string().min(1) }).strict()).optional(),
    })
    .strict();
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("a valid body parses", () => {
    expect(parseStrictBody(schema, enc('{"fingerprint":"abc"}'))).toEqual({ ok: true, value: { fingerprint: "abc" } });
  });

  test("a leading BOM is stripped", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"fingerprint":"abc"}')]);
    expect(parseStrictBody(schema, bytes).ok).toBe(true);
  });

  test("bad UTF-8 → invalid-body with no fields", () => {
    const r = parseStrictBody(schema, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
    expect("fields" in r).toBe(false);
  });

  test.each(["", "{", "not json", '{"fingerprint":"abc",}'])("bad JSON %p → invalid-body with no fields", (text) => {
    const r = parseStrictBody(schema, enc(text));
    expect(r).toEqual({ ok: false, reason: "invalid-body" });
    expect("fields" in r).toBe(false);
  });

  test("an unknown root key → fields '$' and never the key name", () => {
    const r = parseStrictBody(schema, enc('{"fingerprint":"abc","sneakyKeyName":1}'));
    expect(r).toEqual({ ok: false, reason: "invalid-body", fields: "$" });
    expect(JSON.stringify(r)).not.toContain("sneakyKeyName");
  });

  test("an unknown nested key → fields is the parent path, never the key name", () => {
    const r = parseStrictBody(schema, enc('{"fingerprint":"abc","matchers":[{"name":"a","value":"b","evilKey":1}]}'));
    expect(r).toEqual({ ok: false, reason: "invalid-body", fields: "matchers.0" });
    expect(JSON.stringify(r)).not.toContain("evilKey");
  });

  test("schema failures report paths and no values", () => {
    const r = parseStrictBody(schema, enc('{"fingerprint":"","note":"secret-value-too-long"}'));
    expect(r).toEqual({ ok: false, reason: "invalid-body", fields: "fingerprint,note" });
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  test("a non-object JSON value → fields '$'", () => {
    expect(parseStrictBody(schema, enc("[1,2]"))).toEqual({ ok: false, reason: "invalid-body", fields: "$" });
  });
});

describe("zodIssuePaths / formatInvalidFields (REQ-SEC-03)", () => {
  test("zodIssuePaths maps root to '$' and unsafe segments to '?'", () => {
    const result = z.record(z.object({ a: z.number() }).strict()).safeParse({ "bad key!": { a: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(zodIssuePaths(result.error.issues)).toEqual(["?.a"]);
    const root = z.string().safeParse(1);
    if (!root.success) expect(zodIssuePaths(root.error.issues)).toEqual(["$"]);
  });

  test("an empty list → undefined", () => {
    expect(formatInvalidFields([])).toBeUndefined();
  });

  test("deduplicated in first-seen order", () => {
    expect(formatInvalidFields(["b", "a", "b", "$", "a", "c.0"])).toBe("b,a,$,c.0");
  });

  test("unsafe segments become '?', and '?'-collapsed duplicates dedupe", () => {
    expect(formatInvalidFields(["matchers.0.<script>", "matchers.0.x y", "rationale", "a..b"])).toBe("matchers.0.?,rationale,a.?.b");
  });

  test("a segment longer than 64 chars becomes '?'", () => {
    expect(formatInvalidFields([`${"a".repeat(65)}.b`, `${"a".repeat(64)}`])).toBe(`?.b,${"a".repeat(64)}`);
  });

  test("output is ≤ 512 bytes, cut at a whole-path boundary", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `field_${i}.nested_${i}`);
    const out = formatInvalidFields(paths);
    expect(out).toBeDefined();
    expect(new TextEncoder().encode(out!).byteLength).toBeLessThanOrEqual(INVALID_FIELDS_MAX_BYTES);
    const parts = out!.split(",");
    expect(parts).toEqual(paths.slice(0, parts.length));
    expect(out! + `,${paths[parts.length]}`).toHaveLength(out!.length + 1 + paths[parts.length]!.length);
    expect((out! + `,${paths[parts.length]}`).length).toBeGreaterThan(INVALID_FIELDS_MAX_BYTES);
  });

  test("multibyte/control input never leaks: output is ASCII-only with no values", () => {
    const out = formatInvalidFields(["note.é\u0007x", "‮", "value=secret"]);
    expect(out).toBe("note.?,?");
    expect(out).toMatch(/^[A-Za-z0-9_.,$?]*$/);
  });
});
