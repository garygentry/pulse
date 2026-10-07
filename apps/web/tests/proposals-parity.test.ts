/** proposals-parity.test.ts — the web current-value reader (server/mutations/estate-values.ts, 07 §6.2)
 *  deep-equals the core reader `readCoreValue` (07 §6.1) for every host/service × proposable field of
 *  one validated fixture estate, compared against the PUBLIC renderer projection of that same estate
 *  (07 §6.3, 10 §3.4, REQ-PROP-08). The fixture lives with the core fixtures (10 §4). */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadAndValidate, type EstateModel } from "@pulse/core";
import { PROPOSABLE_FIELD_NAMES, readCoreValue } from "@pulse/core/proposals";
import { buildWebEstateModel, type WebEstateModelV2 } from "@pulse/renderer";

import { readProposableValue, resolveTarget } from "../src/server/mutations/estate-values.js";

const FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/proposals-parity");

function loadFixture(): { core: EstateModel; v2: WebEstateModelV2 } {
  const loaded = loadAndValidate(FIXTURE);
  if (!loaded.ok) throw new Error(`fixture failed to load: ${JSON.stringify(loaded.findings)}`);
  const web = buildWebEstateModel(loaded.model);
  if (!web.ok) throw new Error("fixture tripped web safety; simplify it");
  return { core: loaded.model, v2: web.value };
}

const { core, v2 } = loadFixture();

function webValue(kind: "host" | "service", id: string, field: (typeof PROPOSABLE_FIELD_NAMES)[number]) {
  const resolved = resolveTarget(v2, kind, id);
  if (resolved === null) throw new Error(`unresolved ${kind} ${id}`);
  return readProposableValue(v2, resolved, field);
}

describe("proposals parity: readCoreValue ≡ readProposableValue (REQ-PROP-08, 07 §6.3)", () => {
  test("the fixture loads clean with no error findings", () => {
    const loaded = loadAndValidate(FIXTURE);
    expect(loaded.ok).toBe(true);
    expect(loaded.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(core.hosts.length).toBeGreaterThanOrEqual(4);
    expect(core.services.length).toBeGreaterThanOrEqual(3);
  });

  test("every host × field agrees on applicable flag and value", () => {
    let compared = 0;
    for (const host of core.hosts) {
      for (const field of PROPOSABLE_FIELD_NAMES) {
        expect({ host: host.name, field, v: webValue("host", `host:${host.name}`, field) }).toEqual({
          host: host.name,
          field,
          v: readCoreValue(host, field, core.suppressions),
        });
        compared++;
      }
    }
    expect(compared).toBe(core.hosts.length * PROPOSABLE_FIELD_NAMES.length);
  });

  test("every service × field agrees on applicable flag and value", () => {
    let compared = 0;
    for (const svc of core.services) {
      const id = `svc:${svc.host}/${svc.name}`;
      for (const field of PROPOSABLE_FIELD_NAMES) {
        expect({ id, field, v: webValue("service", id, field) }).toEqual({
          id,
          field,
          v: readCoreValue(svc, field, core.suppressions),
        });
        compared++;
      }
    }
    expect(compared).toBe(core.services.length * PROPOSABLE_FIELD_NAMES.length);
  });

  test("a service covered only by a standalone suppression is not applicable for 'suppressed' on both sides", () => {
    const cache = core.services.find((s) => s.host === "db-01" && s.name === "cache")!;
    expect(cache.suppressed).toBeUndefined();
    expect(core.suppressions.some((s) => s.target === "db-01/cache")).toBe(true);
    expect(readCoreValue(cache, "suppressed", core.suppressions)).toEqual({ applicable: false });
    expect(webValue("service", "svc:db-01/cache", "suppressed")).toEqual({ applicable: false });
  });

  test("service in-target mark and unsuppressed service read the mark / null", () => {
    expect(webValue("service", "svc:app-01/batch", "suppressed")).toEqual({
      applicable: true,
      value: { class: "known-expected", rationale: "Batch worker idles between nightly runs by design." },
    });
    expect(webValue("service", "svc:app-01/api", "suppressed")).toEqual({ applicable: true, value: null });
    expect(webValue("service", "svc:app-01/api", "cadvisor")).toEqual({ applicable: false });
  });

  test("a managed-linux host omitting cadvisor/heartbeat reads the defaults false / true", () => {
    const app = core.hosts.find((h) => h.name === "app-01")!;
    for (const [field, value] of [["cadvisor", false], ["heartbeat", true]] as const) {
      expect(readCoreValue(app, field, core.suppressions)).toEqual({ applicable: true, value });
      expect(webValue("host", "host:app-01", field)).toEqual({ applicable: true, value });
    }
    expect(webValue("host", "host:db-01", "cadvisor")).toEqual({ applicable: true, value: true });
    expect(webValue("host", "host:db-01", "heartbeat")).toEqual({ applicable: true, value: false });
  });

  test("scrapeIntervalClass is null when omitted and the class when declared; expectedChurn defaults false", () => {
    const app = core.hosts.find((h) => h.name === "app-01")!;
    expect(readCoreValue(app, "scrapeIntervalClass")).toEqual({ applicable: true, value: null });
    expect(webValue("host", "host:app-01", "scrapeIntervalClass")).toEqual({ applicable: true, value: null });
    expect(webValue("host", "host:db-01", "scrapeIntervalClass")).toEqual({ applicable: true, value: "fast" });
    expect(webValue("host", "host:app-01", "expectedChurn")).toEqual({ applicable: true, value: false });
    expect(webValue("host", "host:db-01", "expectedChurn")).toEqual({ applicable: true, value: true });
  });

  test("probe-only and excluded hosts: class-gated fields are not applicable; excluded reads its mark", () => {
    for (const field of ["cadvisor", "heartbeat", "suppressed"] as const) {
      expect(webValue("host", "host:edge-probe", field)).toEqual({ applicable: false });
    }
    expect(webValue("host", "host:old-nas", "suppressed")).toEqual({
      applicable: true,
      value: { class: "excluded", rationale: "Retired storage box kept in inventory for reference." },
    });
    expect(webValue("host", "host:old-nas", "cadvisor")).toEqual({ applicable: false });
  });

  test("resolveTarget returns null for an unknown id or the wrong kind, and the core name otherwise", () => {
    expect(resolveTarget(v2, "host", "host:nope")).toBeNull();
    expect(resolveTarget(v2, "service", "svc:app-01/nope")).toBeNull();
    expect(resolveTarget(v2, "service", "host:app-01")).toBeNull();
    expect(resolveTarget(v2, "host", "svc:app-01/api")).toBeNull();
    expect(resolveTarget(v2, "host", "app-01")).toBeNull();
    expect(resolveTarget(v2, "service", "svc:app-01/api")).toMatchObject({ kind: "service", name: "api" });
    expect(resolveTarget(v2, "host", "host:db-01")).toMatchObject({ kind: "host", name: "db-01" });
  });
});
