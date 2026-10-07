// mutations-client.test.ts — the browser mutation client (09 §2; 00 §10.1).
// Every fetch is a stub passed through the `fetchImpl` parameter; no real network.
import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES } from "@pulse/web-data/wire";
import {
  MutationClientError,
  REASON_TEXT,
  STORED_FAILURE_REASONS,
  codePoints,
  displayText,
  failureText,
  fieldHasError,
  newIdempotencyKey,
  postMutation,
} from "../src/client/mutations/client.js";
import { MUTATION_REASONS } from "../src/shared/mutations.js";
import { IDEMPOTENCY_KEY_RE } from "../src/server/mutations/constants.js";

interface Captured {
  url: string;
  init: RequestInit;
}

/** A stub fetch that records its call and answers with `respond()`. */
function stubFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function refusalOf(p: Promise<unknown>): Promise<MutationClientError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MutationClientError) return err;
    throw err;
  }
  throw new Error("expected a MutationClientError");
}

const KEY = "abcdefgh12345678";

describe("postMutation request shape (REQ-UX-03, REQ-IDEM-01)", () => {
  test("sends POST, JSON content-type, Idempotency-Key and same-origin credentials", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ outcome: "succeeded", requestId: "r-1", result: { fingerprint: "fp", at: "t" } }),
    );
    const res = await postMutation<{ fingerprint: string; at: string }>(
      "/api/mutations/acks",
      { fingerprint: "fp" },
      KEY,
      fetchImpl,
    );
    expect(res).toEqual({ outcome: "succeeded", requestId: "r-1", result: { fingerprint: "fp", at: "t" } });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/api/mutations/acks");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("same-origin");
    expect(call.init.cache).toBe("no-store");
    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe(KEY);
    expect(call.init.body).toBe(JSON.stringify({ fingerprint: "fp" }));
  });
});

describe("postMutation refusal mapping (REQ-UX-02, REQ-SEC-06)", () => {
  test("a refusal maps details.reason, fields and requestId; the catalog message is never surfaced", async () => {
    const { fetchImpl } = stubFetch(() =>
      Response.json(
        {
          code: "INVALID_REQUEST",
          message: ERROR_MESSAGES.INVALID_REQUEST,
          details: { reason: "invalid-body", requestId: "req-42", fields: "rationale,matchers.0.value" },
        },
        { status: 400, headers: { "x-request-id": "header-id" } },
      ),
    );
    const err = await refusalOf(postMutation("/api/mutations/silences", {}, KEY, fetchImpl));
    expect(err.reason).toBe("invalid-body");
    expect(err.status).toBe(400);
    expect(err.requestId).toBe("req-42");
    expect(err.fields).toEqual(["rationale", "matchers.0.value"]);
    expect(err.message).not.toContain(ERROR_MESSAGES.INVALID_REQUEST);
    expect(failureText(err)).toBe(`${REASON_TEXT["invalid-body"]} (request req-42)`);
  });

  test("requestId falls back to the X-Request-Id header; absent fields → []", async () => {
    const { fetchImpl } = stubFetch(() =>
      Response.json(
        { code: "FORBIDDEN", message: "x", details: { reason: "capability-false" } },
        { status: 403, headers: { "x-request-id": "header-id" } },
      ),
    );
    const err = await refusalOf(postMutation("/api/mutations/acks", {}, KEY, fetchImpl));
    expect(err.reason).toBe("capability-false");
    expect(err.requestId).toBe("header-id");
    expect(err.fields).toEqual([]);
  });

  test("a thrown fetch maps to network with status 0 and no request id", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const err = await refusalOf(postMutation("/api/mutations/acks", {}, KEY, fetchImpl));
    expect(err.reason).toBe("network");
    expect(err.status).toBe(0);
    expect(err.requestId).toBeNull();
    expect(err.fields).toEqual([]);
    expect(failureText(err)).toBe(REASON_TEXT.network);
  });

  test("a non-JSON body maps to malformed-response (2xx and non-2xx)", async () => {
    for (const status of [200, 502]) {
      const { fetchImpl } = stubFetch(
        () => new Response("<html>gateway</html>", { status, headers: { "x-request-id": "h" } }),
      );
      const err = await refusalOf(postMutation("/api/mutations/acks", {}, KEY, fetchImpl));
      expect(err.reason).toBe("malformed-response");
      expect(err.status).toBe(status);
      expect(err.requestId).toBe("h");
    }
  });

  test("an ill-shaped 2xx body maps to malformed-response", async () => {
    const { fetchImpl } = stubFetch(() => Response.json({ outcome: "failed", requestId: "r" }));
    const err = await refusalOf(postMutation("/api/mutations/acks", {}, KEY, fetchImpl));
    expect(err.reason).toBe("malformed-response");
  });

  test("an unknown or missing details.reason maps to malformed-response", async () => {
    for (const body of [
      { code: "INTERNAL_ERROR", message: "m", details: { reason: "not-a-reason" } },
      { code: "METHOD_NOT_ALLOWED", message: "m" },
      ["array"],
    ]) {
      const { fetchImpl } = stubFetch(() => Response.json(body, { status: 405 }));
      const err = await refusalOf(postMutation("/api/mutations/acks", {}, KEY, fetchImpl));
      expect(err.reason).toBe("malformed-response");
      expect(err.status).toBe(405);
    }
  });
});

describe("REASON_TEXT (REQ-UX-02, REQ-SEC-07)", () => {
  test("has exactly MUTATION_REASONS.length + 2 keys, covering every reason plus network/malformed-response", () => {
    const keys = Object.keys(REASON_TEXT);
    expect(keys).toHaveLength(MUTATION_REASONS.length + 2);
    for (const r of MUTATION_REASONS) expect(keys).toContain(r);
    expect(keys).toContain("network");
    expect(keys).toContain("malformed-response");
  });

  test("no value equals or contains a catalog ERROR_MESSAGES string", () => {
    const catalog = Object.values(ERROR_MESSAGES);
    for (const text of Object.values(REASON_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
      for (const m of catalog) expect(text.includes(m)).toBe(false);
    }
  });

  test("STORED_FAILURE_REASONS is a subset of the REASON_TEXT keys and excludes pre-handler refusals", () => {
    for (const r of STORED_FAILURE_REASONS) expect(Object.keys(REASON_TEXT)).toContain(r);
    for (const r of ["invalid-body", "cross-origin", "network", "audit-unavailable"] as const) {
      expect(STORED_FAILURE_REASONS.has(r)).toBe(false);
    }
    expect(STORED_FAILURE_REASONS.has("upstream-timeout")).toBe(true);
  });
});

describe("newIdempotencyKey (REQ-UX-03, REQ-IDEM-01)", () => {
  test("matches IDEMPOTENCY_KEY_RE, is 22 chars, and two calls differ", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(IDEMPOTENCY_KEY_RE);
    expect(b).toMatch(IDEMPOTENCY_KEY_RE);
    expect(a).toHaveLength(22);
    expect(a).not.toBe(b);
  });
});

describe("fieldHasError (REQ-A11Y-03)", () => {
  test("matches the exact name or a sub-path, never a prefix of another name", () => {
    expect(fieldHasError(["rationale"], "rationale")).toBe(true);
    expect(fieldHasError(["matchers.0.value"], "matchers")).toBe(true);
    expect(fieldHasError(["matchersX"], "matchers")).toBe(false);
    expect(fieldHasError([], "rationale")).toBe(false);
  });
});

describe("displayText / codePoints (REQ-SEC-07)", () => {
  test("displayText replaces C0 (except \\t/\\n), DEL and C1 with U+FFFD", () => {
    expect(displayText("a\u0007b")).toBe("a�b");
    expect(displayText("a\u0000\u001f\u007f\u0085\u009fb")).toBe("a�����b");
    expect(displayText("line1\nline2\tx")).toBe("line1\nline2\tx");
    expect(displayText("<b>x</b>")).toBe("<b>x</b>");
  });

  test("codePoints counts an emoji as 1", () => {
    expect(codePoints("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(codePoints("a😀é")).toBe(3);
    expect(codePoints("")).toBe(0);
  });
});
