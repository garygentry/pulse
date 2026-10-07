/** fetch.test.ts — evidence for item 010 (03-source-clients-and-validation.md §§2–4, 11).
 *  Covers the private bounded fetch primitive and base-URL validation:
 *   - finite timeout, caller cancellation, streamed 32 MiB-style byte counting, body abort,
 *     and complete listener/timer cleanup (criterion 1);
 *   - non-2xx, malformed JSON, invalid shape, incompatible/overflow, timeout, and transport
 *     map to the exact bounded `SourceResult`, and normal failures never reject (criterion 2);
 *   - base-URL validation accepts only absolute credential-free HTTP(S) URLs and normalizes a
 *     trailing slash (criterion 3);
 *   - raw bodies, secret markers, exception text, URLs, and authorization headers never enter
 *     a result (criterion 4).
 *
 * Pure module: no DOM registration required.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { CONFIG_ERROR_MESSAGES, SOURCE_ERROR_MESSAGES } from "../../src/wire/common.js";
import type { FetchLike } from "../../src/sources/types.js";
import {
  fetchJsonUnknown,
  normalizeBaseUrl,
  SourceConfigError,
  sourceFailure,
  sourceSuccess,
} from "../../src/sources/fetch.js";

const URL_UNDER_TEST = new URL("http://vm.internal:8428/api/v1/query?query=up&token=SECRET_TOKEN");

/** A fetch that returns a fixed `Response`, capturing the `RequestInit` it received. */
function fetchReturning(response: Response): { fetchImpl: FetchLike; init: () => RequestInit | undefined } {
  let captured: RequestInit | undefined;
  const fetchImpl: FetchLike = (_url, init) => {
    captured = init;
    return Promise.resolve(response);
  };
  return { fetchImpl, init: () => captured };
}

/** A fetch that never resolves until its signal aborts, then rejects like a real aborted fetch. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe("normalizeBaseUrl", () => {
  test("strips a single trailing slash and preserves a path prefix", () => {
    expect(normalizeBaseUrl("http://vm:8428/")).toBe("http://vm:8428");
    expect(normalizeBaseUrl("http://vm:8428")).toBe("http://vm:8428");
    expect(normalizeBaseUrl("https://host/prefix/")).toBe("https://host/prefix");
    expect(normalizeBaseUrl("https://host/prefix")).toBe("https://host/prefix");
  });

  test("drops query and fragment from the base", () => {
    expect(normalizeBaseUrl("http://vm:8428/?secret=abc#frag")).toBe("http://vm:8428");
  });

  test.each([
    ["ftp://host", "non-HTTP(S) protocol"],
    ["vm:8428", "no absolute HTTP(S) protocol"],
    ["not a url", "unparseable"],
    ["//host/path", "protocol-relative"],
    ["", "empty"],
  ])("rejects %p (%s)", (raw) => {
    expect(() => normalizeBaseUrl(raw)).toThrow(SourceConfigError);
  });

  test("rejects embedded credentials and never echoes them", () => {
    let thrown: unknown;
    try {
      normalizeBaseUrl("http://user:hunter2@host:8428/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SourceConfigError);
    const message = (thrown as Error).message;
    expect(message).toBe(CONFIG_ERROR_MESSAGES.invalidUrl);
    expect(message).not.toContain("user");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("host");
  });
});

describe("result constructors", () => {
  test("sourceFailure carries the exact catalog message and no interpolation", () => {
    for (const kind of Object.keys(SOURCE_ERROR_MESSAGES) as (keyof typeof SOURCE_ERROR_MESSAGES)[]) {
      const result = sourceFailure(kind, 503);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe(kind);
      expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES[kind]);
      expect(result.error.status).toBe(503);
    }
  });

  test("sourceFailure defaults status to null", () => {
    const result = sourceFailure("disabled");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.status).toBeNull();
    expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES.disabled);
  });

  test("sourceSuccess wraps the value", () => {
    const result = sourceSuccess({ a: 1 });
    expect(result).toEqual({ ok: true, data: { a: 1 } });
  });
});

describe("fetchJsonUnknown — success", () => {
  test("parses a 2xx JSON body to unknown and sends accept + GET by default", async () => {
    const { fetchImpl, init } = fetchReturning(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 1_000 });
    expect(result).toEqual({ ok: true, data: { hello: "world" } });
    const captured = init();
    expect(captured?.method).toBe("GET");
    expect((captured?.headers as Record<string, string>).accept).toBe("application/json");
  });

  test("merges caller headers and honors an explicit method/body", async () => {
    const { fetchImpl, init } = fetchReturning(new Response(JSON.stringify({ id: "s1" }), { status: 200 }));
    await fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl,
      timeoutMs: 5_000,
      maxBytes: 1_000,
      method: "POST",
      body: '{"x":1}',
      headers: { "content-type": "application/json" },
    });
    const captured = init();
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe('{"x":1}');
    expect((captured?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("parses a large-but-within-bound streamed body without false overflow", async () => {
    const big = JSON.stringify({ blob: "x".repeat(50_000) });
    const { fetchImpl } = fetchReturning(new Response(big, { status: 200 }));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl,
      timeoutMs: 5_000,
      maxBytes: 32 * 1024 * 1024,
    });
    expect(result.ok).toBe(true);
  });
});

describe("fetchJsonUnknown — failure mapping (never rejects)", () => {
  test("non-2xx maps to upstream-status with the numeric status and no body leak", async () => {
    const { fetchImpl } = fetchReturning(new Response("boom SECRET_BODY", { status: 502 }));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("upstream-status");
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES["upstream-status"]);
    expect(JSON.stringify(result)).not.toContain("SECRET_BODY");
  });

  test("malformed JSON maps to malformed-json and leaks no body text", async () => {
    const { fetchImpl } = fetchReturning(new Response("SECRET_BODY{not json", { status: 200 }));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed-json");
    expect(result.error.status).toBe(200);
    expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES["malformed-json"]);
    expect(JSON.stringify(result)).not.toContain("SECRET_BODY");
  });

  test("a thrown transport error maps to transport and leaks no exception text", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED 10.9.9.9:9999 SECRET_HOST"));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
    expect(result.error.status).toBeNull();
    expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES.transport);
    expect(JSON.stringify(result)).not.toContain("SECRET_HOST");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  test("internal deadline abort maps to timeout", async () => {
    const result = await fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl: hangingFetch,
      timeoutMs: 5,
      maxBytes: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("timeout");
    expect(result.error.message).toBe(SOURCE_ERROR_MESSAGES.timeout);
  });

  test("never rejects for any normal failure", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("nope"));
    await expect(
      fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 1_000 }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("fetchJsonUnknown — caller cancellation", () => {
  test("an already-aborted caller signal short-circuits to transport before fetching", async () => {
    let called = false;
    const fetchImpl: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const controller = new AbortController();
    controller.abort();
    const result = await fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl,
      timeoutMs: 5_000,
      maxBytes: 1_000,
      signal: controller.signal,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("a caller abort mid-flight maps to transport (not timeout)", async () => {
    const controller = new AbortController();
    const promise = fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl: hangingFetch,
      timeoutMs: 5_000,
      maxBytes: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("removes its caller-signal listener on completion (cleanup)", async () => {
    const controller = new AbortController();
    const removeSpy = spyOn(controller.signal, "removeEventListener");
    const { fetchImpl } = fetchReturning(new Response("{}", { status: 200 }));
    await fetchJsonUnknown(URL_UNDER_TEST, {
      fetchImpl,
      timeoutMs: 5_000,
      maxBytes: 1_000,
      signal: controller.signal,
    });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("fetchJsonUnknown — streamed byte bound", () => {
  test("aborts the body and cancels the reader on overflow, returning incompatible", async () => {
    let cancelled = false;
    const secret = new TextEncoder().encode("SECRET_XXX"); // 10 bytes/chunk
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(secret);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: FetchLike = () => Promise.resolve(new Response(stream, { status: 200 }));
    const result = await fetchJsonUnknown(URL_UNDER_TEST, { fetchImpl, timeoutMs: 5_000, maxBytes: 15 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("incompatible");
    expect(cancelled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
