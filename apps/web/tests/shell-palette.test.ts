// apps/web/tests/shell-palette.test.ts — the command palette's pure index and matcher (07 §3.1):
// buildIndex null-safety and matchEntries ranking/cap. The palette component's keyboard flow is in
// shell-shell.test.tsx.

import { expect, test } from "bun:test";

import type { OverviewSnapshot } from "../src/shared/snapshot.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import {
  buildIndex,
  firingAlertRows,
  matchEntries,
  MAX_RESULTS,
  type PaletteEntry,
} from "../src/client/shell/command-index.js";

function makeStore(): AppStore {
  return createAppStore({ storage: null, initialQuery: {} });
}

/** A minimal two-host snapshot; only the fields buildIndex reads are populated (cast for the rest). */
function snapshotWithHosts(): OverviewSnapshot {
  return {
    hosts: [
      {
        name: "web-01",
        rollup: "critical",
        services: [
          { name: "api", host: "web-01" },
          { name: "cache", host: "web-01" },
        ],
      },
      {
        name: "db-01",
        rollup: "ok",
        services: [{ name: "postgres", host: "db-01" }],
      },
    ],
  } as unknown as OverviewSnapshot;
}

// ─── buildIndex null-safety (REQ-ROBUST-01, REQ-CMD-01) ────────────────────────────────────────────

test("buildIndex with a null snapshot returns view entries only", () => {
  const store = makeStore(); // snapshot & alerts default to null
  const index = buildIndex(store);
  expect(index.length).toBeGreaterThan(0);
  expect(index.every((e) => e.kind === "view")).toBe(true);
  // First entry is the overview view at /overview (registry order).
  expect(index[0]).toMatchObject({ kind: "view", id: "overview", navPath: "/overview" });
});

test("buildIndex with a snapshot but null alerts returns views + hosts + services and NO alerts", () => {
  const store = makeStore();
  store.snapshot.value = snapshotWithHosts();
  const index = buildIndex(store);

  expect(index.some((e) => e.kind === "alert")).toBe(false);

  const host = index.find((e) => e.kind === "host" && e.id === "web-01");
  expect(host).toBeDefined();
  expect(host!.sublabel).toBeTruthy(); // STATUS_LABEL[rollup], always defined

  // Service entries carry host in sublabel and an id of "<host>/<name>".
  const service = index.find((e) => e.kind === "service" && e.label === "api");
  expect(service).toMatchObject({
    kind: "service",
    id: "web-01/api",
    sublabel: "web-01",
  });
  expect(service!.navPath).toBe("/estate/service/web-01/api");
});

test("firingAlertRows never throws and degrades to [] on absent/mis-shaped payloads", () => {
  expect(firingAlertRows(null)).toEqual([]);
  expect(firingAlertRows({})).toEqual([]);
  expect(firingAlertRows("nope")).toEqual([]);
  expect(firingAlertRows({ alerts: "nope" })).toEqual([]);
  expect(firingAlertRows({ alerts: [42, null, "x"] })).toEqual([]);
  expect(firingAlertRows({ alerts: [{ fingerprint: 1, name: "n", state: "firing" }] })).toEqual([]); // non-string fp
  expect(firingAlertRows({ alerts: [{ fingerprint: "a", name: "Alert A", state: "resolved" }] })).toEqual([]);
  expect(firingAlertRows({ alerts: [{ fingerprint: "a", name: "Alert A", state: "firing", target: null }] })).toEqual([
    { id: "a", label: "Alert A" },
  ]);
  expect(
    firingAlertRows({
      alerts: [{ fingerprint: "a", name: "Alert A", state: "silenced", target: { kind: "host", id: "host:web-01" } }],
    }),
  ).toEqual([{ id: "a", label: "Alert A", sublabel: "host:web-01" }]);
});

// ─── matchEntries ranking + cap (REQ-CMD-02, REQ-SCALE-01) ─────────────────────────────────────────

function entry(kind: PaletteEntry["kind"], label: string, sublabel?: string): PaletteEntry {
  return {
    kind,
    id: `${kind}:${label}`,
    label,
    ...(sublabel !== undefined ? { sublabel } : {}),
    navPath: `/${label}`,
  };
}

test("matchEntries ranks exact > prefix > substring, then view > host > service > alert, then label", () => {
  const index: PaletteEntry[] = [
    entry("service", "webapi"),
    entry("service", "web cache"),
    entry("host", "web-01"),
    entry("view", "web"), // exact match for "web"
    entry("alert", "webhook down"),
    entry("view", "overview"), // no "web" token → dropped
  ];
  const ranked = matchEntries(index, "web").map((e) => e.label);
  // "web" (view, exact) first; then prefix matches ordered by kind then label:
  //   host web-01, service web cache, service webapi, then substring alert webhook down.
  expect(ranked).toEqual(["web", "web-01", "web cache", "webapi", "webhook down"]);
});

test("matchEntries does multi-token AND over label+sublabel and empty query returns all (ranked)", () => {
  const index: PaletteEntry[] = [
    entry("service", "api", "web-01"),
    entry("service", "api", "db-01"),
    entry("view", "overview"),
  ];
  // Both tokens must hit; "api" is in label, "web" is in sublabel → only the web-01 api.
  expect(matchEntries(index, "api web").map((e) => e.id)).toEqual(["service:api"]);
  // Empty query → everything, ranked (view first).
  expect(matchEntries(index, "").length).toBe(3);
  expect(matchEntries(index, "   ")[0]!.kind).toBe("view");
});

test("matchEntries caps at MAX_RESULTS (50)", () => {
  const index: PaletteEntry[] = [];
  for (let i = 0; i < 60; i += 1) index.push(entry("view", `view-${String(i).padStart(2, "0")}`));
  const ranked = matchEntries(index, "view");
  expect(MAX_RESULTS).toBe(50);
  expect(ranked.length).toBe(50);
});
