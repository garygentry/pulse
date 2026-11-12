// tests/alerts-routing-heartbeat.test.tsx — F20: the heartbeat's routing reads as deliberate, not as a
// missing severity policy.
import { expect, test } from "bun:test";
import type { ActiveAlert } from "@pulse/web-data/wire";

import { Routing } from "../src/client/views/alerts/detail/Routing.js";
import { makeAlertsPayload } from "./alerts-fixtures.js";
import { describeUi, render, screen } from "./rtl.js";

describeUi("Routing — heartbeat (F20)", () => {
  test("a deadman-severity alert explains the external heartbeat route", () => {
    const alert = { ...makeAlertsPayload().alerts[0]!, severity: "deadman" } as ActiveAlert;
    render(<Routing alert={alert} />);
    const region = screen.getByRole("region", { name: "Routing" });
    expect(region.textContent).toContain("This is the heartbeat");
    expect(region.textContent).not.toContain("No routing policy defined");
  });
});
