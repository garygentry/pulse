// apps/web/tests/ui-status.test.tsx — ported from deck's `ui-status` suite (vendored `@/ui`).
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { ReactNode } from "react";

import {
  FRESHNESS_STATUS,
  FreshnessBadge,
  HealthPill,
  RelativeTime,
  StatusBadge,
  TONES,
  TooltipProvider,
  defineStatusMap,
  freshnessTitle,
} from "@/ui";

import { restoreRealTimers } from "./dom.js";
import { act, describeUi, render, screen, within } from "./rtl.js";

// Tooltips are asserted as wired (a Radix trigger: `data-state`, keyboard-reachable)
// rather than opened. Opening is covered by the browser (workbench) run.

describeUi("@/ui status", () => {
  afterEach(restoreRealTimers);

  const NOW = Date.parse("2026-01-15T12:00:00Z");
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  function renderUi(ui: ReactNode) {
    return render(<TooltipProvider>{ui}</TooltipProvider>);
  }

  describe("StatusBadge", () => {
    it("always renders an icon and the text label (never colour alone), for every tone and variant", () => {
      for (const variant of ["soft", "outline", "dot"] as const) {
        for (const tone of TONES) {
          const { container, unmount } = renderUi(
            <StatusBadge tone={tone} icon="circle-check" label={`Label ${tone}`} variant={variant} />,
          );
          const badge = container.querySelector('[data-slot="status-badge"]')!;
          expect(badge).toHaveAttribute("data-tone", tone);
          expect(badge).toHaveTextContent(`Label ${tone}`);
          const icon = badge.querySelector("svg")!;
          expect(icon).toHaveAttribute("aria-hidden", "true");
          expect(badge).not.toHaveAttribute("data-icon");
          unmount();
        }
      }
    });

    it("renders the detail as part of the accessible text", () => {
      renderUi(
        <StatusBadge tone="ok" icon="circle-check" label="Fresh" detail="as of 58s ago" role="status" />,
      );
      const badge = screen.getByRole("status");
      expect(badge).toHaveTextContent(/Fresh\s*·\s*as of 58s ago/);
    });

    it("is not focusable without a tooltip, and is a focusable tooltip trigger with one", () => {
      const { rerender } = renderUi(<StatusBadge tone="info" icon="info" label="Waived" />);
      expect(screen.getByText("Waived").closest("[data-slot]")).not.toHaveAttribute("tabindex");

      rerender(
        <TooltipProvider>
          <StatusBadge tone="info" icon="info" label="Waived" title="Waived until February" />
        </TooltipProvider>,
      );
      const badge = screen.getByText("Waived").closest('[data-slot="status-badge"]') as HTMLElement;
      expect(badge).toHaveAttribute("tabindex", "0");
      expect(badge).toHaveAttribute("data-state", "closed");
    });

    it("applies the map's role (e.g. alert) via fromMap, and lets props override", () => {
      const MAP = defineStatusMap<"up" | "down">({
        up: { tone: "ok", icon: "circle-check", label: "Up" },
        down: { tone: "danger", icon: "circle-x", label: "Down", role: "alert" },
      });
      renderUi(
        <>
          {StatusBadge.fromMap(MAP, "down")}
          {StatusBadge.fromMap(MAP, "up", { detail: "3 checks", variant: "outline" })}
        </>,
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Down");
      const up = screen.getByText("Up").closest('[data-slot="status-badge"]')!;
      expect(up).toHaveAttribute("data-variant", "outline");
      expect(up).toHaveAttribute("data-tone", "ok");
      expect(up).toHaveTextContent("3 checks");
      expect(up).not.toHaveAttribute("role");
    });
  });

  describe("RelativeTime", () => {
    it("renders a <time> with the machine instant and relative text from an explicit now", () => {
      const iso = ago(6 * 60_000);
      const { container } = renderUi(<RelativeTime value={iso} now={NOW} />);
      const time = container.querySelector("time")!;
      expect(time).toHaveAttribute("datetime", iso);
      expect(time).toHaveAttribute("data-slot", "relative-time");
      expect(time).toHaveTextContent("6m ago");
    });

    it("renders unparseable input verbatim", () => {
      renderUi(<RelativeTime value="not-a-date" now={NOW} />);
      expect(screen.getByText("not-a-date").tagName).toBe("TIME");
    });

    it("ticks against the clock when no now is given", () => {
      jest.useFakeTimers({ now: NOW });
      renderUi(<RelativeTime value={ago(0)} tickMs={1_000} />);
      expect(screen.getByText("just now")).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(2 * 60_000);
      });
      expect(screen.getByText("2m ago")).toBeInTheDocument();
    });

    it("is a tooltip trigger for valid input only, and adds no tab stop", () => {
      renderUi(
        <>
          <RelativeTime value={ago(3 * 3_600_000)} now={NOW} />
          <RelativeTime value="not-a-date" now={NOW} />
          <RelativeTime value={ago(1_000)} now={NOW} tooltip={false} />
        </>,
      );
      expect(screen.getByText("3h ago")).toHaveAttribute("data-state", "closed");
      expect(screen.getByText("3h ago")).not.toHaveAttribute("tabindex");
      expect(screen.getByText("not-a-date")).not.toHaveAttribute("data-state");
      expect(screen.getByText("just now")).not.toHaveAttribute("data-state");
    });
  });

  describe("FreshnessBadge", () => {
    it("uses the shared wording: label plus '· as of <age>' for polled states", () => {
      renderUi(
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "stale", observedAt: ago(6 * 60_000), ageMs: null, ttlMs: 60_000 }}
        />,
      );
      const badge = screen.getByText("Stale").closest('[data-slot="freshness-badge"]')!;
      expect(badge).toHaveAttribute("data-freshness", "stale");
      expect(badge).toHaveTextContent(/Stale\s*·\s*as of 6m ago/);
      expect(within(badge as HTMLElement).getByText("6m ago").tagName).toBe("TIME");
    });

    it("shows no age for static and pending stamps", () => {
      renderUi(
        <>
          <FreshnessBadge freshness={{ state: "static", observedAt: null, ageMs: null, ttlMs: null }} />
          <FreshnessBadge freshness={{ state: "pending", observedAt: null, ageMs: 5_000, ttlMs: null }} />
        </>,
      );
      expect(screen.getByText("Link").closest("[data-slot]")).not.toHaveTextContent("as of");
      expect(screen.getByText("Loading…").closest("[data-slot]")).not.toHaveTextContent("as of");
    });

    it("ticks from the server ageMs when no now is given", () => {
      jest.useFakeTimers({ now: NOW });
      renderUi(
        <FreshnessBadge
          tickMs={1_000}
          freshness={{ state: "fresh", observedAt: null, ageMs: 42_000, ttlMs: null }}
        />,
      );
      expect(screen.getByText(/as of 42s ago/)).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(screen.getByText(/as of 1m ago/)).toBeInTheDocument();
    });

    it("covers every freshness state and wires the observation title as a tooltip", () => {
      expect(Object.keys(FRESHNESS_STATUS).sort()).toEqual(
        ["fresh", "pending", "stale", "static", "unreachable"],
      );
      const stamp = { state: "fresh", observedAt: ago(1_000), ageMs: null, ttlMs: 60_000 } as const;
      expect(freshnessTitle(stamp)).toBe(`Observed ${stamp.observedAt} (stale after 60s)`);
      renderUi(<FreshnessBadge now={NOW} freshness={stamp} />);
      const badge = screen.getByText("Fresh").closest("[data-slot]") as HTMLElement;
      expect(badge).toHaveAttribute("data-state", "closed");
      expect(badge).toHaveAttribute("tabindex", "0");
    });

    it("is not focusable when the tooltip is turned off (e.g. inside a link)", () => {
      renderUi(
        <FreshnessBadge
          tooltip={false}
          freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
        />,
      );
      expect(screen.getByText("Loading…").closest("[data-slot]")).not.toHaveAttribute("tabindex");
    });
  });

  describe("HealthPill", () => {
    it("is a single link to the owning page named by its label and count", () => {
      renderUi(<HealthPill tone="danger" icon="octagon-alert" label="Alerts" count={12} href="/monitoring" />);
      const link = screen.getByRole("link", { name: "Alerts 12" });
      expect(link).toHaveAttribute("href", "/monitoring");
      expect(link).toHaveAttribute("data-slot", "health-pill");
      expect(link).toHaveAttribute("data-tone", "danger");
      expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("uses countLabel as the spoken count", () => {
      renderUi(
        <HealthPill
          tone="warn"
          icon="triangle-alert"
          label="Drift"
          count={3}
          countLabel="3 active findings"
          href="/drift"
        />,
      );
      expect(screen.getByRole("link", { name: "Drift 3 active findings" })).toBeInTheDocument();
    });

    it("includes meta content (a freshness badge) without nesting focusable elements", () => {
      renderUi(
        <HealthPill
          tone="pending"
          icon="hourglass"
          label="Metrics"
          href="/monitoring"
          meta={
            <FreshnessBadge
              tooltip={false}
              freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
            />
          }
        />,
      );
      const link = screen.getByRole("link", { name: /Metrics\s+Loading…/ });
      expect(link.querySelector("[tabindex]")).toBeNull();
    });

    it("is itself the tooltip trigger (for truncated text), so the tooltip is keyboard-reachable", () => {
      const label = "Two endpoints degraded across the lab";
      renderUi(<HealthPill tone="warn" icon="triangle-alert" label={label} href="/" />);
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("data-state", "closed");
    });
  });
});
