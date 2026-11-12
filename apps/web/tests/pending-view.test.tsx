// tests/pending-view.test.tsx — the shared pre-first-payload surface (F49/F50): a recorded failure is
// an error with its reason and Retry, never an endless spinner; a long wait says so.
import { expect, mock, test } from "bun:test";
import type { ViewDeliveryState } from "@pulse/web-data/wire";

import { PendingView, pendingFailure } from "../src/client/views/_shared/pending-view.js";
import { act, describeUi, render, screen, userEvent } from "./rtl.js";

const waiting: ViewDeliveryState = { phase: "initial", identity: null, failure: null };
const failed = (code: string, message: string): ViewDeliveryState =>
  ({ phase: "initial", identity: null, failure: { code, status: 500, message } }) as ViewDeliveryState;

describeUi("PendingView", () => {
  test("a recorded failure renders an alert with its reason and a working Retry", async () => {
    const onRetry = mock(() => undefined);
    render(
      <PendingView
        delivery={failed("INTERNAL_ERROR", "An unexpected server error occurred.")}
        failureTitle="The alerts could not be loaded"
        loading={<p>Loading alerts…</p>}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The alerts could not be loaded");
    expect(alert.textContent).toContain("An unexpected server error occurred.");
    expect(screen.queryByText("Loading alerts…")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("while waiting it shows the loading layout, then a 'still waiting' notice past the bound", async () => {
    render(<PendingView delivery={waiting} failureTitle="x" loading={<p>Loading alerts…</p>} onRetry={() => undefined} noticeAfterMs={20} />);
    expect(screen.getByText("Loading alerts…")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(screen.getByRole("status").textContent).toContain("Still waiting for the first update");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByText("Loading alerts…")).toBeDefined();
  });
});

test("pendingFailure ignores NOT_READY and REQUEST_CANCELLED", () => {
  expect(pendingFailure(failed("NOT_READY", "Current data is not ready yet."))).toBeNull();
  expect(pendingFailure(failed("REQUEST_CANCELLED", "The request was cancelled."))).toBeNull();
  expect(pendingFailure(failed("SERVER_UNREACHABLE", "x"))?.code).toBe("SERVER_UNREACHABLE");
  expect(pendingFailure(waiting)).toBeNull();
});
