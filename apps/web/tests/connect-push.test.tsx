// apps/web/tests/connect-push.test.tsx — the push sections of /connect: the client data layer (parsers, the push
// writer's error mapping, the status GET mapping, the countdown text), the status hook, the pair-flow reducer and
// the rendered sections on the page (role queries).
import { afterEach, beforeEach, expect, it, jest, setSystemTime } from "bun:test";
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
import { pairReducer, type PairEvent, type PairFlowState } from "../src/client/views/connect/push/pair-section.js";
import { ConnectView } from "../src/client/views/connect/view.js";
import type { ConnectLinkPayload } from "../src/shared/connect-link.js";
import { restoreRealTimers } from "./dom.js";
import { act, describeUi, fireEvent, render, renderHook, screen, userEvent, waitFor, within } from "./rtl.js";

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

// ---- pairReducer -----------------------------------------------------------------------------------------------

describeUi("connect push: pairReducer", () => {
  const KNOWN: ReadonlySet<string> = new Set([DEVICE.id]);
  const EXPIRES = ISSUED.expiresAt;
  const EXPIRES_MS = Date.parse(EXPIRES);
  const OUT: PairFlowState = { kind: "outstanding", link: LINK, expiresAt: EXPIRES, knownIds: KNOWN };
  const UNKNOWN: PairFlowState = { kind: "outstanding-unknown", expiresAt: EXPIRES };
  const NEW_DEVICE: DeviceSummary = { ...DEVICE, id: "dev_BBBBBBBBBBB", displayName: "Test iPad" };
  const status = (outstanding: string | null, devices: readonly DeviceSummary[] = [DEVICE], nowMs = EXPIRES_MS - 60_000): PairEvent => ({
    type: "status",
    status: { ...CONFIGURED, devices: [...devices], outstanding: outstanding === null ? null : { expiresAt: outstanding } },
    nowMs,
  });
  const ALL: Record<string, PairFlowState> = {
    idle: { kind: "idle" },
    issuing: { kind: "issuing" },
    outstanding: OUT,
    "outstanding-unknown": UNKNOWN,
    cancelling: { kind: "cancelling", from: OUT },
    expired: { kind: "expired" },
    cancelled: { kind: "cancelled" },
    paired: { kind: "paired", displayName: "Test iPad" },
    error: { kind: "error", error: "network" },
  };

  const ROWS: readonly (readonly [string, PairFlowState, PairEvent, PairFlowState])[] = [
    ...(["idle", "expired", "cancelled", "paired", "error", "outstanding-unknown"] as const).map(
      (k) => [`${k} + issue`, ALL[k]!, { type: "issue" }, { kind: "issuing" }] as const,
    ),
    ["issuing + issued", ALL["issuing"]!, { type: "issued", issued: ISSUED, knownIds: KNOWN }, OUT],
    ["issuing + issue-failed", ALL["issuing"]!, { type: "issue-failed", error: "forbidden" }, { kind: "error", error: "forbidden" }],
    ["idle + status with a code", ALL["idle"]!, status(EXPIRES), UNKNOWN],
    ["idle + status without a code", ALL["idle"]!, status(null), ALL["idle"]!],
    ["outstanding + status: new device", OUT, status(null, [DEVICE, NEW_DEVICE]), { kind: "paired", displayName: "Test iPad" }],
    ["outstanding + status: gone at expiry", OUT, status(null, [DEVICE], EXPIRES_MS), { kind: "expired" }],
    ["outstanding + status: gone before expiry", OUT, status(null, [DEVICE]), { kind: "cancelled" }],
    ["outstanding + status: another expiry", OUT, status("2026-11-20T12:15:00.000Z"), { kind: "outstanding-unknown", expiresAt: "2026-11-20T12:15:00.000Z" }],
    ["outstanding + status: same code", OUT, status(EXPIRES), OUT],
    ["outstanding + status: revoke during the window is not a pairing", OUT, status(null, []), { kind: "cancelled" }],
    ["outstanding-unknown + status: gone", UNKNOWN, status(null), ALL["idle"]!],
    ["outstanding-unknown + status: still there", UNKNOWN, status(EXPIRES), UNKNOWN],
    ["outstanding + expire", OUT, { type: "expire" }, { kind: "expired" }],
    ["outstanding-unknown + expire", UNKNOWN, { type: "expire" }, { kind: "expired" }],
    ["outstanding + cancel", OUT, { type: "cancel" }, { kind: "cancelling", from: OUT }],
    ["outstanding-unknown + cancel", UNKNOWN, { type: "cancel" }, { kind: "cancelling", from: UNKNOWN }],
    ["cancelling + cancelled", ALL["cancelling"]!, { type: "cancelled" }, { kind: "cancelled" }],
    ["cancelling + cancel-failed", ALL["cancelling"]!, { type: "cancel-failed", error: "unavailable" }, OUT],
    ...(["expired", "cancelled", "paired", "error"] as const).map(
      (k) => [`${k} + dismiss`, ALL[k]!, { type: "dismiss" }, { kind: "idle" }] as const,
    ),
  ];

  it.each(ROWS)("%s", (_name, from, event, to) => {
    expect(pairReducer(from, event)).toEqual(to);
  });

  // Every (state, event) pair not in the table leaves the state unchanged (same object).
  const EVENTS: readonly PairEvent[] = [
    { type: "issue" },
    { type: "issued", issued: ISSUED, knownIds: KNOWN },
    { type: "issue-failed", error: "network" },
    status(null),
    status(EXPIRES),
    { type: "expire" },
    { type: "cancel" },
    { type: "cancelled" },
    { type: "cancel-failed", error: "network" },
    { type: "dismiss" },
  ];
  it("returns the state unchanged for every unlisted pair", () => {
    const listed = new Set(ROWS.map(([, from, event]) => `${from.kind}|${event.type}`));
    let checked = 0;
    for (const from of Object.values(ALL)) {
      for (const event of EVENTS) {
        if (listed.has(`${from.kind}|${event.type}`)) continue;
        expect(pairReducer(from, event)).toBe(from);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

// ---- the page ------------------------------------------------------------------------------------------------

const BASE = "https://pulse.example.com";
const CONNECT_LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";
const CONNECT_PAYLOAD: ConnectLinkPayload = { configured: { link: CONNECT_LINK, baseUrl: BASE }, refusal: null };
const CAPTION = "Includes a one-time pairing code — don't share this screen";
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const STATUS_PATH = "GET /api/push/status";
const NO_DEVICES: PushStatusPayload = { ...CONFIGURED, devices: [] };
const OUTSTANDING: PushStatusPayload = { ...NO_DEVICES, outstanding: { expiresAt: ISSUED.expiresAt } };

/** The connect-link fetch: always the configured link. */
const connectFetch = (async () =>
  new Response(JSON.stringify(CONNECT_PAYLOAD), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

type Answer = Response | Error | (() => Response | Error);

/** A push fetch stub answering per "METHOD path" from a queue (the last answer repeats), recording each call. */
function pushStub(initial: Record<string, Answer | Answer[]>): {
  readonly fetch: typeof fetch;
  readonly log: string[];
  set(key: string, ...answers: Answer[]): void;
} {
  const queues = new Map<string, Answer[]>(Object.entries(initial).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const log: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    log.push(key);
    const queue = queues.get(key);
    if (queue === undefined || queue.length === 0) return json(404, envelope("API_NOT_FOUND", "x"));
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    const value = typeof answer === "function" ? answer() : answer;
    if (value instanceof Error) throw value;
    return value.clone();
  };
  return {
    fetch: impl as typeof fetch,
    log,
    set(key, ...answers) {
      queues.set(key, answers);
    },
  };
}

const routerWith = (query: Record<string, string>) =>
  ({ current: () => ({ query }) }) as unknown as NonNullable<Parameters<typeof ConnectView>[0]["router"]>;

/** Drain pending promise callbacks inside act (fetch stubs resolve on microtasks). */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Advance fake time in whole seconds, letting each second's fetches and renders settle. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(1000, left));
    });
    await flush(3);
  }
}

/** Render the page with a usable connect link and the given push stub; wait for the first status. */
async function renderPage(push: ReturnType<typeof pushStub>, opts: { readonly origin?: string; readonly fake?: boolean } = {}) {
  const view = render(<ConnectView fetchImpl={connectFetch} origin={opts.origin ?? BASE} pushFetchImpl={push.fetch} />);
  if (opts.fake === true) await flush();
  else await waitFor(() => expect(push.log.length).toBeGreaterThan(0));
  await flush();
  return view;
}

const pairRegion = (): HTMLElement | null => screen.queryByRole("region", { name: "Pair a device" });
const devicesRegion = (): HTMLElement | null => screen.queryByRole("region", { name: "Paired devices" });
const headingTexts = (): string[] => screen.getAllByRole("heading").map((h) => h.textContent ?? "");

describeUi("connect push: page", () => {
  // The fixtures carry fixed timestamps (a code expiring at 12:10Z), so every case reads the clock
  // at NOW; otherwise an outstanding code is already expired once the wall clock passes it.
  beforeEach(() => {
    setSystemTime(NOW);
  });
  afterEach(() => {
    if (jest.isFakeTimers()) restoreRealTimers();
    setSystemTime();
  });

  // 1, 2: push unavailable renders exactly the no-push page.
  it.each([
    ["404 (disabled)", () => json(404, envelope("API_NOT_FOUND", "x"))],
    ["405", () => json(405, envelope("API_METHOD_NOT_ALLOWED", "x"))],
    ["misconfigured", () => json(200, MISCONFIGURED)],
    ["a network error", () => new TypeError("Failed to fetch")],
    ["a malformed body", () => json(200, { state: "configured" })],
  ] as const)("push %s: no push region, same headings as without push", async (_name, answer) => {
    const plain = render(<ConnectView fetchImpl={connectFetch} origin={BASE} pushFetchImpl={null} />);
    await screen.findByRole("region", { name: "Connect link" });
    const expected = headingTexts();
    const html = plain.container.innerHTML;
    plain.unmount();

    const push = pushStub({ [STATUS_PATH]: answer });
    const view = await renderPage(push);
    await screen.findByRole("region", { name: "Connect link" });
    expect(push.log).toEqual([STATUS_PATH]);
    expect(pairRegion()).toBeNull();
    expect(devicesRegion()).toBeNull();
    expect(headingTexts()).toEqual(expected);
    expect(view.container.innerHTML.replace(/_r_[a-z0-9]+_/g, "")).toBe(html.replace(/_r_[a-z0-9]+_/g, ""));
  });

  // 3
  it("kiosk: no push request and no push region", async () => {
    const push = pushStub({ [STATUS_PATH]: json(200, CONFIGURED) });
    render(<ConnectView fetchImpl={connectFetch} origin={BASE} pushFetchImpl={push.fetch} router={routerWith({ kiosk: "1" })} />);
    await screen.findByRole("region", { name: "Connect link" });
    await flush();
    expect(push.log).toEqual([]);
    expect(pairRegion()).toBeNull();
    expect(devicesRegion()).toBeNull();
  });

  it("fetchImpl alone (no pushFetchImpl) makes no push request", async () => {
    const calls: string[] = [];
    const recording = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return connectFetch(input);
    }) as unknown as typeof fetch;
    render(<ConnectView fetchImpl={recording} origin={BASE} />);
    await screen.findByRole("region", { name: "Connect link" });
    await flush();
    expect(calls).toEqual(["/api/connect-link"]);
    expect(devicesRegion()).toBeNull();
  });

  // 4
  it("configured, no devices: an empty state and the device count", async () => {
    await renderPage(pushStub({ [STATUS_PATH]: json(200, NO_DEVICES) }));
    const region = await screen.findByRole("region", { name: "Paired devices" });
    const empty = within(region).getAllByRole("status").find((el) => el.textContent?.includes("No devices paired"));
    expect(empty).toBeDefined();
    expect(within(region).getByText("0 of 20 devices")).toBeInTheDocument();
    expect(within(region).queryByRole("list")).toBeNull();
  });

  // 5
  it("issues no pairing code on load", async () => {
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES) });
    await renderPage(push);
    await screen.findByRole("region", { name: "Pair a device" });
    await flush();
    expect(push.log).toEqual([STATUS_PATH]);
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
  });

  // 6
  it("issue: the page QR and link become the code link with the warning caption", async () => {
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    expect(await screen.findByRole("img", { name: LINK })).toBeInTheDocument();
    expect(push.log).toContain("POST /api/push/pairing-tokens");
    const connect = screen.getByRole("region", { name: "Connect link" });
    expect(within(connect).getByText(CAPTION)).toBeInTheDocument();
    expect(within(connect).getByText(LINK)).toBeInTheDocument();
    expect(within(connect).queryByText(CONNECT_LINK)).toBeNull();
    // Focus moved from the unmounted button to the new callout's action.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  // 7, 8
  it("countdown ticks each second, announces per minute, and expiry reverts the QR", async () => {
    jest.useFakeTimers({ now: NOW });
    const push = pushStub({ [STATUS_PATH]: [json(200, NO_DEVICES), json(200, OUTSTANDING)], "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push, { fake: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
    });
    await flush();
    expect(screen.getByRole("img", { name: LINK })).toBeInTheDocument();
    const live = (): HTMLElement => pairRegion()!.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(live()).toHaveAttribute("aria-atomic", "true");
    expect(live()).toHaveTextContent("Pairing code expires in 10 minutes");
    await advance(1000);
    expect(screen.getByText("Pairing code active — expires in 9:59")).toBeInTheDocument();
    expect(live()).toHaveTextContent("Pairing code expires in 10 minutes");
    await advance(59_000);
    expect(screen.getByText("Pairing code active — expires in 9:00")).toBeInTheDocument();
    expect(live()).toHaveTextContent("Pairing code expires in 9 minutes");
    await advance(480_000);
    expect(screen.getByText("Pairing code active — expires in 1:00")).toBeInTheDocument();
    expect(live()).toHaveTextContent(/^Pairing code expires in 1 minute$/);
    await advance(60_000);
    const expired = screen.getAllByRole("status").find((el) => el.textContent?.includes("Pairing code expired"));
    expect(expired).toBeDefined();
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(live()).toHaveTextContent(/^$/);
  });

  // 9
  it("cancel: DELETE the current code, announce cancelled, revert the QR", async () => {
    const push = pushStub({
      [STATUS_PATH]: json(200, NO_DEVICES),
      "POST /api/push/pairing-tokens": json(201, ISSUED),
      "DELETE /api/push/pairing-tokens/current": new Response(null, { status: 204 }),
    });
    await renderPage(push);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("Pairing code cancelled"))).toBe(true),
    );
    expect(push.log).toContain("DELETE /api/push/pairing-tokens/current");
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue new code" })).toHaveFocus();
  });

  // 10
  it("cancel failure (503): an alert with the unavailable copy, the code QR stays", async () => {
    const push = pushStub({
      [STATUS_PATH]: json(200, NO_DEVICES),
      "POST /api/push/pairing-tokens": json(201, ISSUED),
      "DELETE /api/push/pairing-tokens/current": json(503, envelope("PUSH_UNAVAILABLE", "x")),
    });
    await renderPage(push);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pushErrorText("unavailable"));
    expect(screen.getByRole("img", { name: LINK })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  // 11, 12, 13, 16: polls while a code is outstanding
  it("paired: the next poll with a new device announces it, reverts the QR and lists it", async () => {
    jest.useFakeTimers({ now: NOW });
    const added: DeviceSummary = { ...DEVICE, id: "dev_BBBBBBBBBBB", displayName: "Test iPad" };
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push, { fake: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
    });
    await flush();
    push.set(STATUS_PATH, json(200, { ...NO_DEVICES, devices: [added] }));
    await advance(5000);
    const paired = screen.getAllByRole("status").find((el) => el.textContent?.includes("Device paired"));
    expect(paired).toHaveTextContent("Test iPad");
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
    expect(within(devicesRegion()!).getByRole("listitem")).toHaveTextContent("Test iPad");
    expect(screen.getByRole("button", { name: "Pair another device" })).toBeInTheDocument();
  });

  it("voided elsewhere: the code is gone before expiry with no new device → cancelled", async () => {
    jest.useFakeTimers({ now: NOW });
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push, { fake: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
    });
    await flush();
    await advance(5000);
    expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("Pairing code cancelled"))).toBe(true);
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
  });

  it("replaced elsewhere: a different expiry shows the outstanding-unknown callout and reverts the QR", async () => {
    jest.useFakeTimers({ now: NOW });
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push, { fake: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
    });
    await flush();
    push.set(STATUS_PATH, json(200, { ...NO_DEVICES, outstanding: { expiresAt: "2026-11-20T12:08:00.000Z" } }));
    await advance(5000);
    expect(screen.getByText(/^A pairing code is outstanding \(expires in \d+:\d\d\)$/)).toHaveTextContent("(expires in 7:55)");
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
    expect(screen.queryByText(CAPTION)).toBeNull();
  });

  it("polls every 5 s only while a code is outstanding", async () => {
    jest.useFakeTimers({ now: NOW });
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": json(201, ISSUED) });
    await renderPage(push, { fake: true });
    expect(push.log).toEqual([STATUS_PATH]);
    await advance(15_000);
    expect(push.log).toEqual([STATUS_PATH]);
    push.set(STATUS_PATH, json(200, OUTSTANDING));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
    });
    await flush();
    expect(push.log).toEqual([STATUS_PATH, "POST /api/push/pairing-tokens"]);
    await advance(4000);
    expect(push.log.filter((k) => k === STATUS_PATH)).toHaveLength(1);
    await advance(1000);
    expect(push.log.filter((k) => k === STATUS_PATH)).toHaveLength(2);
    await advance(5000);
    expect(push.log.filter((k) => k === STATUS_PATH)).toHaveLength(3);
    await advance(5000);
    expect(push.log.filter((k) => k === STATUS_PATH)).toHaveLength(4);
  });

  // 14
  it("reload with a code outstanding: says so, offers Cancel and Issue new code, keeps the plain QR", async () => {
    await renderPage(pushStub({ [STATUS_PATH]: json(200, OUTSTANDING) }));
    expect(await screen.findByText(/^A pairing code is outstanding \(expires in \d+:\d\d\)$/)).toBeInTheDocument();
    const region = pairRegion()!;
    expect(within(region).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Issue new code" })).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Pair a device" })).toBeNull();
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
  });

  // 15
  it.each([
    ["409 no-usable-address", () => json(409, envelope("INVALID_REQUEST", "x", { reason: "no-usable-address" })), "no-usable-address"],
    ["409 address-too-long", () => json(409, envelope("INVALID_REQUEST", "x", { reason: "address-too-long" })), "address-too-long"],
    ["503", () => json(503, envelope("PUSH_UNAVAILABLE", "x")), "unavailable"],
    ["403", () => json(403, envelope("INVALID_REQUEST", "x")), "forbidden"],
    ["a network failure", () => new TypeError("Failed to fetch"), "network"],
  ] as const)("issue error %s: an alert with the matching copy and Try again", async (_name, answer, error) => {
    const push = pushStub({ [STATUS_PATH]: json(200, NO_DEVICES), "POST /api/push/pairing-tokens": answer });
    await renderPage(push);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pair a device" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not create a pairing code");
    expect(alert).toHaveTextContent(pushErrorText(error));
    expect(within(alert).getByRole("button", { name: "Try again" })).toHaveFocus();
    expect(screen.getByRole("img", { name: CONNECT_LINK })).toBeInTheDocument();
  });

  // 17
  it("device rows: name, times, environment, muted severities and a delivery badge", async () => {
    const devices: DeviceSummary[] = [
      DEVICE,
      { ...DEVICE, id: "dev_BBBBBBBBBBB", displayName: "Test iPad", environment: "sandbox", preferences: { critical: true, warning: false, info: false }, lastDelivery: { outcome: "failed", at: DEVICE.seenAt, reason: "BadDeviceToken" } },
      { ...DEVICE, id: "dev_CCCCCCCCCCC", displayName: "Spare iPhone", environment: null, preferences: { critical: false, warning: false, info: false }, lastDelivery: { outcome: "dropped", at: DEVICE.seenAt, reason: null } },
      { ...DEVICE, id: "dev_DDDDDDDDDDD", displayName: "Lab iPad", preferences: { critical: true, warning: true, info: true }, lastDelivery: null },
    ];
    await renderPage(pushStub({ [STATUS_PATH]: json(200, { ...CONFIGURED, devices }) }));
    const region = await screen.findByRole("region", { name: "Paired devices" });
    const items = within(within(region).getByRole("list", { name: "Paired devices" })).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const [ops, ipad, spare, lab] = items as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(ops).toHaveTextContent("Ops iPhone");
    const times = ops.querySelectorAll("time");
    expect([...times].map((t) => t.getAttribute("dateTime"))).toEqual([DEVICE.pairedAt, DEVICE.seenAt]);
    expect(ops).toHaveTextContent("Production");
    expect(ops).toHaveTextContent("Muted: info");
    expect(within(ops).getByText("Delivered")).toBeInTheDocument();
    expect(ipad).toHaveTextContent("Sandbox (development build)");
    expect(ipad).toHaveTextContent("Muted: warning, info");
    expect(within(ipad).getByText("Failed")).toBeInTheDocument();
    expect(ipad).toHaveTextContent("BadDeviceToken");
    expect(spare).toHaveTextContent("Not registered yet");
    expect(spare).toHaveTextContent("Muted: all severities");
    expect(within(spare).getByText("Dropped")).toBeInTheDocument();
    expect(lab).not.toHaveTextContent("Muted");
    expect(within(lab).getByText("No delivery yet")).toBeInTheDocument();
    expect(within(region).getByText("4 of 20 devices")).toBeInTheDocument();
  });

  // 18
  it("renders a display name as text only, control characters replaced", async () => {
    const odd = { ...DEVICE, displayName: "Ops\u0007<b>x</b>" };
    await renderPage(pushStub({ [STATUS_PATH]: json(200, { ...CONFIGURED, devices: [odd] }) }));
    const item = within(await screen.findByRole("region", { name: "Paired devices" })).getByRole("listitem");
    expect(item).toHaveTextContent("Ops�<b>x</b>");
    expect(item.querySelector("b")).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke Ops�<b>x</b>" })).toBeInTheDocument();
  });

  // 19
  it("revoke by keyboard: confirm in an alertdialog, then the row is gone", async () => {
    const push = pushStub({
      [STATUS_PATH]: [json(200, CONFIGURED), json(200, NO_DEVICES)],
      [`DELETE /api/push/devices/${DEVICE.id}`]: new Response(null, { status: 204 }),
    });
    await renderPage(push);
    const user = userEvent.setup();
    const revoke = await screen.findByRole("button", { name: "Revoke Ops iPhone" });
    for (let i = 0; i < 40 && document.activeElement !== revoke; i += 1) await user.tab();
    expect(revoke).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke Ops iPhone?" });
    expect(dialog.querySelector('[data-slot="connect-push-revoke"]')).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(revoke).toHaveFocus();
    expect(push.log).toEqual([STATUS_PATH]);

    await user.keyboard("{Enter}");
    const again = await screen.findByRole("alertdialog", { name: "Revoke Ops iPhone?" });
    await user.tab();
    expect(within(again).getByRole("button", { name: "Revoke device" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(push.log).toEqual([STATUS_PATH, `DELETE /api/push/devices/${DEVICE.id}`, STATUS_PATH]);
    expect(within(devicesRegion()!).queryByRole("listitem")).toBeNull();
    expect(screen.getByText("0 of 20 devices")).toBeInTheDocument();
  });

  // 20
  it("revoke failure (503): an alert inside the dialog, which stays open", async () => {
    const push = pushStub({
      [STATUS_PATH]: json(200, CONFIGURED),
      [`DELETE /api/push/devices/${DEVICE.id}`]: json(503, envelope("PUSH_UNAVAILABLE", "x")),
    });
    await renderPage(push);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke Ops iPhone" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke Ops iPhone?" });
    await user.click(within(dialog).getByRole("button", { name: "Revoke device" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Could not revoke the device");
    expect(alert).toHaveTextContent(pushErrorText("unavailable"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(push.log).toEqual([STATUS_PATH, `DELETE /api/push/devices/${DEVICE.id}`]);
  });

  // 21
  it("at the device limit: a warning, and pairing stays available", async () => {
    await renderPage(pushStub({ [STATUS_PATH]: json(200, { ...CONFIGURED, maxDevices: 1 }) }));
    const region = await screen.findByRole("region", { name: "Paired devices" });
    const warning = within(region).getAllByRole("status").find((el) => el.textContent?.includes("Device limit reached"));
    expect(warning).toHaveTextContent("This server already has 1 paired devices. Revoke one before pairing another.");
    expect(screen.getByRole("button", { name: "Pair a device" })).toBeInTheDocument();
  });

  // 22
  it("connect link refused: no pair section, devices still listed", async () => {
    const push = pushStub({ [STATUS_PATH]: json(200, CONFIGURED) });
    render(
      <ConnectView
        fetchImpl={(async () => json(200, { configured: null, refusal: null })) as unknown as typeof fetch}
        origin="http://pulse.example.com"
        pushFetchImpl={push.fetch}
      />,
    );
    expect(await screen.findByRole("region", { name: "Paired devices" })).toBeInTheDocument();
    expect(pairRegion()).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair a device" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("No connect link");
  });

  it("section roots carry their data-slot", async () => {
    await renderPage(pushStub({ [STATUS_PATH]: json(200, CONFIGURED) }));
    expect(await screen.findByRole("region", { name: "Pair a device" })).toHaveAttribute("data-slot", "connect-push-pair");
    expect(devicesRegion()).toHaveAttribute("data-slot", "connect-push-devices");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});
