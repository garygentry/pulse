// apps/web/tests/links.test.ts — Grafana deep-link construction (04-snapshot-and-status.md §6).
//
// Covers: a resolved board+variable link (observed label, URL-encoded, origin de-trailing-slashed),
// the no-board case (null), the missing-observed-series case (null), and the disabled-origin case
// (`url:""`) when PULSE_GRAFANA_URL is unset (grafanaOrigin === null). Links use the OBSERVED live
// series label, never the model's `drilldownId` (§6.1).

import { describe, expect, test } from "bun:test";

import { host, service } from "./factories.js";
import type { BuildConfig } from "../src/server/snapshot/build.js";
import { hostGrafanaLink, serviceGrafanaLink } from "../src/server/snapshot/build.js";
import type { LiveSeries } from "../src/server/sources/types.js";

function cfg(over: Partial<BuildConfig> = {}): BuildConfig {
  return {
    appVersion: "1.0.0",
    timezone: "UTC",
    tzFallback: true,
    grafanaOrigin: "https://grafana.example",
    gatusStaleSeconds: 300,
    ...over,
  };
}

/** The observed `up` series whose `instance` label is the board's variable value. */
function upSeries(hostName: string, instance: string): LiveSeries {
  return { name: "up", labels: { job: "managed-linux", host: hostName, instance }, value: 1 };
}

const deepSeries: LiveSeries = {
  name: "pulse_deep_health_up",
  labels: { host: "web01", service: "grafana" },
  value: 1,
};

describe("hostGrafanaLink — resolved board + variable", () => {
  test("managed-linux host → /d/pulse-host?var-instance=<observed>, URL-encoded", () => {
    const link = hostGrafanaLink(host({ name: "web01" }), [upSeries("web01", "web01:9100")], cfg());
    expect(link).toEqual({
      boardUid: "pulse-host",
      url: "https://grafana.example/d/pulse-host?var-instance=web01%3A9100",
    });
  });

  test("uses the OBSERVED instance label, not the model drilldownId", () => {
    // drilldownId is "host:api01" but the observed instance is the API endpoint URL.
    const link = hostGrafanaLink(
      host({ name: "pve1", collectionClass: "hypervisor-api", drilldownId: "host:pve1" }),
      [upSeries("pve1", "https://pve1.example:8006")],
      cfg(),
    );
    expect(link!.boardUid).toBe("pulse-hypervisor");
    expect(link!.url).toContain("var-instance=https%3A%2F%2Fpve1.example%3A8006");
    expect(link!.url).not.toContain("host:pve1"); // never the drilldownId
  });

  test("strips a trailing slash from the origin", () => {
    const link = hostGrafanaLink(
      host({ name: "web01" }),
      [upSeries("web01", "web01:9100")],
      cfg({ grafanaOrigin: "https://grafana.example/" }),
    );
    expect(link!.url).toBe("https://grafana.example/d/pulse-host?var-instance=web01%3A9100");
  });
});

describe("serviceGrafanaLink — deep-health board", () => {
  test("deep-health service → /d/pulse-deephealth?var-service=<observed>", () => {
    const link = serviceGrafanaLink(
      service({ name: "grafana", host: "web01", deepHealth: true }),
      [deepSeries],
      cfg(),
    );
    expect(link).toEqual({
      boardUid: "pulse-deephealth",
      url: "https://grafana.example/d/pulse-deephealth?var-service=grafana",
    });
  });
});

describe("no board for the class → null", () => {
  test("probe-only host has no board", () => {
    expect(
      hostGrafanaLink(host({ name: "p1", collectionClass: "probe-only" }), [upSeries("p1", "p1")], cfg()),
    ).toBeNull();
  });

  test("excluded host has no board", () => {
    expect(
      hostGrafanaLink(host({ name: "x1", collectionClass: "excluded" }), [upSeries("x1", "x1")], cfg()),
    ).toBeNull();
  });

  test("a non-deep-health service has no board", () => {
    expect(
      serviceGrafanaLink(service({ name: "s1", host: "web01", deepHealth: false }), [deepSeries], cfg()),
    ).toBeNull();
  });
});

describe("board exists but no observed series → null", () => {
  test("host with a mapped board but no `up` series", () => {
    expect(hostGrafanaLink(host({ name: "web01" }), [], cfg())).toBeNull();
  });

  test("deep-health service with no matching deep-health series", () => {
    expect(
      serviceGrafanaLink(service({ name: "grafana", host: "web01", deepHealth: true }), [], cfg()),
    ).toBeNull();
  });
});

describe("disabled-origin convention (PULSE_GRAFANA_URL unset)", () => {
  test("board + observed series but grafanaOrigin === null → { boardUid, url: '' }", () => {
    const link = hostGrafanaLink(
      host({ name: "web01" }),
      [upSeries("web01", "web01:9100")],
      cfg({ grafanaOrigin: null }),
    );
    expect(link).toEqual({ boardUid: "pulse-host", url: "" });
  });

  test("service link is likewise disabled (url:'') when origin is unset", () => {
    const link = serviceGrafanaLink(
      service({ name: "grafana", host: "web01", deepHealth: true }),
      [deepSeries],
      cfg({ grafanaOrigin: null }),
    );
    expect(link).toEqual({ boardUid: "pulse-deephealth", url: "" });
  });

  test("no board still wins over disabled origin (null, not url:'')", () => {
    expect(
      hostGrafanaLink(host({ name: "p1", collectionClass: "probe-only" }), [], cfg({ grafanaOrigin: null })),
    ).toBeNull();
  });
});
