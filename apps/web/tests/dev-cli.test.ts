// apps/web/tests/dev-cli.test.ts — item 016 / REQ-DEV-07, REQ-DEV-08, REQ-DEV-09, REQ-MOCK-07.
//
// parseDevArgs + buildChildEnv. Every failure string here is the verbatim one in scripts/dev.ts;
// the CLI's usage message is DEV_USAGE from 00 §2.1.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  DEV_DEFAULT_HOST,
  DEV_DEFAULT_PORT,
  DEV_HELP_SENTINEL,
  DEV_USAGE,
  buildChildEnv,
  parseDevArgs,
  resolveDevPaths,
  type DevOptions,
} from "../scripts/dev.js";
import { DEFAULT_SCENARIO, SCENARIO_NAMES } from "../src/server/dev/mock-engine.js";
import { DEV_DEFAULT_ESTATE_MODEL, DEV_ENV } from "../src/server/dev/protocol.js";
import { ENV } from "../src/shared/constants.js";

const OPTS_ENV: DevOptions = {
  mode: { kind: "env" },
  port: DEV_DEFAULT_PORT,
  host: DEV_DEFAULT_HOST,
  clock: null,
};
const OPTS_MOCK: DevOptions = { ...OPTS_ENV, mode: { kind: "mock", scenario: "degraded-mix" } };

describe("parseDevArgs — valid inputs", () => {
  test("[] → env mode with defaults", () => {
    const parsed = parseDevArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({ kind: "env" });
    expect(parsed.options.port).toBe(DEV_DEFAULT_PORT);
    expect(parsed.options.host).toBe(DEV_DEFAULT_HOST);
    expect(parsed.options.clock).toBe(null);
  });

  test("--mock (no value) → DEFAULT_SCENARIO", () => {
    const parsed = parseDevArgs(["--mock"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({ kind: "mock", scenario: DEFAULT_SCENARIO });
  });

  test("--mock degraded-mix", () => {
    const parsed = parseDevArgs(["--mock", "degraded-mix"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({ kind: "mock", scenario: "degraded-mix" });
  });

  test("--mock --port 0 does not consume --port as the scenario name", () => {
    const parsed = parseDevArgs(["--mock", "--port", "0"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({ kind: "mock", scenario: DEFAULT_SCENARIO });
    expect(parsed.options.port).toBe(0);
  });

  test("--engine <vm>,<am>,<gatus>,<vmalert> strips trailing slashes", () => {
    const parsed = parseDevArgs(["--engine", "http://a:1/,http://b:2,http://c:3//,http://d:4/"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({
      kind: "engine",
      vmUrl: "http://a:1",
      alertmanagerUrl: "http://b:2",
      gatusUrl: "http://c:3",
      vmalertUrl: "http://d:4",
    });
  });

  test("--engine accepts https origins in the fixed four-URL order", () => {
    const parsed = parseDevArgs([
      "--engine",
      "https://vm:8428,https://am:9093,https://gatus:8080,https://vmalert:8880",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({
      kind: "engine",
      vmUrl: "https://vm:8428",
      alertmanagerUrl: "https://am:9093",
      gatusUrl: "https://gatus:8080",
      vmalertUrl: "https://vmalert:8880",
    });
  });

  test("--host and --port override defaults", () => {
    const parsed = parseDevArgs(["--host", "0.0.0.0", "--port", "9090"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.host).toBe("0.0.0.0");
    expect(parsed.options.port).toBe(9090);
  });

  test("--clock accepts ISO-8601", () => {
    const parsed = parseDevArgs(["--clock", "2026-01-01T00:00:00Z"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.clock).toBe("2026-01-01T00:00:00Z");
  });
});

describe("parseDevArgs — help and error branches", () => {
  test("--help returns DEV_HELP_SENTINEL and the usage string", () => {
    const parsed = parseDevArgs(["--help"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(DEV_HELP_SENTINEL);
    expect(parsed.usage).toBe(DEV_USAGE);
  });

  test("-h returns DEV_HELP_SENTINEL", () => {
    const parsed = parseDevArgs(["-h"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(DEV_HELP_SENTINEL);
  });

  test("unknown flag → usage error", () => {
    const parsed = parseDevArgs(["--nope"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("unknown flag: --nope");
  });

  test("mock + engine mutually exclusive", () => {
    const parsed = parseDevArgs([
      "--mock",
      "--engine",
      "http://a:1,http://b:2,http://c:3,http://d:4",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("--mock and --engine are mutually exclusive");
  });

  test("--engine with three URLs is rejected (count/order diagnostic)", () => {
    const parsed = parseDevArgs(["--engine", "http://a:1,http://b:2,http://c:3"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(
      "--engine expects exactly 4 comma-separated URLs in the order " +
        "VictoriaMetrics,Alertmanager,Gatus,vmalert (got 3)",
    );
  });

  test("--engine with five URLs is rejected (count/order diagnostic)", () => {
    const parsed = parseDevArgs([
      "--engine",
      "http://a:1,http://b:2,http://c:3,http://d:4,http://e:5",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--engine expects exactly 4 comma-separated URLs");
    expect(parsed.error).toContain("(got 5)");
  });

  test("--engine with a missing value is rejected", () => {
    const parsed = parseDevArgs(["--engine"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(
      "--engine requires <vm-url>,<alertmanager-url>,<gatus-url>,<vmalert-url>",
    );
  });

  test("--engine with an empty member is rejected", () => {
    const parsed = parseDevArgs(["--engine", "http://a:1,,http://c:3,http://d:4"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("--engine contains an empty URL");
  });

  test("--engine with a relative URL is rejected", () => {
    const parsed = parseDevArgs(["--engine", "/relative,http://b:2,http://c:3,http://d:4"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("--engine URL is not an absolute URL: /relative");
  });

  test("--engine with an unsupported protocol is rejected", () => {
    const parsed = parseDevArgs([
      "--engine",
      "http://a:1,http://b:2,http://c:3,ftp://d:4",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("--engine URL must be http(s): ftp://d:4");
  });

  test("--port not an integer is rejected", () => {
    const parsed = parseDevArgs(["--port", "eight-thousand"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--port must be an integer");
  });

  test("--host with empty value is rejected", () => {
    const parsed = parseDevArgs(["--host", ""]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("--host address is empty");
  });

  test("--clock with unparseable value is rejected", () => {
    const parsed = parseDevArgs(["--clock", "not-a-date"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--clock is not a parseable timestamp");
  });

  test("unknown scenario is NOT rejected here — it fails fast in the child", () => {
    // Spec 04 §2.2: parseDevArgs does not enumerate scenarios; the child rejects unknown names
    // with MockScenarioError (item 015). Assert we accept the string as-is.
    const parsed = parseDevArgs(["--mock", "kitchen-sink"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toEqual({ kind: "mock", scenario: "kitchen-sink" });
    // Sanity: the accepted string is not a shipped scenario.
    expect((SCENARIO_NAMES as readonly string[]).includes("kitchen-sink")).toBe(false);
  });
});

describe("buildChildEnv — REQ-DEV-08 estate-model precedence", () => {
  const paths = resolveDevPaths();

  test("PULSE_WEB_ESTATE_MODEL unset → default overlay to absolute reference path", () => {
    const env = buildChildEnv(OPTS_MOCK, "abc123def456", paths, {
      PATH: "/usr/bin",
      // PULSE_WEB_ESTATE_MODEL intentionally absent
    });
    const expected = resolve(paths.repoRoot, DEV_DEFAULT_ESTATE_MODEL);
    expect(env[ENV.WEB_ESTATE_MODEL]).toBe(expected);
    // Sanity: it is absolute.
    expect(env[ENV.WEB_ESTATE_MODEL]?.startsWith("/")).toBe(true);
  });

  test("PULSE_WEB_ESTATE_MODEL set → passed through unchanged", () => {
    const operatorPath = "/custom/estate/model.json";
    const env = buildChildEnv(OPTS_MOCK, "abc123def456", paths, {
      PATH: "/usr/bin",
      PULSE_WEB_ESTATE_MODEL: operatorPath,
    });
    expect(env[ENV.WEB_ESTATE_MODEL]).toBe(operatorPath);
  });

  test("PULSE_WEB_ESTATE_MODEL empty string → default overlay", () => {
    const env = buildChildEnv(OPTS_MOCK, "abc123def456", paths, {
      PATH: "/usr/bin",
      PULSE_WEB_ESTATE_MODEL: "",
    });
    const expected = resolve(paths.repoRoot, DEV_DEFAULT_ESTATE_MODEL);
    expect(env[ENV.WEB_ESTATE_MODEL]).toBe(expected);
  });

  test("mode: mock → sets MOCK_SCENARIO; mode: env → does not", () => {
    const mockEnv = buildChildEnv(OPTS_MOCK, "abc123def456", paths, { PATH: "/usr/bin" });
    expect(mockEnv[DEV_ENV.MOCK_SCENARIO]).toBe("degraded-mix");
    expect(mockEnv[DEV_ENV.DEV]).toBe("1");
    expect(mockEnv[DEV_ENV.PORT]).toBe(String(DEV_DEFAULT_PORT));
    expect(mockEnv[DEV_ENV.HOST]).toBe(DEV_DEFAULT_HOST);
    expect(mockEnv[DEV_ENV.CLIENT_DIR]).toBe(paths.clientDir);
    expect(mockEnv[DEV_ENV.BUILD_ID]).toBe("abc123def456");

    const envEnv = buildChildEnv(OPTS_ENV, "abc123def456", paths, { PATH: "/usr/bin" });
    expect(envEnv[DEV_ENV.MOCK_SCENARIO]).toBeUndefined();
  });

  test("mode: engine → sets the four source URLs (incl. PULSE_VMALERT_URL)", () => {
    const opts: DevOptions = {
      ...OPTS_ENV,
      mode: {
        kind: "engine",
        vmUrl: "http://vm:8428",
        alertmanagerUrl: "http://am:9093",
        gatusUrl: "http://gatus:8080",
        vmalertUrl: "http://vmalert:8880",
      },
    };
    const env = buildChildEnv(opts, "abc123def456", paths, { PATH: "/usr/bin" });
    expect(env[ENV.VM_URL]).toBe("http://vm:8428");
    expect(env[ENV.ALERTMANAGER_URL]).toBe("http://am:9093");
    expect(env[ENV.GATUS_URL]).toBe("http://gatus:8080");
    expect(env[ENV.VMALERT_URL]).toBe("http://vmalert:8880");
  });

  test("mode: mock / env → does not set PULSE_VMALERT_URL", () => {
    const mockEnv = buildChildEnv(OPTS_MOCK, "abc123def456", paths, { PATH: "/usr/bin" });
    expect(mockEnv[ENV.VMALERT_URL]).toBeUndefined();
    const envEnv = buildChildEnv(OPTS_ENV, "abc123def456", paths, { PATH: "/usr/bin" });
    expect(envEnv[ENV.VMALERT_URL]).toBeUndefined();
  });
});
