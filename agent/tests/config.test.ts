// agent/tests/config.test.ts
//
// Focused coverage for the prober config loader and credential resolver (item 009):
//   - config absence / unreadable / malformed / wrong-shape (§3.1)
//   - strict `kind: "deep-health"` filtering (REQ-PROBE-06, §3.2)
//   - `svc:<host>/<service>` name parsing + non-empty responseMapping validation (§3.3)
//   - `${ENV}` credential resolution from an injected env map, and fail-visible /
//     non-leaking behaviour for missing or unsupported references (§5, REQ-SEC-01)
//
// Importing config.ts / credential.ts here also pulls them into the agent/tests tsconfig
// program so `tsc -b` typechecks them (01-architecture-layout.md §3.1).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as toYaml } from "yaml";

import {
  filterDeepHealth,
  loadProberConfig,
  loadRuntimeOptions,
  narrowDeepHealth,
  parseProbeName,
} from "../prober/src/config.js";
import { resolveBearer } from "../prober/src/credential.js";
import { ProbeExecutionError, ProberConfigError } from "../prober/src/errors.js";
import type { ProberEntry } from "../contract/types.js";
import {
  DEFAULT_PROBE_CADENCE_MS,
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_TIMEOUT_MS,
} from "../contract/constants.js";

// ── temp-file scaffolding ─────────────────────────────────────────────────────────────

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prober-cfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write `content` to `<dir>/config.yaml` and return its path. */
async function writeConfig(content: string): Promise<string> {
  const path = join(dir, "config.yaml");
  await writeFile(path, content, "utf8");
  return path;
}

const deepHealthEntry: ProberEntry = {
  name: "svc:web01/frigate",
  target: "http://web01:5000/api/health",
  kind: "deep-health",
  responseMapping: { camera_count: "$.cameras.recording" },
  alertExpression: "camera_count < 6",
};

// ── load: three states ────────────────────────────────────────────────────────────────

describe("loadProberConfig — load states", () => {
  test("ABSENT file (ENOENT) resolves to an empty probe list", async () => {
    const probes = await loadProberConfig(join(dir, "does-not-exist.yaml"));
    expect(probes).toEqual([]);
  });

  test("unreadable file (path is a directory) throws ProberConfigError", async () => {
    // Reading a directory as a file fails with EISDIR — not ENOENT — so it is fatal.
    await expect(loadProberConfig(dir)).rejects.toBeInstanceOf(ProberConfigError);
  });

  test("malformed YAML throws ProberConfigError", async () => {
    const path = await writeConfig("probes: [ this: is: not: valid");
    await expect(loadProberConfig(path)).rejects.toBeInstanceOf(ProberConfigError);
  });

  test("wrong top-level shape (not { probes: [] }) throws ProberConfigError", async () => {
    const path = await writeConfig(toYaml({ notProbes: 1 }));
    await expect(loadProberConfig(path)).rejects.toBeInstanceOf(ProberConfigError);

    const path2 = await writeConfig(toYaml({ probes: "nope" }));
    await expect(loadProberConfig(path2)).rejects.toBeInstanceOf(ProberConfigError);

    const path3 = await writeConfig(toYaml(["array", "top", "level"]));
    await expect(loadProberConfig(path3)).rejects.toBeInstanceOf(ProberConfigError);
  });

  test("a well-formed config loads and narrows its deep-health entries", async () => {
    const path = await writeConfig(toYaml({ probes: [deepHealthEntry] }));
    const probes = await loadProberConfig(path);
    expect(probes).toEqual([
      {
        host: "web01",
        service: "frigate",
        target: "http://web01:5000/api/health",
        metrics: { camera_count: "$.cameras.recording" },
        alertExpression: "camera_count < 6",
      },
    ]);
  });

  test("an empty probe array loads to an empty list (well-formed non-event)", async () => {
    const path = await writeConfig(toYaml({ probes: [] }));
    expect(await loadProberConfig(path)).toEqual([]);
  });
});

// ── filter: only deep-health survives ─────────────────────────────────────────────────

describe("filterDeepHealth — strict kind filtering (REQ-PROBE-06)", () => {
  test("only deep-health entries survive; other kinds are ignored", () => {
    const doc = {
      probes: [
        deepHealthEntry,
        { name: "svc:web01/postgres#backup", target: "s3://b", kind: "backup-freshness", threshold: "24h" },
        { name: "host:web01", target: "10.0.0.4", kind: "icmp", note: "ping" },
        { name: "svc:app02/api", target: "http://app02:8080/health", kind: "deep-health", responseMapping: { ok: "$.ok" } },
      ],
    };
    const probes = filterDeepHealth(doc, "test.yaml");
    expect(probes.map((p) => `${p.host}/${p.service}`)).toEqual(["web01/frigate", "app02/api"]);
  });

  test("a config with zero deep-health entries filters to an empty list", () => {
    const doc = {
      probes: [{ name: "host:web01", target: "10.0.0.4", kind: "icmp", note: "ping" }],
    };
    expect(filterDeepHealth(doc, "test.yaml")).toEqual([]);
  });
});

// ── narrow: name parsing + mapping validation ─────────────────────────────────────────

describe("narrowDeepHealth — exact narrowed fields", () => {
  test("produces exact host/service/target/metrics from a valid entry", () => {
    const narrowed = narrowDeepHealth(deepHealthEntry, "test.yaml");
    expect(narrowed).toEqual({
      host: "web01",
      service: "frigate",
      target: "http://web01:5000/api/health",
      metrics: { camera_count: "$.cameras.recording" },
      alertExpression: "camera_count < 6",
    });
  });

  test("carries credential opaquely when present, and omits it when absent", () => {
    const withCred = narrowDeepHealth({ ...deepHealthEntry, credential: "${NVR_TOKEN}" }, "test.yaml");
    expect(withCred.credential).toBe("${NVR_TOKEN}");

    const withoutCred = narrowDeepHealth(deepHealthEntry, "test.yaml");
    expect("credential" in withoutCred).toBe(false);
  });

  test("omits alertExpression when the entry has none", () => {
    const { alertExpression, ...rest } = deepHealthEntry;
    void alertExpression;
    const narrowed = narrowDeepHealth(rest as ProberEntry, "test.yaml");
    expect("alertExpression" in narrowed).toBe(false);
  });

  test("a malformed name throws ProberConfigError", () => {
    for (const name of ["host:web01", "svc:web01", "svc:/frigate", "svc:web01/", "frigate", ""]) {
      expect(() => narrowDeepHealth({ ...deepHealthEntry, name }, "test.yaml")).toThrow(ProberConfigError);
    }
  });

  test("a missing or empty responseMapping throws ProberConfigError", () => {
    const { responseMapping, ...noMapping } = deepHealthEntry;
    void responseMapping;
    expect(() => narrowDeepHealth(noMapping as ProberEntry, "test.yaml")).toThrow(ProberConfigError);
    expect(() => narrowDeepHealth({ ...deepHealthEntry, responseMapping: {} }, "test.yaml")).toThrow(
      ProberConfigError,
    );
  });

  test("rejects malformed nested deep-health fields with ProberConfigError", () => {
    const invalid = [
      { ...deepHealthEntry, target: undefined },
      { ...deepHealthEntry, target: 42 },
      { ...deepHealthEntry, responseMapping: null },
      { ...deepHealthEntry, responseMapping: { count: 42 } },
      { ...deepHealthEntry, responseMapping: { count: "" } },
      { ...deepHealthEntry, alertExpression: 42 },
      { ...deepHealthEntry, credential: {} },
    ];
    for (const entry of invalid) {
      expect(() => narrowDeepHealth(entry, "test.yaml")).toThrow(ProberConfigError);
    }
  });
});

// ── process-level tuning ──────────────────────────────────────────────────────────────

describe("loadRuntimeOptions", () => {
  test("uses bounded defaults when no overrides are set", () => {
    expect(loadRuntimeOptions({})).toEqual({
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      cadenceMs: DEFAULT_PROBE_CADENCE_MS,
      concurrency: DEFAULT_PROBE_CONCURRENCY,
    });
  });

  test("loads positive integer timeout, cadence, and concurrency overrides", () => {
    expect(loadRuntimeOptions({
      PULSE_PROBE_TIMEOUT_MS: "2500",
      PULSE_PROBE_CADENCE_MS: "15000",
      PULSE_PROBE_CONCURRENCY: "4",
    })).toEqual({ timeoutMs: 2500, cadenceMs: 15000, concurrency: 4 });
  });

  test("rejects invalid runtime overrides as startup configuration errors", () => {
    for (const [name, value] of [
      ["PULSE_PROBE_TIMEOUT_MS", "0"],
      ["PULSE_PROBE_CADENCE_MS", "-1"],
      ["PULSE_PROBE_CONCURRENCY", "1.5"],
      ["PULSE_PROBE_TIMEOUT_MS", "nope"],
    ] as const) {
      expect(() => loadRuntimeOptions({ [name]: value })).toThrow(ProberConfigError);
    }
  });
});

describe("parseProbeName", () => {
  test("parses the svc:<host>/<service> form", () => {
    expect(parseProbeName("svc:web01/frigate")).toEqual({ host: "web01", service: "frigate" });
    // The service segment may itself contain a slash (only the first `/` splits).
    expect(parseProbeName("svc:web01/frigate/sub")).toEqual({ host: "web01", service: "frigate/sub" });
  });

  test("rejects non-svc forms and empty segments", () => {
    for (const name of ["host:web01", "svc:web01", "svc:/frigate", "svc:web01/", "svc:", "web01/frigate", ""]) {
      expect(parseProbeName(name)).toBeNull();
    }
  });
});

// ── credential resolution ─────────────────────────────────────────────────────────────

describe("resolveBearer — ${ENV} resolution and non-leakage (§5, REQ-SEC-01)", () => {
  const TOKEN = "s3cr3t-token-value";

  test("undefined credential resolves to undefined (unauthenticated probe)", () => {
    expect(resolveBearer(undefined, { NVR_TOKEN: TOKEN })).toBeUndefined();
  });

  test("${ENV} resolves from the supplied env map", () => {
    expect(resolveBearer("${NVR_TOKEN}", { NVR_TOKEN: TOKEN })).toBe(TOKEN);
  });

  test("a missing env var fails visibly without exposing a value", () => {
    let thrown: unknown;
    try {
      resolveBearer("${NVR_TOKEN}", {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProbeExecutionError);
    expect((thrown as ProbeExecutionError).reason).toBe("unreachable");
    // Names the var, never a value.
    expect((thrown as ProbeExecutionError).message).toContain("NVR_TOKEN");
  });

  test("an empty env var value fails visibly (treated as unset)", () => {
    expect(() => resolveBearer("${NVR_TOKEN}", { NVR_TOKEN: "" })).toThrow(ProbeExecutionError);
  });

  test("an unsupported reference form (op://) fails visibly", () => {
    let thrown: unknown;
    try {
      resolveBearer("op://vault/nvr/token", { NVR_TOKEN: TOKEN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProbeExecutionError);
    expect((thrown as ProbeExecutionError).reason).toBe("unreachable");
    // The raw reference (which could carry sensitive path info) is not echoed.
    expect((thrown as ProbeExecutionError).message).not.toContain("op://");
  });

  test("no resolved token value ever appears in an error message", () => {
    // Even when the env var IS set but the reference form is unsupported, the token stays hidden.
    let thrown: unknown;
    try {
      resolveBearer("not-a-reference", { SOME_VAR: TOKEN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProbeExecutionError);
    expect((thrown as ProbeExecutionError).message).not.toContain(TOKEN);
  });
});
