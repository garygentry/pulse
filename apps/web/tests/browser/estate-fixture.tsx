// apps/web/tests/browser/estate-fixture.tsx — the estate browser-suite fixture (estate-explorer
// item 014, 09 §7.1).
//
// Modeled on fixture.tsx: seeds a real createAppStore(), mirrors the router into store.route, and
// renders the real App → Shell → estate view. store.estate is seeded from the REFERENCE estate's
// rendered artifacts (examples/reference/rendered/web-*.json) wrapped in the wire envelope by
// makeEstatePayloadFixture. The reference tree ships zero findings, so the factory's findings (one
// per severity) are overlaid to give the findings tab real rows under axe; live rows span every
// health state so the grayscale suite scans more than one [data-status].
//
// `?estate=large` swaps the reference model for a generated one (LARGE_HOSTS hosts × LARGE_SERVICES
// services, invented names cloned from the first reference host and service) so the inventory tree
// crosses the TreeView virtualization threshold once its hosts are expanded.
//
// The route to mount comes from `?route=` on the fixture URL (default `/estate`) — serveDir only
// serves index.html at `/`, so the fixture rewrites the location with replaceState BEFORE the router
// reads it. The `<html>` theme stamp (`.dark` class) seeds store.theme before first render (as fixture.tsx does).

import { createElement } from "react";
import { render } from "../react-render.js";

import "../../src/client/styles/app.css";

import type { WebCoverageArtifact, WebEstateModelV2, WebFindingsArtifact } from "@pulse/renderer";
import type { EstateTargetState, HealthState } from "@pulse/web-data/wire";

import { App } from "../../src/client/app.js";
import { createAppStore } from "../../src/client/store/index.js";
import { createPathRouter, routesFromViews } from "../../src/client/router.js";
import { VIEWS } from "../../src/client/views/registry.js";
import { makeEstateBundleFixture } from "../factories/estate-bundle.js";
import {
  makeComparison,
  makeEstatePayloadFixture,
  makeLiveTarget,
  presentSection,
} from "../factories/estate-payload.js";

import referenceModel from "../../../../examples/reference/rendered/web-estate-model.json" with { type: "json" };
import referenceCoverage from "../../../../examples/reference/rendered/web-coverage.json" with { type: "json" };
import referenceFindings from "../../../../examples/reference/rendered/web-findings.json" with { type: "json" };

const root = document.getElementById("app");
if (root === null) throw new Error("[estate-fixture] #app mount node missing");

// Mount at the requested estate route before the router reads window.location.
const fixtureParams = new URLSearchParams(window.location.search);
const route = fixtureParams.get("route") ?? "/estate";
window.history.replaceState(null, "", route);

const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");

const LARGE_HOSTS = 50;
const LARGE_SERVICES = 20;

/** The reference model, or with `?estate=large` a generated one of LARGE_HOSTS × LARGE_SERVICES. */
function estateModel(): WebEstateModelV2 {
  const reference = referenceModel as unknown as WebEstateModelV2;
  if (fixtureParams.get("estate") !== "large") return reference;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const [baseHost, baseService] = [reference.hosts[0]!, reference.services[0]!];
  const hosts = Array.from({ length: LARGE_HOSTS }, (_, h) => {
    const name = `rack-${pad(h)}`;
    return { ...baseHost, name, drilldownId: `host:${name}` };
  });
  const services = hosts.flatMap((host) =>
    Array.from({ length: LARGE_SERVICES }, (_, s) => {
      const name = `svc-${pad(s)}`;
      return { ...baseService, host: host.name, name, drilldownId: `svc:${host.name}/${name}` };
    }),
  );
  return { ...reference, hosts, services };
}

const estate = estateModel();
const coverage = referenceCoverage as unknown as WebCoverageArtifact;
const findings: WebFindingsArtifact = {
  ...(referenceFindings as unknown as WebFindingsArtifact),
  findings: makeEstateBundleFixture().findings.findings,
};

// Cycle live health across the reference hosts so several TargetStatus values render.
const HEALTH_CYCLE: readonly HealthState[] = ["healthy", "unhealthy", "unknown", "not-configured"];
const liveTargets: EstateTargetState[] = estate.hosts.map((host, i) =>
  makeLiveTarget({
    target: { kind: "host", id: host.drilldownId },
    name: host.name,
    state: HEALTH_CYCLE[i % HEALTH_CYCLE.length]!,
    alertFingerprints: i === 1 ? ["fp-browser-fixture-1"] : [],
  }),
);

const firstHost = estate.hosts[0];
const payload = makeEstatePayloadFixture({
  estate,
  liveTargets,
  coverage: presentSection(coverage),
  findings: presentSection(findings),
  declaredVersusScraped: presentSection([
    makeComparison({
      drilldownId: firstHost?.drilldownId ?? "host:unknown",
      scrapeTarget: null,
      state: "missing",
      message: "declared but not scraped",
    }),
  ]),
});

const store = createAppStore();
if (stampedTheme === "dark" || stampedTheme === "light") {
  store.theme.value = stampedTheme;
}
store.estate.value = payload;

const router = createPathRouter({ routes: routesFromViews(VIEWS), fallback: "/overview" });
// Mirror main.tsx: the router is the only writer of store.route (REQ-STORE-05).
store.route.value = router.current();
router.subscribe((match) => {
  store.route.value = match;
});

render(createElement(App, { store, router, views: VIEWS, reloadOnce: () => {}, buildId: null }), root);
