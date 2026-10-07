// apps/web/tests/build.test.ts — the pure snapshot fold (04-snapshot-and-status.md §2/§3/§7/§8).
//
// Covers the §3.5 resolution matrix (all seven rows + the info-never-colours corner), roll-up
// (suppressed contributes nothing + unknown propagates), matching (host / service / endpoint /
// unattributed / DeadMansSwitch), and the induced-alert red-rollup transition (SC-1 unit half).
// buildSnapshot is pure — every case injects `now` and `SourceData` explicitly; no clock/env read.

import { describe, expect, test } from "bun:test";

import { host, model, ok, down, service } from "./factories.js";
import type { SourceData, BuildConfig } from "../src/server/snapshot/build.js";
import { buildSnapshot, matchAlerts, resolveStatus } from "../src/server/snapshot/build.js";
import type { LiveSeries, RawActiveAlert, RawCheckStatus } from "../src/server/sources/types.js";
import type { ActiveAlert } from "../src/shared/snapshot.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");

const CFG: BuildConfig = {
  appVersion: "1.0.0",
  timezone: "UTC",
  tzFallback: true,
  grafanaOrigin: "https://grafana.example",
  gatusStaleSeconds: 300,
};

/** Assemble a full `SourceData` from the parts a test cares about; all sources healthy by default. */
function sd(over: {
  series?: LiveSeries[];
  alerts?: RawActiveAlert[];
  endpoints?: RawCheckStatus[];
  alertsOk?: boolean;
  livenessOk?: boolean;
  checksOk?: boolean;
} = {}): SourceData {
  return {
    liveness: {
      series: over.series ?? [],
      health: over.livenessOk === false ? down("vm unreachable") : ok(),
    },
    alerts: {
      active: over.alerts ?? [],
      health: over.alertsOk === false ? down("am unreachable") : ok(),
    },
    checks: {
      endpoints: over.endpoints ?? [],
      health: over.checksOk === false ? down("gatus unreachable") : ok(),
    },
  };
}

/** A raw Alertmanager alert with the given labels/annotations. */
function raw(labels: Record<string, string>, over: Partial<RawActiveAlert> = {}): RawActiveAlert {
  return { fingerprint: "fp-test", labels, annotations: {}, startsAt: "2026-08-22T11:59:00.000Z", ...over };
}

/** A raw Gatus check status whose `name` is the endpoint identity (`<host>/<svc>` or `host:<name>`). */
function check(name: string, success = true): RawCheckStatus {
  return { name, latest: { success, timestamp: "2026-08-22T11:59:30.000Z" } };
}

/** The `up` series that makes a managed-linux host affirmatively live. */
function upSeries(hostName: string, instance = `${hostName}:9100`): LiveSeries {
  return { name: "up", labels: { job: "managed-linux", host: hostName, instance }, value: 1 };
}

// ── §3.5 resolution matrix — all seven rows (resolveStatus is total) ─────────────────────────────

describe("resolveStatus — the §3.5 matrix", () => {
  const noAlerts: ActiveAlert[] = [];
  const crit: ActiveAlert[] = [{ fingerprint: "c", name: "X", severity: "critical", startsAt: "", target: null }];
  const warn: ActiveAlert[] = [{ fingerprint: "w", name: "X", severity: "warning", startsAt: "", target: null }];
  const info: ActiveAlert[] = [{ fingerprint: "i", name: "X", severity: "info", startsAt: "", target: null }];

  test("row 1: suppressed → suppressed (wins over everything)", () => {
    expect(
      resolveStatus({ suppressed: true, alertsAvailable: false, alerts: crit, live: null }),
    ).toBe("suppressed");
  });

  test("row 2: alerts source unreachable → unknown", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: false, alerts: noAlerts, live: true }),
    ).toBe("unknown");
  });

  test("row 3: critical alert → critical (over any live)", () => {
    for (const live of [true, false, null] as const) {
      expect(resolveStatus({ suppressed: false, alertsAvailable: true, alerts: crit, live })).toBe(
        "critical",
      );
    }
  });

  test("row 4: warning alert → warning", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: true, alerts: warn, live: false }),
    ).toBe("warning");
  });

  test("row 5: live=true, no colouring alert → ok", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: true, alerts: noAlerts, live: true }),
    ).toBe("ok");
  });

  test("row 6: live=false, no alert → unknown", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: true, alerts: noAlerts, live: false }),
    ).toBe("unknown");
  });

  test("row 7: live=null (liveness source down), no alert → unknown", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: true, alerts: noAlerts, live: null }),
    ).toBe("unknown");
  });

  test("info-only alert with live=true → ok (info never colours)", () => {
    expect(
      resolveStatus({ suppressed: false, alertsAvailable: true, alerts: info, live: true }),
    ).toBe("ok");
  });

  test("green REQUIRES live===true (never ok when live is false/null)", () => {
    for (const live of [false, null] as const) {
      expect(
        resolveStatus({ suppressed: false, alertsAvailable: true, alerts: noAlerts, live }),
      ).not.toBe("ok");
    }
  });
});

// ── Roll-up (REQ-GRID-03, §7) ────────────────────────────────────────────────────────────────────

describe("roll-up", () => {
  test("unknown propagates from a service to the host cell", () => {
    // Host itself ok (live up-series + no alert); a bare service (no signal) → unknown.
    const m = model({
      hosts: [host({ name: "h1" })],
      services: [service({ name: "s1", host: "h1", deepHealth: false })], // no ingress → live=false → unknown
    });
    const snap = buildSnapshot(m, sd({ series: [upSeries("h1")] }), NOW, CFG);
    expect(snap.hosts[0]!.status).toBe("ok");
    expect(snap.hosts[0]!.services[0]!.status).toBe("unknown");
    expect(snap.hosts[0]!.rollup).toBe("unknown"); // propagates
  });

  test("a suppressed service contributes nothing to the roll-up", () => {
    const m = model({
      hosts: [host({ name: "h1" })],
      services: [
        service({
          name: "s1",
          host: "h1",
          deepHealth: false,
          suppressed: { class: "known-expected", rationale: "planned" },
        }),
      ],
    });
    const snap = buildSnapshot(m, sd({ series: [upSeries("h1")] }), NOW, CFG);
    expect(snap.hosts[0]!.services[0]!.status).toBe("suppressed");
    expect(snap.hosts[0]!.rollup).toBe("ok"); // suppressed service excluded → host's own ok wins
  });
});

// ── Matching (§4) ────────────────────────────────────────────────────────────────────────────────

describe("matching", () => {
  const m = model({
    hosts: [host({ name: "h1", drilldownId: "host:h1" })],
    services: [service({ name: "s1", host: "h1", drilldownId: "svc:h1/s1", deepHealth: false })],
  });

  test("host-scoped alert attributes to the declared host", () => {
    const matched = matchAlerts(m, [raw({ alertname: "A", severity: "warning", host: "h1" })]);
    expect(matched.byHost.get("h1")).toHaveLength(1);
    expect(matched.all[0]!.target).toEqual({ kind: "host", id: "host:h1" });
  });

  test("service-scoped alert attributes to the declared service", () => {
    const matched = matchAlerts(m, [
      raw({ alertname: "A", severity: "critical", host: "h1", service: "s1" }),
    ]);
    expect(matched.byService.get("h1\0s1")).toHaveLength(1);
    expect(matched.all[0]!.target).toEqual({ kind: "service", id: "svc:h1/s1" });
  });

  test("endpoint=host:<n> → host; endpoint=<h>/<n> → service", () => {
    const asHost = matchAlerts(m, [raw({ alertname: "A", severity: "warning", endpoint: "host:h1" })]);
    expect(asHost.all[0]!.target).toEqual({ kind: "host", id: "host:h1" });
    const asSvc = matchAlerts(m, [raw({ alertname: "A", severity: "warning", endpoint: "h1/s1" })]);
    expect(asSvc.all[0]!.target).toEqual({ kind: "service", id: "svc:h1/s1" });
  });

  test("dns:<domain> and undeclared candidates are unattributed (strip only, no fall-back)", () => {
    const matched = matchAlerts(m, [
      raw({ alertname: "A", severity: "warning", endpoint: "dns:example.com" }),
      raw({ alertname: "B", severity: "warning", host: "nope" }), // undeclared host
      raw({ alertname: "C", severity: "warning", host: "h1", service: "ghost" }), // undeclared svc, no host fall-back
    ]);
    expect(matched.all).toHaveLength(3);
    for (const a of matched.all) expect(a.target).toBeNull();
    expect(matched.byHost.size).toBe(0);
    expect(matched.byService.size).toBe(0);
  });

  test("DeadMansSwitch is dropped from the strip and every cell", () => {
    const matched = matchAlerts(m, [
      raw({ alertname: "DeadMansSwitch", severity: "critical", host: "h1" }),
      raw({ alertname: "Real", severity: "warning", host: "h1" }),
    ]);
    expect(matched.all).toHaveLength(1);
    expect(matched.all[0]!.name).toBe("Real");
    // And in a full snapshot: DeadMansSwitch neither colours nor appears in the strip.
    const snap = buildSnapshot(
      m,
      sd({
        series: [upSeries("h1")],
        alerts: [raw({ alertname: "DeadMansSwitch", severity: "critical", host: "h1" })],
      }),
      NOW,
      CFG,
    );
    expect(snap.alerts).toHaveLength(0);
    expect(snap.hosts[0]!.status).toBe("ok"); // not coloured by the deadman
  });

  test("an unrecognized severity coerces to info (never colours)", () => {
    const matched = matchAlerts(m, [raw({ alertname: "A", severity: "bogus", host: "h1" })]);
    expect(matched.all[0]!.severity).toBe("info");
  });

  // Check attribution (§3.5 / §4.2): a raw CheckResult lands on the declared host/service `.checks[]`
  // by exact endpoint-name equality; a near-miss attaches to nothing (SC-3).
  test("CheckResult endpoint=<h>/<n> lands on that service's checks[]", () => {
    const snap = buildSnapshot(
      m,
      sd({ series: [upSeries("h1")], endpoints: [check("h1/s1")] }),
      NOW,
      CFG,
    );
    expect(snap.hosts[0]!.services[0]!.checks.map((c) => c.endpoint)).toEqual(["h1/s1"]);
    expect(snap.hosts[0]!.checks).toHaveLength(0); // not on the host cell
  });

  test("CheckResult endpoint=host:<n> lands on that host's checks[]", () => {
    const snap = buildSnapshot(
      m,
      sd({ series: [upSeries("h1")], endpoints: [check("host:h1")] }),
      NOW,
      CFG,
    );
    expect(snap.hosts[0]!.checks.map((c) => c.endpoint)).toEqual(["host:h1"]);
    expect(snap.hosts[0]!.services[0]!.checks).toHaveLength(0); // not on the service cell
  });

  test("a near-miss endpoint (exact equality) attaches to nothing", () => {
    const snap = buildSnapshot(
      m,
      sd({
        series: [upSeries("h1")],
        endpoints: [check("h1/s1x"), check("h10/s1"), check("host:h1x"), check("host:nope")],
      }),
      NOW,
      CFG,
    );
    expect(snap.hosts[0]!.checks).toHaveLength(0);
    expect(snap.hosts[0]!.services[0]!.checks).toHaveLength(0);
  });
});

// ── Strip ordering (§8) ──────────────────────────────────────────────────────────────────────────

describe("strip assembly", () => {
  test("severity-desc then startsAt-desc; unattributed included", () => {
    const m = model({ hosts: [host({ name: "h1" })], services: [] });
    const snap = buildSnapshot(
      m,
      sd({
        alerts: [
          raw({ alertname: "warn-old", severity: "warning", host: "h1" }, { startsAt: "2026-08-22T10:00:00Z" }),
          raw({ alertname: "crit", severity: "critical", host: "h1" }, { startsAt: "2026-08-22T09:00:00Z" }),
          raw({ alertname: "warn-new", severity: "warning", host: "h1" }, { startsAt: "2026-08-22T11:00:00Z" }),
          raw({ alertname: "loose", severity: "info", endpoint: "dns:example.com" }, { startsAt: "2026-08-22T11:30:00Z" }),
        ],
      }),
      NOW,
      CFG,
    );
    expect(snap.alerts.map((a) => a.name)).toEqual(["crit", "warn-new", "warn-old", "loose"]);
    expect(snap.alerts.at(-1)!.target).toBeNull(); // unattributed still listed
  });
});

// ── Induced-alert red-rollup transition (SC-1, unit half) ────────────────────────────────────────

describe("induced-alert red-rollup transition (SC-1 unit half)", () => {
  const m = model({
    hosts: [host({ name: "web01" })],
    services: [service({ name: "grafana", host: "web01", deepHealth: true })],
  });
  const live: LiveSeries[] = [
    upSeries("web01"),
    { name: "pulse_agent_up", labels: { host: "web01" }, value: 1 },
    { name: "pulse_deep_health_up", labels: { host: "web01", service: "grafana" }, value: 1 },
  ];

  test("all-green before, host cell red after a critical service alert appears", () => {
    const before = buildSnapshot(m, sd({ series: live }), NOW, CFG);
    expect(before.hosts[0]!.rollup).toBe("ok");
    expect(before.hosts[0]!.services[0]!.status).toBe("ok");

    const after = buildSnapshot(
      m,
      sd({
        series: live,
        alerts: [raw({ alertname: "DeepHealthDown", severity: "critical", host: "web01", service: "grafana" })],
      }),
      NOW,
      CFG,
    );
    expect(after.hosts[0]!.services[0]!.status).toBe("critical");
    expect(after.hosts[0]!.rollup).toBe("critical"); // nothing red hides inside a green cell
    expect(after.hosts[0]!.status).toBe("ok"); // the host's OWN status is unchanged
  });
});

// ── Grid membership + envelope ───────────────────────────────────────────────────────────────────

describe("grid membership + envelope", () => {
  test("a zero-host model yields hosts:[] without throwing", () => {
    const snap = buildSnapshot(model({ hosts: [], services: [] }), sd(), NOW, CFG);
    expect(snap.hosts).toEqual([]);
    expect(snap.generatedAt).toBe(NOW.toISOString());
  });

  test("every declared host appears regardless of series/alert presence", () => {
    const m = model({
      hosts: [host({ name: "a" }), host({ name: "b" })],
      services: [],
    });
    const snap = buildSnapshot(m, sd(), NOW, CFG);
    expect(snap.hosts.map((h) => h.name)).toEqual(["a", "b"]);
  });

  test("sources pass the corresponding SourceHealth through unchanged", () => {
    const data = sd({ alertsOk: false });
    const snap = buildSnapshot(model({ hosts: [], services: [] }), data, NOW, CFG);
    expect(snap.sources.metrics).toBe(data.liveness.health);
    expect(snap.sources.alerts).toBe(data.alerts.health);
    expect(snap.sources.checks).toBe(data.checks.health);
  });
});
