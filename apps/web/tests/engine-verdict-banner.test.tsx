// tests/engine-verdict-banner.test.tsx — F32: a degraded verdict names its down scrape targets.
import { expect, test } from "bun:test";
import type { EnginePayload } from "@pulse/web-data/wire";

import { VerdictBanner, downTargetNames } from "../src/client/views/engine/verdict-banner.js";
import { presentVerdict } from "../src/client/views/engine/verdict.js";
import { describeUi, render, screen } from "./rtl.js";

const target = (job: string, instance: string, health: "up" | "down" | "unknown") =>
  ({ job, instance, scrapeUrl: null, health, lastScrapeAt: null, lastError: null });

describeUi("VerdictBanner — down targets (F32)", () => {
  test("names up to three down targets, then 'and N more'", () => {
    const verdict = { kind: "degraded", contributors: ["5 scrape targets down"] } as const;
    const names = ["a 1", "b 2", "c 3", "d 4", "e 5"];
    render(<VerdictBanner verdict={verdict} presentation={presentVerdict(verdict, String)} kiosk={false} downTargets={names} />);
    expect(screen.getByRole("status").textContent).toContain("Down: a 1, b 2, c 3, and 2 more");
  });

  test("an OK verdict names nothing", () => {
    const verdict = { kind: "ok" } as const;
    render(<VerdictBanner verdict={verdict} presentation={presentVerdict(verdict, String)} kiosk={false} downTargets={["a 1"]} />);
    expect(screen.getByRole("status").textContent).not.toContain("Down:");
  });
});

test("downTargetNames lists every target that is not up, as 'job instance'", () => {
  const engine = {
    scrapeJobs: [
      { job: "node", state: "unhealthy", targets: [target("node", "h1", "up"), target("node", "h2", "down")] },
      { job: "prober", state: "unknown", targets: [target("prober", "p:9120", "unknown")] },
    ],
  } as unknown as EnginePayload;
  expect(downTargetNames(engine)).toEqual(["node h2", "prober p:9120"]);
  expect(downTargetNames(null)).toEqual([]);
});
