// apps/web/tests/connect-link-hook.test.ts — the connect screen's data hook: payload validation, the
// payload → state mapping, and the mounted loading → terminal-state machine with fetch stubbed.
import { describe, expect, it } from "bun:test";
import { CLIENT_TRANSPORT_MESSAGES } from "@pulse/web-data/wire";

import type { ConnectLinkPayload } from "../src/shared/connect-link.js";
import {
  CONNECT_LINK_PATH,
  parseConnectLinkPayload,
  resolveConnectLinkState,
  useConnectLink,
} from "../src/client/views/connect/use-connect-link.js";
import { act, describeUi, renderHook, waitFor } from "./rtl.js";

const BASE = "https://pulse.example.com";
const LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";
const ENV_VAR = "PULSE_WEB_EXTERNAL_URL";

const CONFIGURED: ConnectLinkPayload = { configured: { link: LINK, baseUrl: BASE }, refusal: null };
const NEITHER: ConnectLinkPayload = { configured: null, refusal: null };
const refusedPayload = (reason: "not-https" | "loopback" | "too-long"): ConnectLinkPayload => ({
  configured: null,
  refusal: { reason, envVar: ENV_VAR },
});

describe("parseConnectLinkPayload", () => {
  it("accepts each of the three states", () => {
    expect(parseConnectLinkPayload(CONFIGURED)).toEqual(CONFIGURED);
    expect(parseConnectLinkPayload(NEITHER)).toEqual(NEITHER);
    for (const reason of ["not-https", "loopback", "too-long"] as const) {
      expect(parseConnectLinkPayload(refusedPayload(reason))).toEqual(refusedPayload(reason));
    }
  });

  it.each([
    ["null", null],
    ["a string", "pulse://connect?v=1"],
    ["an array", [null, null]],
    ["an empty object", {}],
    ["a missing refusal key", { configured: null }],
    ["an extra key", { configured: null, refusal: null, extra: 1 }],
    ["both members set", { ...CONFIGURED, refusal: { reason: "loopback", envVar: ENV_VAR } }],
    ["a link with another scheme", { configured: { link: "https://pulse.example.com", baseUrl: BASE }, refusal: null }],
    ["a non-string link", { configured: { link: 1, baseUrl: BASE }, refusal: null }],
    ["a missing baseUrl", { configured: { link: LINK }, refusal: null }],
    ["an empty baseUrl", { configured: { link: LINK, baseUrl: "" }, refusal: null }],
    ["an extra configured key", { configured: { link: LINK, baseUrl: BASE, more: true }, refusal: null }],
    ["a non-object configured", { configured: LINK, refusal: null }],
    ["an unknown refusal reason", { configured: null, refusal: { reason: "credentials", envVar: ENV_VAR } }],
    ["an inherited-name refusal reason", { configured: null, refusal: { reason: "toString", envVar: ENV_VAR } }],
    ["another env var", { configured: null, refusal: { reason: "loopback", envVar: "PULSE_OTHER" } }],
    ["an extra refusal key", { configured: null, refusal: { reason: "loopback", envVar: ENV_VAR, url: BASE } }],
    ["a non-object refusal", { configured: null, refusal: "loopback" }],
  ])("returns null for %s", (_name, value) => {
    expect(parseConnectLinkPayload(value)).toBeNull();
  });
});

describe("resolveConnectLinkState", () => {
  it("uses the configured link, whatever address is being browsed", () => {
    expect(resolveConnectLinkState(CONFIGURED, "http://localhost:8080")).toEqual({
      kind: "usable",
      link: LINK,
      baseUrl: BASE,
      source: "configured",
    });
  });

  it.each(["not-https", "loopback", "too-long"] as const)(
    "reports a refused configured address (%s) and does not fall back to a usable browsing address",
    (reason) => {
      expect(resolveConnectLinkState(refusedPayload(reason), BASE)).toEqual({ kind: "refused", reason, cause: "config" });
    },
  );

  it("builds the link from the browsing address when nothing is configured", () => {
    expect(resolveConnectLinkState(NEITHER, BASE)).toEqual({ kind: "usable", link: LINK, baseUrl: BASE, source: "browsing" });
  });

  it.each([
    ["not-https", "http://192.0.2.10"],
    ["not-https", "http://localhost:8080"],
    ["loopback", "https://localhost:8443"],
    ["loopback", "https://127.0.0.1"],
    ["too-long", `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`],
    ["unparseable", "null"],
    ["credentials", "https://user:secret@pulse.example.com"],
  ] as const)("refuses the browsing address: %s (%s)", (reason, origin) => {
    expect(resolveConnectLinkState(NEITHER, origin)).toEqual({ kind: "refused", reason, cause: "browsing" });
  });
});

interface StubFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: Array<{ readonly url: string; readonly signal: AbortSignal | null }>;
}

/** A fetch that answers each call with the next queued response (a factory, since a Response reads once). */
function stubFetch(responses: ReadonlyArray<() => Response | Promise<Response>>): StubFetch {
  const calls: StubFetch["calls"] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const next = responses[calls.length];
    calls.push({ url: String(input), signal: init?.signal ?? null });
    if (next === undefined) throw new Error("no queued response");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => (): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describeUi("useConnectLink", () => {
  it("starts loading, fetches /api/connect-link once and settles on the configured link", async () => {
    const { fetchImpl, calls } = stubFetch([json(CONFIGURED)]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, "http://localhost:8080"));
    expect(result.current.state).toEqual({ kind: "loading" });

    await waitFor(() => expect(result.current.state.kind).toBe("usable"));
    expect(result.current.state).toEqual({ kind: "usable", link: LINK, baseUrl: BASE, source: "configured" });
    expect(calls.map((call) => call.url)).toEqual([CONNECT_LINK_PATH]);
    expect(CONNECT_LINK_PATH).toBe("/api/connect-link");
  });

  it("falls back to the browsing address when nothing is configured", async () => {
    const { fetchImpl } = stubFetch([json(NEITHER)]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).not.toBe("loading"));
    expect(result.current.state).toEqual({ kind: "usable", link: LINK, baseUrl: BASE, source: "browsing" });
  });

  it.each([
    ["not-https", "http://192.0.2.10"],
    ["not-https", "http://localhost:8080"],
    ["loopback", "https://localhost:8443"],
  ] as const)("refuses a browsing fallback that is %s (%s)", async (reason, origin) => {
    const { fetchImpl } = stubFetch([json(NEITHER)]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, origin));
    await waitFor(() => expect(result.current.state.kind).not.toBe("loading"));
    expect(result.current.state).toEqual({ kind: "refused", reason, cause: "browsing" });
  });

  it("reports a refused configured address without falling back", async () => {
    const { fetchImpl } = stubFetch([json(refusedPayload("loopback"))]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).not.toBe("loading"));
    expect(result.current.state).toEqual({ kind: "refused", reason: "loopback", cause: "config" });
  });

  it("surfaces a server error envelope", async () => {
    const { fetchImpl } = stubFetch([json({ code: "INTERNAL_ERROR", message: "Internal error." }, 500)]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).toBe("error"));
    const state = result.current.state;
    expect(state.kind === "error" && state.error.code).toBe("INTERNAL_ERROR");
  });

  it("surfaces an unreachable server", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).toBe("error"));
    const state = result.current.state;
    expect(state.kind === "error" && state.error.code).toBe("SERVER_UNREACHABLE");
  });

  it("treats a body of the wrong shape as RESPONSE_INVALID", async () => {
    const { fetchImpl } = stubFetch([json({ configured: null, refusal: null, extra: true })]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).toBe("error"));
    expect(result.current.state).toEqual({
      kind: "error",
      error: { code: "RESPONSE_INVALID", message: CLIENT_TRANSPORT_MESSAGES.RESPONSE_INVALID },
    });
  });

  it("retry() returns to loading and refetches", async () => {
    const { fetchImpl, calls } = stubFetch([json({ code: "INTERNAL_ERROR", message: "Internal error." }, 500), json(CONFIGURED)]);
    const { result } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(result.current.state.kind).toBe("error"));

    act(() => result.current.retry());
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.state.kind).toBe("usable"));
    expect(calls).toHaveLength(2);
  });

  it("aborts the request on unmount and never shows the cancelled result", async () => {
    let release: (response: Response) => void = () => {};
    const { fetchImpl, calls } = stubFetch([() => new Promise<Response>((resolve) => (release = resolve))]);
    const { result, unmount } = renderHook(() => useConnectLink(fetchImpl, BASE));
    await waitFor(() => expect(calls).toHaveLength(1));

    unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
    release(json(CONFIGURED)());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.state).toEqual({ kind: "loading" });
  });
});
