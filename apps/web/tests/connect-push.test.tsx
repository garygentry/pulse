// apps/web/tests/connect-push.test.tsx — the push sections of /connect: the client data layer (parsers, the push
// writer's error mapping, the status GET mapping, the countdown text) and the status hook.
import { expect, it } from "bun:test";
import type { DeviceSummary, PairingTokenIssued, PushStatusPayload } from "@pulse/web-data/wire";
import { CONNECT_LINK_MAX_LENGTH } from "@pulse/web-data/contract";

import {
  PUSH_CLIENT_PATHS,
  cancelPairingToken,
  getPushStatus,
  issuePairingToken,
  parsePairingTokenIssued,
  parsePushStatus,
  pushErrorText,
  pushFetch,
  revokeDevice,
  type PushClientError,
} from "../src/client/views/connect/push/push-api.js";
import { DELIVERY_OUTCOME, PAIRING_STATE, deliveryStateOf } from "../src/client/views/connect/push/status-maps.js";
import { announcementFor, formatRemaining } from "../src/client/views/connect/push/use-countdown.js";
import { PUSH_POLL_MS, usePushStatus } from "../src/client/views/connect/push/use-push-status.js";
import { ICONS } from "../src/client/ui/lib/icons.js";
import { TONES } from "../src/client/ui/lib/status.js";
import { act, describeUi, renderHook, waitFor } from "./rtl.js";

const DEVICE: DeviceSummary = {
  id: "dev_AAAAAAAAAAA",
  displayName: "Ops iPhone",
  pairedAt: "2026-11-20T10:00:00.000Z",
  seenAt: "2026-11-20T11:00:00.000Z",
  environment: "production",
  preferences: { critical: true, warning: true, info: false },
  tokenSuffix: "abcdef",
  lastDelivery: { outcome: "delivered", at: "2026-11-20T11:30:00.000Z", reason: null },
};
const CONFIGURED: PushStatusPayload = { state: "configured", devices: [DEVICE], outstanding: null, maxDevices: 20 };
const MISCONFIGURED: PushStatusPayload = { state: "misconfigured", devices: [], outstanding: null, maxDevices: 20 };
const LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com&pair=AAAAAAAAAAAAAAAAAAAAAA";
const ISSUED: PairingTokenIssued = { link: LINK, expiresAt: "2026-11-20T12:10:00.000Z" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const envelope = (code: string, message: string, details?: Record<string, unknown>): Record<string, unknown> => ({
  code,
  message,
  ...(details !== undefined ? { details } : {}),
});

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A fetch stub answering from a queue (the last answer repeats) and recording each call. */
function stubFetch(...answers: (Response | (() => Response) | Error)[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ method: init?.method ?? "GET", path: String(input), init });
    const answer = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { fetch: impl as typeof fetch, calls };
}

describeUi("connect push: data layer", () => {
  // ---- countdown text ----------------------------------------------------------------------------------------

  it("formats the remaining time as m:ss", () => {
    expect(formatRemaining(545)).toBe("9:05");
    expect(formatRemaining(600)).toBe("10:00");
    expect(formatRemaining(59)).toBe("0:59");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-3)).toBe("0:00");
  });

  it("announces on whole-minute boundaries only", () => {
    expect(announcementFor(601)).toBe("Pairing code expires in 11 minutes");
    expect(announcementFor(600)).toBe("Pairing code expires in 10 minutes");
    expect(announcementFor(541)).toBe("Pairing code expires in 10 minutes");
    expect(announcementFor(540)).toBe("Pairing code expires in 9 minutes");
    expect(announcementFor(61)).toBe("Pairing code expires in 2 minutes");
    expect(announcementFor(60)).toBe("Pairing code expires in 1 minute");
    expect(announcementFor(1)).toBe("Pairing code expires in 1 minute");
    expect(announcementFor(0)).toBe("");
  });

  // ---- status maps -------------------------------------------------------------------------------------------

  it("maps pairing and delivery states to known tones and curated icons", () => {
    for (const map of [PAIRING_STATE, DELIVERY_OUTCOME] as const) {
      for (const presentation of Object.values(map)) {
        expect(TONES).toContain(presentation.tone);
        expect(Object.hasOwn(ICONS, presentation.icon)).toBe(true);
        expect(presentation.label).not.toBe("");
      }
    }
    expect(Object.keys(DELIVERY_OUTCOME).sort()).toEqual(["delivered", "dropped", "failed", "none"]);
    expect(deliveryStateOf(DEVICE)).toBe("delivered");
    expect(deliveryStateOf({ ...DEVICE, lastDelivery: null })).toBe("none");
  });

  it("adds the bell-ring and trash-2 icons", () => {
    expect(Object.hasOwn(ICONS, "bell-ring")).toBe(true);
    expect(Object.hasOwn(ICONS, "trash-2")).toBe(true);
  });

  // ---- parsers -----------------------------------------------------------------------------------------------

  it("parsePushStatus accepts configured and misconfigured payloads", () => {
    expect(parsePushStatus(CONFIGURED)).toEqual(CONFIGURED);
    expect(parsePushStatus(MISCONFIGURED)).toEqual(MISCONFIGURED);
    const outstanding = { ...CONFIGURED, outstanding: { expiresAt: ISSUED.expiresAt } };
    expect(parsePushStatus(outstanding)).toEqual(outstanding);
    const sparse = { ...DEVICE, environment: null, tokenSuffix: null, lastDelivery: null };
    expect(parsePushStatus({ ...CONFIGURED, devices: [sparse] })).toEqual({ ...CONFIGURED, devices: [sparse] });
  });

  const { maxDevices: _omitMax, ...noMaxDevices } = CONFIGURED;
  const { lastDelivery: _omitLast, ...noLastDelivery } = DEVICE;
  it.each([
    ["null", null],
    ["an array", [CONFIGURED]],
    ["an extra top-level key", { ...CONFIGURED, extra: 1 }],
    ["a missing top-level key", noMaxDevices],
    ["state disabled", { ...CONFIGURED, state: "disabled" }],
    ["a string maxDevices", { ...CONFIGURED, maxDevices: "20" }],
    ["a fractional maxDevices", { ...CONFIGURED, maxDevices: 2.5 }],
    ["devices not an array", { ...CONFIGURED, devices: {} }],
    ["an extra device key", { ...CONFIGURED, devices: [{ ...DEVICE, credentialHash: "00" }] }],
    ["a missing device key", { ...CONFIGURED, devices: [noLastDelivery] }],
    ["a numeric device id", { ...CONFIGURED, devices: [{ ...DEVICE, id: 7 }] }],
    ["an unknown environment", { ...CONFIGURED, devices: [{ ...DEVICE, environment: "staging" }] }],
    ["a non-date pairedAt", { ...CONFIGURED, devices: [{ ...DEVICE, pairedAt: "yesterday" }] }],
    ["a string preference", { ...CONFIGURED, devices: [{ ...DEVICE, preferences: { ...DEVICE.preferences, info: "no" } }] }],
    ["an extra preference", { ...CONFIGURED, devices: [{ ...DEVICE, preferences: { ...DEVICE.preferences, debug: true } }] }],
    ["an unknown outcome", { ...CONFIGURED, devices: [{ ...DEVICE, lastDelivery: { ...DEVICE.lastDelivery, outcome: "token_removed" } }] }],
    ["an extra outstanding key", { ...CONFIGURED, outstanding: { expiresAt: ISSUED.expiresAt, link: LINK } }],
    ["a non-date expiresAt", { ...CONFIGURED, outstanding: { expiresAt: 5 } }],
  ])("parsePushStatus returns null for %s", (_name, value) => {
    expect(parsePushStatus(value)).toBeNull();
  });

  it("parsePairingTokenIssued accepts exactly {link, expiresAt}", () => {
    expect(parsePairingTokenIssued(ISSUED)).toEqual(ISSUED);
  });

  it.each([
    ["null", null],
    ["an extra key", { ...ISSUED, token: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a missing expiresAt", { link: LINK }],
    ["a missing link", { expiresAt: ISSUED.expiresAt }],
    ["a numeric link", { ...ISSUED, link: 1 }],
    ["an https link", { ...ISSUED, link: "https://pulse.example.com" }],
    ["an over-long link", { ...ISSUED, link: `${LINK}${"A".repeat(CONNECT_LINK_MAX_LENGTH)}` }],
    ["a non-date expiresAt", { ...ISSUED, expiresAt: "soon" }],
    ["a numeric expiresAt", { ...ISSUED, expiresAt: 1 }],
  ])("parsePairingTokenIssued returns null for %s", (_name, value) => {
    expect(parsePairingTokenIssued(value)).toBeNull();
  });

  // ---- pushFetch ---------------------------------------------------------------------------------------------

  it("sends a same-origin, no-store, manual-redirect write and resolves 204 as ok null", async () => {
    const stub = stubFetch(new Response(null, { status: 204 }));
    const parse = (): never => {
      throw new Error("parse must not run for 204");
    };
    const result = await pushFetch(PUSH_CLIENT_PATHS.pairingTokenCurrent, { method: "DELETE" }, parse, stub.fetch);
    expect(result).toEqual({ ok: true, value: null });
    const init = stub.calls[0]!.init!;
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
  });

  it("sends a JSON body with its content type when one is given", async () => {
    const stub = stubFetch(json(201, ISSUED));
    const result = await pushFetch("/api/push/pairing-tokens", { method: "POST", body: {} }, parsePairingTokenIssued, stub.fetch);
    expect(result).toEqual({ ok: true, value: ISSUED });
    const init = stub.calls[0]!.init!;
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  const WRITE_CASES: readonly (readonly [string, () => Response | Error, PushClientError, number])[] = [
    ["409 no-usable-address", () => json(409, envelope("INVALID_REQUEST", "x", { reason: "no-usable-address" })), "no-usable-address", 409],
    ["409 address-too-long", () => json(409, envelope("INVALID_REQUEST", "x", { reason: "address-too-long" })), "address-too-long", 409],
    ["409 without a known reason", () => json(409, envelope("INVALID_REQUEST", "x", { reason: "other" })), "malformed-response", 409],
    ["403 with a Pulse envelope", () => json(403, envelope("INVALID_REQUEST", "x")), "forbidden", 403],
    ["403 without an envelope", () => new Response("<html>denied</html>", { status: 403, headers: { "content-type": "text/html" } }), "session-expired", 403],
    ["401 without an envelope", () => new Response("nope", { status: 401 }), "session-expired", 401],
    ["a 302 redirect", () => new Response(null, { status: 302, headers: { location: "/login" } }), "session-expired", 302],
    ["a 200 HTML login page", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }), "session-expired", 200],
    ["503 PUSH_UNAVAILABLE", () => json(503, envelope("PUSH_UNAVAILABLE", "x")), "unavailable", 503],
    ["405 (push disabled)", () => json(405, envelope("METHOD_NOT_ALLOWED", "x")), "unavailable", 405],
    ["404 on a non-device path", () => json(404, envelope("API_NOT_FOUND", "x")), "unavailable", 404],
    ["a 500", () => json(500, envelope("INTERNAL_ERROR", "x")), "malformed-response", 500],
    ["a 201 failing the parser", () => json(201, { link: LINK }), "malformed-response", 201],
    ["a 201 that is not JSON", () => new Response("{", { status: 201, headers: { "content-type": "application/json" } }), "malformed-response", 201],
    ["a fetch rejection", () => new TypeError("Failed to fetch"), "network", 0],
  ];

  it.each(WRITE_CASES)("pushFetch maps %s", async (_name, answer, error, httpStatus) => {
    const stub = stubFetch(answer());
    const result = await pushFetch(PUSH_CLIENT_PATHS.pairingTokens, { method: "POST" }, parsePairingTokenIssued, stub.fetch);
    expect(result).toEqual({ ok: false, error, httpStatus });
  });

  it("pushFetch maps a failing body stream to network", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream cut"));
      },
    });
    const stub = stubFetch(() => new Response(body, { status: 201, headers: { "content-type": "application/json" } }));
    const result = await pushFetch(PUSH_CLIENT_PATHS.pairingTokens, { method: "POST" }, parsePairingTokenIssued, stub.fetch);
    expect(result).toEqual({ ok: false, error: "network", httpStatus: 0 });
  });

  it("pushFetch never throws, even when the parser does", async () => {
    const stub = stubFetch(json(201, ISSUED));
    const result = await pushFetch(PUSH_CLIENT_PATHS.pairingTokens, { method: "POST" }, () => {
      throw new Error("boom");
    }, stub.fetch);
    expect(result).toEqual({ ok: false, error: "malformed-response", httpStatus: 201 });
  });

  // ---- the three writes ----------------------------------------------------------------------------------------

  it("issuePairingToken POSTs with no body and returns the parsed link", async () => {
    const stub = stubFetch(json(201, ISSUED));
    expect(await issuePairingToken(stub.fetch)).toEqual({ ok: true, value: ISSUED });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/push/pairing-tokens"]);
    expect(stub.calls[0]!.init!.body).toBeUndefined();
  });

  it("issuePairingToken treats a 204 as malformed", async () => {
    const stub = stubFetch(new Response(null, { status: 204 }));
    expect(await issuePairingToken(stub.fetch)).toEqual({ ok: false, error: "malformed-response", httpStatus: 204 });
  });

  it("cancelPairingToken DELETEs the current token", async () => {
    const stub = stubFetch(new Response(null, { status: 204 }));
    expect(await cancelPairingToken(stub.fetch)).toEqual({ ok: true, value: null });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/push/pairing-tokens/current"]);
  });

  it("revokeDevice DELETEs the encoded id and maps 404 to not-found", async () => {
    const ok = stubFetch(new Response(null, { status: 204 }));
    expect(await revokeDevice("dev_AAAAAAAAAAA", ok.fetch)).toEqual({ ok: true, value: null });
    expect(ok.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/push/devices/dev_AAAAAAAAAAA"]);
    expect(PUSH_CLIENT_PATHS.deviceById("a/b")).toBe("/api/push/devices/a%2Fb");

    const gone = stubFetch(json(404, envelope("API_NOT_FOUND", "x")));
    expect(await revokeDevice("dev_AAAAAAAAAAA", gone.fetch)).toEqual({ ok: false, error: "not-found", httpStatus: 404 });
  });

  // ---- getPushStatus -----------------------------------------------------------------------------------------

  const STATUS_CASES: readonly (readonly [string, () => Response | Error, PushClientError, number])[] = [
    ["404 (push disabled)", () => json(404, envelope("API_NOT_FOUND", "x")), "unavailable", 404],
    ["405", () => json(405, envelope("METHOD_NOT_ALLOWED", "x")), "unavailable", 405],
    ["503 PUSH_UNAVAILABLE", () => json(503, envelope("PUSH_UNAVAILABLE", "x")), "unavailable", 503],
    ["a 200 failing the parser", () => json(200, { ...CONFIGURED, extra: true }), "malformed-response", 200],
    ["a 200 that is not JSON", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }), "malformed-response", 200],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "/login" } }), "session-expired", 302],
    ["403 with a Pulse envelope", () => json(403, envelope("INVALID_REQUEST", "x")), "forbidden", 403],
    ["a fetch rejection", () => new TypeError("Failed to fetch"), "network", 0],
    ["a 500", () => json(500, envelope("INTERNAL_ERROR", "x")), "malformed-response", 500],
  ];

  it.each(STATUS_CASES)("getPushStatus maps %s", async (_name, answer, error, httpStatus) => {
    const stub = stubFetch(answer());
    const result = await getPushStatus(new AbortController().signal, stub.fetch);
    expect(result).toEqual({ ok: false, error, httpStatus });
  });

  it("getPushStatus GETs the status path and returns the parsed payload", async () => {
    const stub = stubFetch(json(200, CONFIGURED));
    expect(await getPushStatus(new AbortController().signal, stub.fetch)).toEqual({ ok: true, value: CONFIGURED });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/push/status"]);
  });

  it("has fixed copy for every error", () => {
    expect(pushErrorText("unavailable")).toBe("Push notifications are not available on this server right now.");
    expect(pushErrorText("no-usable-address")).toBe(
      "No pairing code: this server has no address a phone can reach. Set PULSE_WEB_EXTERNAL_URL to the server's https address.",
    );
    expect(pushErrorText("address-too-long")).toBe("No pairing code: the server address is too long for a scannable code.");
    expect(pushErrorText("forbidden")).toBe("This action was refused. Reload the page and try again.");
    expect(pushErrorText("not-found")).toBe("That device was already removed.");
    expect(pushErrorText("session-expired")).toBe("Your sign-in session has expired. Reload the page to sign in again.");
    expect(pushErrorText("network")).toBe("Could not reach the server. Check the connection and try again.");
    expect(pushErrorText("malformed-response")).toBe("The server sent an unexpected response.");
  });

  // ---- usePushStatus -----------------------------------------------------------------------------------------

  it("polls every 5 s", () => {
    expect(PUSH_POLL_MS).toBe(5_000);
  });

  it("never fetches with a null fetchImpl and stays hidden", async () => {
    const { result } = renderHook(() => usePushStatus(null, true));
    expect(result.current.state).toEqual({ kind: "hidden" });
    await act(async () => {
      expect(await result.current.refresh()).toBeNull();
    });
    expect(result.current.state).toEqual({ kind: "hidden" });
  });

  it("starts loading and becomes ready for a configured status", async () => {
    const stub = stubFetch(json(200, CONFIGURED));
    const { result } = renderHook(() => usePushStatus(stub.fetch, false));
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(result.current.state).toEqual({ kind: "ready", status: CONFIGURED, refreshError: null });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/push/status"]);
  });

  it.each([
    ["404", () => json(404, envelope("API_NOT_FOUND", "x"))],
    ["misconfigured", () => json(200, MISCONFIGURED)],
    ["a network error", () => new TypeError("Failed to fetch")],
    ["a malformed body", () => json(200, { state: "configured" })],
  ])("hides on a first load answering %s", async (_name, answer) => {
    const stub = stubFetch(answer());
    const { result } = renderHook(() => usePushStatus(stub.fetch, false));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "hidden" }));
  });

  it("keeps the last payload with refreshError on a later error", async () => {
    const stub = stubFetch(json(200, CONFIGURED), new TypeError("Failed to fetch"));
    const { result } = renderHook(() => usePushStatus(stub.fetch, false));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    await act(async () => {
      expect(await result.current.refresh()).toBeNull();
    });
    expect(result.current.state).toEqual({ kind: "ready", status: CONFIGURED, refreshError: "network" });
  });

  it("clears refreshError on the next good load and returns the payload from refresh", async () => {
    const next = { ...CONFIGURED, devices: [] };
    const stub = stubFetch(json(200, CONFIGURED), json(500, envelope("INTERNAL_ERROR", "x")), json(200, next));
    const { result } = renderHook(() => usePushStatus(stub.fetch, false));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.state).toEqual({ kind: "ready", status: CONFIGURED, refreshError: "malformed-response" });
    await act(async () => {
      expect(await result.current.refresh()).toEqual(next);
    });
    expect(result.current.state).toEqual({ kind: "ready", status: next, refreshError: null });
  });

  it.each([
    ["misconfigured", () => json(200, MISCONFIGURED)],
    ["unavailable", () => json(404, envelope("API_NOT_FOUND", "x"))],
  ])("hides on a later load answering %s", async (_name, answer) => {
    const stub = stubFetch(json(200, CONFIGURED), answer());
    const { result } = renderHook(() => usePushStatus(stub.fetch, false));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.state).toEqual({ kind: "hidden" });
  });

  it("aborts the in-flight request on unmount", async () => {
    let seen: AbortSignal | null = null;
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const { unmount } = renderHook(() => usePushStatus(hanging, false));
    await waitFor(() => expect(seen).not.toBeNull());
    unmount();
    expect(seen!.aborted).toBe(true);
  });
});
