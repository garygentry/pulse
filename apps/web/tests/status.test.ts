// apps/web/tests/status.test.ts — the roll-up fold (00-core-definitions.md §3, REQ-GRID-03).
//
// Covers the two invariants every later grid/rollup test relies on: `suppressed` contributes
// nothing to a host cell's roll-up, and `unknown` propagates (a monitoring gap is visible at a
// glance). Also pins the worst-of-severity ordering and the all-suppressed edge case.

import { describe, expect, test } from "bun:test";

import { ROLLUP_ORDER, SEVERITY_ORDER, rollup } from "../src/shared/status.js";
import type { HealthBody, SourceHealth, TargetStatus } from "../src/shared/snapshot.js";
import { getRuntimeStatus, setRuntimeStatus, type RuntimeStatus } from "../src/server/refresh.js";
import { healthzRoute } from "../src/server/routes/healthz.js";
import { renderMetrics } from "../src/server/routes/metrics.js";
import { renderErrorPage } from "../src/server/estate/error-page.js";
import { overviewErrorBody } from "../src/server/routes/overview.js";
import { EstateBundleError } from "../src/shared/errors.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";

/** A minimal compiled route request for a direct handler call (the handler ignores it). */
function routeReq(path: string): RouteRequest {
  return {
    request: new Request(`http://web:8080${path}`, { method: "GET" }),
    params: {},
    routePattern: path,
    peerIp: null,
    disableTimeout() {},
  };
}

describe("rollup()", () => {
  test("suppressed services contribute nothing to the roll-up", () => {
    // An ok host with only suppressed services stays ok (suppressed is filtered out).
    expect(rollup("ok", ["suppressed"])).toBe("ok");
    expect(rollup("ok", ["suppressed", "suppressed"])).toBe("ok");
    // A suppressed service never worsens a cell, even beside a critical own status.
    expect(rollup("critical", ["suppressed"])).toBe("critical");
    // A suppressed service never *improves* a cell either — a warning service still shows.
    expect(rollup("ok", ["suppressed", "warning"])).toBe("warning");
  });

  test("unknown propagates (monitoring gaps stay visible)", () => {
    expect(rollup("unknown", [])).toBe("unknown");
    expect(rollup("ok", ["unknown"])).toBe("unknown");
    // unknown outranks ok but yields to warning/critical (ROLLUP_ORDER).
    expect(rollup("unknown", ["warning"])).toBe("warning");
    expect(rollup("unknown", ["critical"])).toBe("critical");
  });

  test("folds to the worst contributing status under ROLLUP_ORDER", () => {
    expect(rollup("ok", ["ok", "warning", "critical"])).toBe("critical");
    expect(rollup("warning", ["unknown", "ok"])).toBe("warning");
    expect(rollup("ok", ["ok", "ok"])).toBe("ok");
  });

  test("an entirely-suppressed cell is itself suppressed", () => {
    expect(rollup("suppressed", [])).toBe("suppressed");
    expect(rollup("suppressed", ["suppressed", "suppressed"])).toBe("suppressed");
  });
});

// ── bundle-error-mode servability + structured safe status (06 §§5.1, 5.2; §8.9) ──────────────────

function upHealth(): SourceHealth {
  return { ok: true, lastSuccess: "2026-09-10T00:00:00.000Z", error: null };
}

function errorStatus(error: EstateBundleError): RuntimeStatus {
  return {
    sources: { metrics: upHealth(), alerts: upHealth(), checks: upHealth() },
    model: { loaded: false, formatVersion: error.foundVersion, error },
    lastSnapshotAt: null,
  };
}

describe("bundle-error-mode status is servable and structured", () => {
  test("/healthz stays 200 and reports the widened bundle error safely", async () => {
    const err = new EstateBundleError(
      "incoherent",
      "coverage",
      "/rendered/web-coverage.json",
      "coverage relationships disagree with the model; re-run 'pulse render'",
      { field: "covered[0].artifacts" },
    );
    setRuntimeStatus(errorStatus(err));

    const res = await Promise.resolve(healthzRoute.handler(routeReq("/healthz"), {} as ServerContext));
    expect(res.status).toBe(200); // process stays servable in error mode
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.estateModel.loaded).toBe(false);
    expect(body.estateModel.error).toBe(err.message); // safe message, no raw field value echoed
  });

  test("/metrics exposes estate_model_loaded 0 in error mode", () => {
    const err = new EstateBundleError("missing", "model", "/rendered/web-estate-model.json", "not found");
    const text = renderMetrics(errorStatus(err), Date.now());
    expect(text).toContain("pulse_web_estate_model_loaded 0");
  });

  test("overviewErrorBody + renderErrorPage project the bundle error for the 503/HTML surfaces", () => {
    const err = new EstateBundleError("version", "model", "/rendered/web-estate-model.json", "unsupported formatVersion 1", {
      foundVersion: 1,
    });
    const body = overviewErrorBody(err);
    expect(body).toEqual({
      code: "ESTATE_BUNDLE_VERSION",
      kind: "version",
      path: "/rendered/web-estate-model.json",
      message: err.message,
    });
    const html = renderErrorPage(err);
    expect(html).toContain("/rendered/web-estate-model.json");
    expect(html).toContain("version");
  });
});

describe("ordering constants", () => {
  test("ROLLUP_ORDER ranks ok < unknown < warning < critical and omits suppressed", () => {
    expect(ROLLUP_ORDER).toEqual(["ok", "unknown", "warning", "critical"]);
    expect(ROLLUP_ORDER).not.toContain("suppressed" as TargetStatus);
  });

  test("SEVERITY_ORDER ranks info < warning < critical", () => {
    expect(SEVERITY_ORDER).toEqual(["info", "warning", "critical"]);
  });
});
