// a11y-status-labels.test.ts — parity check for the carried status-label helpers (REQ-A11Y-03, 05 §7).
// status-labels.ts is a pure module (no DOM), carried verbatim from views/overview/a11y.ts. These
// assert the KNOWN example strings from the spec §7.1 / original source, plus that the overview shim
// re-exports the SAME function identities.
import { expect, test, describe } from "bun:test";
import { STATUS_LABEL, cellLabel, serviceLabel } from "../src/client/a11y/status-labels.js";
import { cellLabel as shimCellLabel } from "../src/client/views/overview/a11y.js";
import { hostStatus, serviceStatus } from "./factories.js";

describe("STATUS_LABEL", () => {
  test("maps each status to its SR word", () => {
    expect(STATUS_LABEL.ok).toBe("OK");
    expect(STATUS_LABEL.warning).toBe("warning");
    expect(STATUS_LABEL.critical).toBe("critical");
    expect(STATUS_LABEL.unknown).toBe("unknown");
    expect(STATUS_LABEL.suppressed).toBe("suppressed");
  });
});

describe("cellLabel", () => {
  test("ok host: name + roll-up status", () => {
    expect(cellLabel(hostStatus({ name: "web-01", status: "ok", rollup: "ok" }))).toBe(
      "Host web-01, OK",
    );
  });

  test("suppressed host: appends class + rationale", () => {
    expect(
      cellLabel(
        hostStatus({
          name: "old-box",
          status: "suppressed",
          rollup: "suppressed",
          suppressed: { class: "excluded", rationale: "decommissioned" },
        }),
      ),
    ).toBe("Host old-box, suppressed — excluded: decommissioned");
  });

  test("service-driven roll-up: hints contributing service count", () => {
    expect(
      cellLabel(
        hostStatus({
          name: "nas-01",
          status: "ok",
          rollup: "critical",
          services: [
            serviceStatus({ name: "a", status: "critical" }),
            serviceStatus({ name: "b", status: "ok" }),
            serviceStatus({ name: "c", status: "ok" }),
          ],
        }),
      ),
    ).toBe("Host nas-01, critical — 1 of 3 services critical");
  });
});

describe("serviceLabel", () => {
  test("ok service: host / name, status", () => {
    expect(serviceLabel(serviceStatus({ host: "web-01", name: "grafana", status: "ok" }))).toBe(
      "web-01 / grafana, OK",
    );
  });

  test("suppressed service: appends class + rationale", () => {
    expect(
      serviceLabel(
        serviceStatus({
          host: "web-01",
          name: "grafana",
          status: "suppressed",
          suppressed: { class: "maint", rationale: "window" },
        }),
      ),
    ).toBe("web-01 / grafana, suppressed — maint: window");
  });
});

describe("overview shim", () => {
  test("re-exports the same cellLabel function identity", () => {
    expect(shimCellLabel).toBe(cellLabel);
  });
});
