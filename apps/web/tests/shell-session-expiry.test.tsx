// apps/web/tests/shell-session-expiry.test.tsx — GitHub #64: when an auth proxy answers a view GET
// for an expired sign-in session, the shell's stale-data warning says so and offers a reload, in place
// of "app server unreachable"; without it the warning is unchanged. Role queries only.

import { expect, test } from "bun:test";
import type { ViewDeliveryState } from "@pulse/web-data/wire";

import { StaleDataWarning, isSessionExpired } from "../src/client/shell/StaleDataCallout.js";
import type { ConnectionState } from "../src/client/store/types.js";
import { describeUi, render, screen, userEvent } from "./rtl.js";

const INITIAL: ViewDeliveryState = { phase: "initial", identity: null, failure: null };
const EXPIRED_TEXT = "Your session has expired. Reload the page to sign in again.";

function conn(over: Partial<ConnectionState> = {}, estate: ViewDeliveryState = INITIAL): ConnectionState {
  return {
    phase: "live",
    transport: "sse",
    lastGoodAt: Date.parse("2026-10-15T12:00:00.000Z"),
    failingSince: null,
    seq: 1,
    observation: null,
    views: { overview: INITIAL, alerts: INITIAL, estate, engine: INITIAL, timeline: INITIAL },
    ...over,
  };
}

const expiredEstate: ViewDeliveryState = {
  phase: "stale",
  identity: `sha256:${"e".repeat(64)}`,
  failure: { code: "SESSION_EXPIRED", status: 401, message: EXPIRED_TEXT },
};

describeUi("StaleDataWarning — #64 session expiry", () => {
  test("a SESSION_EXPIRED view failure shows the session line and a reload action, even while live", async () => {
    let reloads = 0;
    render(<StaleDataWarning connection={conn({}, expiredEstate)} clock={null} reload={() => (reloads += 1)} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Session expired");
    expect(alert).toHaveTextContent(EXPIRED_TEXT);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload page" }));
    expect(reloads).toBe(1);
  });

  test("past the stale window it replaces the misleading 'app server unreachable' line", () => {
    render(<StaleDataWarning connection={conn({ phase: "stale" }, expiredEstate)} clock={null} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(EXPIRED_TEXT);
    expect(alert).not.toHaveTextContent("app server unreachable");
  });

  test("an ordinary stale connection keeps the app-server line and offers no reload", () => {
    const unreachable: ViewDeliveryState = {
      ...expiredEstate,
      failure: { code: "SERVER_UNREACHABLE", status: 0, message: "The Pulse server could not be reached." },
    };
    render(<StaleDataWarning connection={conn({ phase: "stale" }, unreachable)} clock={null} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Showing stale data");
    expect(alert).toHaveTextContent("app server unreachable");
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
  });
});

test("isSessionExpired reads every view's latest failure", () => {
  expect(isSessionExpired(conn())).toBe(false);
  expect(isSessionExpired(conn({}, expiredEstate))).toBe(true);
});
