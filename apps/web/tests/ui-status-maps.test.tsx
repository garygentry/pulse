// apps/web/tests/ui-status-maps.test.tsx — pulse status maps on `defineStatusMap`.
import { describe, expect, it } from "bun:test";

import {
  ALERT_SEVERITY,
  ALERT_STATE,
  ICONS,
  MUTATION_STATE,
  StatusBadge,
  TARGET_STATUS,
  alertSeverityOf,
  alertStateOf,
  type StatusMap,
} from "@/ui";

import { STATUS_LABEL } from "../src/client/a11y/status-labels.js";
import {
  ACTION_STATE_STATUS,
  PROPOSAL_STATE_STATUS,
  SEVERITY_STATUS,
  SWIM_ROW_STATUS,
} from "../src/client/status/target-status.js";
import { describeUi, render, screen } from "./rtl.js";
import { contrastRatio, tokenColor, type Mode } from "./support/tokens.js";

const MODES: readonly Mode[] = ["light", "dark"];

// Domain key sets come from existing total records over each domain type, so a new
// domain value fails here as well as in the typecheck.
const MAPS: readonly (readonly [string, StatusMap<string>, readonly string[]])[] = [
  ["TARGET_STATUS", TARGET_STATUS, Object.keys(STATUS_LABEL)],
  ["ALERT_SEVERITY", ALERT_SEVERITY, Object.keys(SWIM_ROW_STATUS)],
  ["ALERT_STATE", ALERT_STATE, [...Object.keys(SWIM_ROW_STATUS), "suppressed"]],
  [
    "MUTATION_STATE",
    MUTATION_STATE,
    [...new Set([...Object.keys(ACTION_STATE_STATUS), ...Object.keys(PROPOSAL_STATE_STATUS)])],
  ],
];

describe("pulse status maps", () => {
  for (const [name, map, domain] of MAPS) {
    describe(name, () => {
      it("is exhaustive over its domain type, with curated icons and a label", () => {
        expect(Object.keys(map).sort()).toEqual([...domain].sort());
        for (const [state, entry] of Object.entries(map)) {
          expect(Object.hasOwn(ICONS, entry.icon), `${state} icon ${entry.icon}`).toBe(true);
          expect(entry.label.length, `${state} label`).toBeGreaterThan(0);
        }
      });

      for (const mode of MODES) {
        it(`clears 4.5:1 text contrast for every entry in ${mode}`, () => {
          for (const [state, { tone }] of Object.entries(map)) {
            const fg = tokenColor(mode, `--status-${tone}-fg`);
            // Soft badges sit on the tone's own bg; outline/dot badges sit on the page.
            for (const surface of [`--status-${tone}-bg`, "--background"]) {
              const ratio = contrastRatio(fg, tokenColor(mode, surface));
              expect(ratio, `${state} (${tone}) on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
          }
        });
      }
    });
  }

  it("TARGET_STATUS matches the status vocabulary", () => {
    expect(
      Object.fromEntries(
        Object.entries(TARGET_STATUS).map(([s, e]) => [s, [e.tone, e.icon, e.label, e.role, e.variant]]),
      ),
    ).toEqual({
      ok: ["ok", "circle-check", "OK", undefined, undefined],
      warning: ["warn", "triangle-alert", "Warning", undefined, undefined],
      critical: ["danger", "octagon-alert", "Critical", undefined, undefined],
      unknown: ["neutral", "circle-help", "Unknown", undefined, undefined],
      suppressed: ["neutral", "circle-minus", "Suppressed", undefined, "outline"],
    });
  });

  it("TARGET_STATUS entries are distinct in grayscale: five distinct (icon, variant) pairs", () => {
    const pairs = Object.values(TARGET_STATUS).map((e) => `${e.icon}|${e.variant ?? "soft"}`);
    expect(new Set(pairs).size).toBe(5);
    expect(TARGET_STATUS.suppressed.variant).toBe("outline");
    expect(TARGET_STATUS.unknown.variant ?? "soft").not.toBe("outline");
  });

  it("ALERT_SEVERITY gives info its own tone and covers every known wire severity", () => {
    expect(ALERT_SEVERITY.info.tone).toBe("info");
    expect(ALERT_SEVERITY.critical.tone).toBe("danger");
    expect(ALERT_SEVERITY.warning.tone).toBe("warn");
    expect(ALERT_SEVERITY.unknown.tone).toBe("neutral");
    for (const severity of Object.keys(SEVERITY_STATUS)) {
      expect(alertSeverityOf(severity)).toBe(severity as ReturnType<typeof alertSeverityOf>);
    }
    expect(alertSeverityOf("page-me-now")).toBe("unknown");
    expect(alertSeverityOf("")).toBe("unknown");
  });

  it("ALERT_STATE: a firing alert takes its severity (info → info, not unknown); suppression is suppressed", () => {
    expect(alertStateOf("firing", "info")).toBe("info");
    expect(alertStateOf("firing", "critical")).toBe("critical");
    expect(alertStateOf("firing", "warning")).toBe("warning");
    expect(alertStateOf("firing", "page-me-now")).toBe("unknown");
    expect(alertStateOf("silenced", "info")).toBe("suppressed");
    expect(alertStateOf("inhibited", "critical")).toBe("suppressed");
    for (const severity of ["critical", "warning", "info", "unknown"] as const) {
      expect(ALERT_STATE[severity]).toEqual(ALERT_SEVERITY[severity]);
    }
    expect(ALERT_STATE.suppressed).toMatchObject({ tone: "neutral", icon: "bell", variant: "outline" });
    // Distinct without colour: five distinct (icon, variant) pairs.
    const pairs = Object.values(ALERT_STATE).map((e) => `${e.icon}|${e.variant ?? "soft"}`);
    expect(new Set(pairs).size).toBe(5);
  });

  it("MUTATION_STATE maps acked → neutral, pending → pending, failed → danger with StateBadge labels", () => {
    expect(MUTATION_STATE.acked).toMatchObject({ tone: "neutral", label: "Acknowledged" });
    expect(MUTATION_STATE.pending).toMatchObject({ tone: "pending", label: "Pending" });
    expect(MUTATION_STATE.failed).toMatchObject({ tone: "danger", label: "Failed" });
    expect(MUTATION_STATE.applied).toMatchObject({ tone: "ok", label: "Applied" });
    expect(MUTATION_STATE.rejected).toMatchObject({ tone: "neutral", label: "Rejected" });
  });
});

describeUi("StatusBadge.fromMap over pulse maps", () => {
  it("renders critical without a live region unless the caller opts in", () => {
    render(StatusBadge.fromMap(TARGET_STATUS, "critical"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders critical as role=alert with icon and text when the caller opts in", () => {
    render(StatusBadge.fromMap(TARGET_STATUS, "critical", { role: "alert" }));
    const badge = screen.getByRole("alert");
    expect(badge).toHaveTextContent("Critical");
    expect(badge).toHaveAttribute("data-tone", "danger");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders suppressed as an outline badge and unknown as the default soft badge", () => {
    render(
      <>
        {StatusBadge.fromMap(TARGET_STATUS, "suppressed")}
        {StatusBadge.fromMap(TARGET_STATUS, "unknown")}
      </>,
    );
    const suppressed = screen.getByText("Suppressed").closest("[data-slot='status-badge']");
    const unknown = screen.getByText("Unknown").closest("[data-slot='status-badge']");
    expect(suppressed).toHaveAttribute("data-variant", "outline");
    expect(unknown).toHaveAttribute("data-variant", "soft");
  });

  it("lets caller props override the entry's variant", () => {
    render(StatusBadge.fromMap(TARGET_STATUS, "suppressed", { variant: "dot" }));
    expect(screen.getByText("Suppressed").closest("[data-slot='status-badge']")).toHaveAttribute(
      "data-variant",
      "dot",
    );
  });
});
