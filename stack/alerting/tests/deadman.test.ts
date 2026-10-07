// stack/alerting/tests/deadman.test.ts
// Tier-A unit tests for the DeadMansSwitch fragment (04 §5): the route shape (matchers, group_wait,
// group_interval, repeat_interval, continue), the pulse-deadman webhook receiver (url = the
// ${PULSE_DEADMANSSWITCH_URL} reference, send_resolved false), and the SECRET_LITERAL / INVALID_ROUTE
// findings on a resolved-literal / missing deadmanHook (REQ-DEAD-01..04, REQ-SEC-01).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { buildDeadman } from "../src/transform/deadman.js";
import type { Estate, SecretRef } from "../src/transform/estate.js";
import type { AlertingFinding } from "../src/transform/findings.js";

/** A minimal estate carrying the fields buildDeadman reads. */
function makeEstate(deadmanHook: SecretRef | string): Estate {
  return {
    name: "acme-fictional",
    domains: ["acme.example"],
    timezone: "America/New_York",
    deadmanHook,
    provenance: { file: "estate.yaml", path: "estate", line: 1, col: 1 },
  };
}

describe("buildDeadman", () => {
  test("emits the fixed DeadMansSwitch route + pulse-deadman webhook receiver", () => {
    const findings: AlertingFinding[] = [];
    const { route, receiver } = buildDeadman(
      makeEstate("${PULSE_DEADMANSSWITCH_URL}"),
      findings,
    );

    expect(findings.length).toBe(0);

    // Route (§5.1).
    expect(route.receiver).toBe("pulse-deadman");
    expect(route.matchers).toEqual(['alertname="DeadMansSwitch"']);
    expect(route.group_wait).toBe("0s");
    expect(route.group_interval).toBe("1m");
    expect(route.repeat_interval).toBe("5m");
    expect(route.continue).toBe(false);

    // Receiver (§5.1).
    expect(receiver.name).toBe("pulse-deadman");
    expect(receiver.webhook_configs).toBeDefined();
    expect(receiver.webhook_configs!.length).toBe(1);
    const wh = receiver.webhook_configs![0]!;
    expect(wh.url).toBe("${PULSE_DEADMANSSWITCH_URL}");
    expect(wh.send_resolved).toBe(false);
  });

  test("accepts a SecretRef deadmanHook without a finding", () => {
    const findings: AlertingFinding[] = [];
    const ref: SecretRef = {
      kind: "op",
      raw: "op://vault/deadman/url",
      vault: "vault",
      item: "deadman",
      field: "url",
    };
    const { receiver } = buildDeadman(makeEstate(ref), findings);
    expect(findings.length).toBe(0);
    // The receiver url is ALWAYS the env reference — the hook value is never copied in.
    expect(receiver.webhook_configs![0]!.url).toBe("${PULSE_DEADMANSSWITCH_URL}");
  });

  test("accepts a scheme-less plain identifier hook without a finding", () => {
    const findings: AlertingFinding[] = [];
    buildDeadman(makeEstate("deadman-primary"), findings);
    expect(findings.length).toBe(0);
  });

  test("a resolved-literal (raw URL) deadmanHook yields a SECRET_LITERAL error", () => {
    const findings: AlertingFinding[] = [];
    const { receiver } = buildDeadman(
      makeEstate("https://deadman.example.com/hook?token=s3cr3t"),
      findings,
    );

    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.severity).toBe("error");
    expect(f.code).toBe("SECRET_LITERAL");
    expect(f.path).toBe("estate.deadmanHook");
    expect(f.file.length).toBeGreaterThan(0);
    expect(f.fix.length).toBeGreaterThan(0);
    // The literal value (and its token) must never appear in the finding OR the emitted config.
    expect(f.message).not.toContain("s3cr3t");
    expect(receiver.webhook_configs![0]!.url).toBe("${PULSE_DEADMANSSWITCH_URL}");
  });

  test("a missing/empty deadmanHook yields an INVALID_ROUTE error", () => {
    const findings: AlertingFinding[] = [];
    buildDeadman(makeEstate("   "), findings);

    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.severity).toBe("error");
    expect(f.code).toBe("INVALID_ROUTE");
    expect(f.path).toBe("estate.deadmanHook");
  });
});
