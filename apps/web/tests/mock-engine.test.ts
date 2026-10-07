// apps/web/tests/mock-engine.test.ts — item 014 / REQ-MOCK-02, REQ-MOCK-07, spec 05 §2.3 / §3.
//
// Covers the four contract corners of the injected fetch: (1) each MOCK_PATH prefix returns the
// correct source body, (2) an unknown path returns a 404 JSON response, (3) a source turned off
// by the timeline surfaces as `{ ok: false }` through the real `fetchJson` primitive, and (4) a
// malformed source body causes `loadScenario` to throw `MockScenarioError` with code
// `"parse-failed"`.

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadServerConfig } from "../src/server/config.js";
import {
  DEFAULT_SCENARIO,
  MOCK_BASE_URLS,
  MOCK_ENV,
  MOCK_PATHS,
  SCENARIO_NAMES,
  createMockEngine,
  listScenarios,
} from "../src/server/dev/mock-engine.js";
import {
  DEFAULT_SCENARIO_DIR,
  MockScenarioError,
  SCENARIO_FILES,
  loadScenario,
} from "../src/server/dev/scenario.js";
import { fetchJson } from "../src/server/sources/index.js";
import type { GatusStatusesResponse } from "../src/server/sources/index.js";

const FIXED_START = Date.parse("2026-01-01T00:00:00.000Z");

async function readJsonResponse(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("MOCK constants", () => {
  test("MOCK_ENV keys are the config env vars (four origins)", () => {
    expect(MOCK_ENV.PULSE_VM_URL).toBe(MOCK_BASE_URLS.vmUrl);
    expect(MOCK_ENV.PULSE_ALERTMANAGER_URL).toBe(MOCK_BASE_URLS.alertmanagerUrl);
    expect(MOCK_ENV.PULSE_GATUS_URL).toBe(MOCK_BASE_URLS.gatusUrl);
    expect(MOCK_ENV.PULSE_VMALERT_URL).toBe(MOCK_BASE_URLS.vmalertUrl);
  });

  test("SCENARIO_NAMES contains DEFAULT_SCENARIO", () => {
    expect(SCENARIO_NAMES).toContain(DEFAULT_SCENARIO);
  });

  test("SCENARIO_FILES lists the four source files plus timeline", () => {
    expect(SCENARIO_FILES).toEqual({
      vm: "vm.json",
      alertmanager: "alertmanager.json",
      gatus: "gatus.json",
      vmalert: "vmalert.json",
      timeline: "timeline.json",
    });
  });

  test("listScenarios finds every shipped scenario", async () => {
    const found = await listScenarios();
    for (const name of SCENARIO_NAMES) expect(found).toContain(name);
  });

  test("SCENARIO_NAMES ⊆ listScenarios (default dir)", async () => {
    const found = new Set(await listScenarios());
    for (const s of SCENARIO_NAMES) expect(found.has(s)).toBe(true);
  });

  test("MOCK_ENV boots loadServerConfig and exposes the four origin URLs (00 §5)", () => {
    // entry.ts merges `{ ...process.env, ...MOCK_ENV }` into loadServerConfig; that seam must
    // accept and expose PULSE_VMALERT_URL alongside the three existing origins.
    const cfg = loadServerConfig({ ...MOCK_ENV });
    expect(cfg.vmUrl).toBe(MOCK_BASE_URLS.vmUrl);
    expect(cfg.alertmanagerUrl).toBe(MOCK_BASE_URLS.alertmanagerUrl);
    expect(cfg.gatusUrl).toBe(MOCK_BASE_URLS.gatusUrl);
    expect(cfg.vmalertUrl).toBe(MOCK_BASE_URLS.vmalertUrl);
  });
});

describe("createMockEngine.fetchImpl — routing per MOCK_PATHS", () => {
  test("VM prefix returns the VM body", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.vmUrl}${MOCK_PATHS.vm}?query=up`);
    expect(res.status).toBe(200);
    const body = (await readJsonResponse(res)) as { status?: string; data?: { result?: unknown[] } };
    expect(body.status).toBe("success");
    expect(Array.isArray(body.data?.result)).toBe(true);
  });

  test("Alertmanager prefix returns the alerts body", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.alertmanagerUrl}${MOCK_PATHS.alertmanager}?active=true`);
    expect(res.status).toBe(200);
    const body = await readJsonResponse(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  test("Gatus prefix returns the checks body", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.gatusUrl}${MOCK_PATHS.gatus}`);
    expect(res.status).toBe(200);
    const body = (await readJsonResponse(res)) as GatusStatusesResponse;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("vmalert prefix returns the /api/v1/rules body", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    expect(MOCK_PATHS.vmalert).toBe("/api/v1/rules");
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.vmalertUrl}${MOCK_PATHS.vmalert}`);
    expect(res.status).toBe(200);
    const body = (await readJsonResponse(res)) as {
      status?: string;
      data?: { groups?: Array<{ name: string; rules: Array<{ name: string; state: string }> }> };
    };
    expect(body.status).toBe("success");
    const groups = body.data?.groups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    // A deadman/canary rule is visible independently of active Alertmanager alerts (00 §4.1).
    const ruleNames = groups.flatMap((g) => g.rules.map((r) => r.name));
    expect(ruleNames).toContain("DeadMansSwitch");
    // At least one active firing rule and one inactive rule are present.
    const states = new Set(groups.flatMap((g) => g.rules.map((r) => r.state)));
    expect(states.has("firing")).toBe(true);
    expect(states.has("inactive")).toBe(true);
  });

  test("every shipped scenario serves a sanitized vmalert rules fixture with a deadman rule", async () => {
    for (const name of SCENARIO_NAMES) {
      const engine = await createMockEngine({ scenario: name, now: () => FIXED_START, startedAt: FIXED_START });
      const res = await engine.fetchImpl(`${MOCK_BASE_URLS.vmalertUrl}${MOCK_PATHS.vmalert}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        data: { groups: Array<{ rules: Array<{ name: string }> }> };
      };
      const names = body.data.groups.flatMap((g) => g.rules.map((r) => r.name));
      expect(names).toContain("DeadMansSwitch");
      // Sanitized: no credentials, authorization headers, or secret markers.
      expect(text.toLowerCase()).not.toContain("password");
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(text).not.toContain("secret");
    }
  });
});

describe("createMockEngine.fetchImpl — unknown paths → 404", () => {
  test("Unknown origin returns a 404 JSON response", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl("http://elsewhere.example/api/v1/query");
    expect(res.status).toBe(404);
    expect(await readJsonResponse(res)).toEqual({ error: "not found" });
  });

  test("Known origin + unknown path returns 404", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.vmUrl}/api/v1/series`);
    expect(res.status).toBe(404);
  });

  test("vmalert origin + unknown path returns 404 (no network fallthrough)", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.vmalertUrl}/api/v1/alerts`);
    expect(res.status).toBe(404);
    expect(await readJsonResponse(res)).toEqual({ error: "not found" });
  });

  test("Malformed / relative URL returns 404 (never throws)", async () => {
    const engine = await createMockEngine({ scenario: "all-green", now: () => FIXED_START, startedAt: FIXED_START });
    const res = await engine.fetchImpl("not a url");
    expect(res.status).toBe(404);
  });
});

describe("createMockEngine.fetchImpl — outage folds to { ok: false } via fetchJson", () => {
  test("source-outage: gatus fetch resolves { ok: false }", async () => {
    // Advance past the atMs:0 outage-begin step.
    const engine = await createMockEngine({
      scenario: "source-outage",
      now: () => FIXED_START + 1_000,
      startedAt: FIXED_START,
    });
    const res = await fetchJson(`${MOCK_BASE_URLS.gatusUrl}${MOCK_PATHS.gatus}`, engine.fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fetch failed: mock outage");
  });

  test("source-outage: unaffected sources still succeed", async () => {
    const engine = await createMockEngine({
      scenario: "source-outage",
      now: () => FIXED_START + 1_000,
      startedAt: FIXED_START,
    });
    const vm = await fetchJson(`${MOCK_BASE_URLS.vmUrl}${MOCK_PATHS.vm}?query=up`, engine.fetchImpl);
    expect(vm.ok).toBe(true);
    const am = await fetchJson(
      `${MOCK_BASE_URLS.alertmanagerUrl}${MOCK_PATHS.alertmanager}?active=true`,
      engine.fetchImpl,
    );
    expect(am.ok).toBe(true);
  });

  test("vmalert can be selected as an outage source (00 §4.2 widened vocabulary)", async () => {
    // §4.2 widens the outage vocabulary so vmalert may be a source failure without changing how
    // VM/Alertmanager/Gatus outages are represented. Build a temp scenario that outages vmalert.
    const tmpDir = resolve(DEFAULT_SCENARIO_DIR, `.tmp-vmalert-outage-${process.pid}`);
    const scenarioDir = resolve(tmpDir, "vmalert-outage");
    const greenDir = resolve(DEFAULT_SCENARIO_DIR, "all-green");
    try {
      await mkdir(scenarioDir, { recursive: true });
      for (const f of ["vm.json", "alertmanager.json", "gatus.json", "vmalert.json"]) {
        await copyFile(resolve(greenDir, f), resolve(scenarioDir, f));
      }
      await writeFile(
        resolve(scenarioDir, "timeline.json"),
        JSON.stringify({ steps: [{ atMs: 0, step: { op: "outage-begin", source: "vmalert" } }] }),
        "utf8",
      );
      const engine = await createMockEngine({
        scenario: "vmalert-outage",
        fixturesDir: tmpDir,
        now: () => FIXED_START + 1_000,
        startedAt: FIXED_START,
      });
      expect(engine.state().outages.has("vmalert")).toBe(true);

      const vmalert = await fetchJson(
        `${MOCK_BASE_URLS.vmalertUrl}${MOCK_PATHS.vmalert}`,
        engine.fetchImpl,
      );
      expect(vmalert.ok).toBe(false);
      if (!vmalert.ok) expect(vmalert.error).toContain("fetch failed: mock outage");

      // The other three origins are unaffected by a vmalert outage.
      const vm = await fetchJson(`${MOCK_BASE_URLS.vmUrl}${MOCK_PATHS.vm}?query=up`, engine.fetchImpl);
      expect(vm.ok).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("loadScenario — MOCK_SCENARIO_INVALID on malformed JSON", () => {
  test("malformed vm.json throws MockScenarioError with code 'MOCK_SCENARIO_INVALID'", async () => {
    const tmpDir = resolve(DEFAULT_SCENARIO_DIR, `.tmp-parse-fail-${process.pid}`);
    const scenarioDir = resolve(tmpDir, "broken");
    try {
      await mkdir(scenarioDir, { recursive: true });
      await writeFile(resolve(scenarioDir, "vm.json"), "{ this is not JSON", "utf8");
      await writeFile(resolve(scenarioDir, "alertmanager.json"), "[]", "utf8");
      await writeFile(resolve(scenarioDir, "gatus.json"), "[]", "utf8");
      let caught: unknown = null;
      try {
        await loadScenario(tmpDir, "broken");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockScenarioError);
      const err = caught as MockScenarioError;
      expect(err.code).toBe("MOCK_SCENARIO_INVALID");
      expect(err.file).toBe("vm.json");
      expect(err.scenario).toBe("broken");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a structurally invalid vmalert.json is rejected by the fixture validator (00 §4.1)", async () => {
    // vmalert has no production parser (item 015); scenario.ts validates the /api/v1/rules envelope
    // shape locally. A well-formed JSON that violates the envelope must still fail the load.
    const tmpDir = resolve(DEFAULT_SCENARIO_DIR, `.tmp-vmalert-invalid-${process.pid}`);
    const scenarioDir = resolve(tmpDir, "broken-vmalert");
    const greenDir = resolve(DEFAULT_SCENARIO_DIR, "all-green");
    try {
      await mkdir(scenarioDir, { recursive: true });
      // Reuse the real sanitized vm/am/gatus fixtures so validation reaches the vmalert body.
      for (const f of ["vm.json", "alertmanager.json", "gatus.json"]) {
        await copyFile(resolve(greenDir, f), resolve(scenarioDir, f));
      }
      // Valid JSON, but "data.groups" is not an array → envelope validation must reject.
      await writeFile(resolve(scenarioDir, "vmalert.json"), '{"status":"success","data":{"groups":{}}}', "utf8");
      let caught: unknown = null;
      try {
        await loadScenario(tmpDir, "broken-vmalert");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockScenarioError);
      const err = caught as MockScenarioError;
      expect(err.code).toBe("MOCK_SCENARIO_INVALID");
      expect(err.file).toBe("vmalert.json");
      expect(err.scenario).toBe("broken-vmalert");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("unknown scenario throws MockScenarioError with code 'MOCK_SCENARIO_UNKNOWN'", async () => {
    let caught: unknown = null;
    try {
      await loadScenario(DEFAULT_SCENARIO_DIR, "no-such-scenario");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MockScenarioError);
    const err = caught as MockScenarioError;
    expect(err.code).toBe("MOCK_SCENARIO_UNKNOWN");
    // `available` includes the shipped scenarios for a helpful error message (REQ-MOCK-07).
    for (const s of SCENARIO_NAMES) expect(err.available).toContain(s);
  });
});
