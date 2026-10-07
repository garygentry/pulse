/** validate.test.ts — semantic invariants + version short-circuit
 *  (04-validation-and-normalization.md, 06 §5; 07 §3.5).
 *
 *  Asserts each contract-level invariant in isolation by driving the detectors directly against
 *  a shared FindingCollector + stub ProvenanceIndex, plus the pipeline-level version
 *  short-circuit via loadAndValidate over the bad-version fixtures. */

import { expect, test, describe } from "bun:test";
import { join } from "node:path";

import {
  checkTimezone,
  checkSuppressionRationales,
  checkSecretLiterals,
  checkExactlyOneClass,
  checkNasApiCompleteness,
  checkTelegramOptions,
  checkHostLocalProbeHost,
  checkGatusNames,
  checkCrossReferences,
} from "../src/validate/invariants.js";
import { endpointAlertSchema } from "../src/schema/service.js";
import { FindingCollector } from "../src/findings/collect.js";
import { loadAndValidate } from "../src/loader/index.js";
import { FINDING_CODES } from "../src/findings/codes.js";
import type { ProvenanceIndex } from "../src/loader/index.js";
import type { MergedInventory } from "../src/validate/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");

/** Deterministic stub provenance — echoes the queried path with a fixed file/line/col. */
const prov: ProvenanceIndex = {
  lookup: (path: string) => ({ file: "estate.yaml", path, line: 1, col: 1 }),
};

/** Build a merged-inventory tree from a partial (tests are transpiled, not type-checked; the
 *  cast reflects that these plain objects mirror the shape-validated inventory surface). */
function inv(partial: Record<string, unknown>): MergedInventory {
  return partial as unknown as MergedInventory;
}

/** Run one detector and return the collected findings. */
function run(
  detector: (m: MergedInventory, p: ProvenanceIndex, c: FindingCollector) => void,
  merged: Record<string, unknown>,
) {
  const c = new FindingCollector();
  detector(inv(merged), prov, c);
  return c.drain();
}

describe("mandatory rationale (MISSING_RATIONALE)", () => {
  test("a suppression with an empty rationale → one MISSING_RATIONALE error", () => {
    const out = run(checkSuppressionRationales, {
      suppressions: [{ class: "expected-churn", target: "t", rationale: "" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_RATIONALE);
    expect(out[0]!.severity).toBe("error");
    expect(out[0]!.path).toContain("suppressions[0].rationale");
  });

  test("an excluded host with no suppression rationale → MISSING_RATIONALE", () => {
    const out = run(checkSuppressionRationales, {
      hosts: [
        {
          name: "old",
          collection_class: "excluded",
          addresses: ["1"],
          suppressed: { class: "excluded", rationale: "  " },
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_RATIONALE);
    expect(out[0]!.path).toContain("hosts[0].suppressed.rationale");
  });

  test("a suppression WITH a rationale → no finding", () => {
    const out = run(checkSuppressionRationales, {
      suppressions: [{ class: "expected-churn", target: "t", rationale: "Documented reason." }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("secret-not-literal (SECRET_LITERAL)", () => {
  test("a channel credential literal → SECRET_LITERAL", () => {
    const out = run(checkSecretLiterals, {
      channels: [{ name: "c", kind: "chat", credential: "xoxb-literal-token" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(out[0]!.path).toContain("channels[0].credential");
  });

  test("${ENV} and op:// references → no finding", () => {
    const out = run(checkSecretLiterals, {
      channels: [
        { name: "a", kind: "chat", credential: "${SLACK_TOKEN}" },
        { name: "b", kind: "email", credential: "op://vault/item/field" },
      ],
    });
    expect(out).toHaveLength(0);
  });

  test("an api-host (nas-api) with a literal credential → SECRET_LITERAL", () => {
    const out = run(checkSecretLiterals, {
      hosts: [
        {
          name: "nas",
          collection_class: "nas-api",
          addresses: ["1"],
          api_endpoint: "https://nas",
          credential: "plain-password",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(out[0]!.path).toContain("hosts[0].credential");
  });

  test("a nas-api host with NO credential (node_exporter default) → no SECRET_LITERAL (issue #4)", () => {
    const out = run(checkSecretLiterals, {
      hosts: [{ name: "nas", collection_class: "nas-api", addresses: ["10.0.0.6"] }],
    });
    expect(out).toHaveLength(0);
  });

  test("a deep-health literal credential → SECRET_LITERAL", () => {
    const out = run(checkSecretLiterals, {
      services: [
        {
          name: "web",
          host: "web-01",
          kind: "http",
          managed: true,
          deep_health: {
            endpoint: "/healthz",
            response_mapping: { status: "$.status" },
            alert_expression: "status != 1",
            credential: "plain-health-token",
          },
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(out[0]!.path).toContain("services[0].deep_health.credential");
  });

  test("deep-health ${ENV} and op:// credentials → no finding", () => {
    const services = ["${HEALTH_TOKEN}", "op://infra/health/token"].map((credential, index) => ({
      name: `web-${index}`,
      host: "web-01",
      kind: "http",
      managed: true,
      deep_health: {
        endpoint: "/healthz",
        response_mapping: { status: "$.status" },
        alert_expression: "status != 1",
        credential,
      },
    }));
    expect(run(checkSecretLiterals, { services })).toHaveLength(0);
  });
});

describe("host-local probe host class (HOST_LOCAL_PROBE_HOST, issue #8)", () => {
  const svc = (host: string, hostLocal: boolean) => ({
    services: [
      {
        name: "nvr",
        host,
        kind: "http",
        managed: true,
        deep_health: {
          endpoint: "http://127.0.0.1:5000/api/stats",
          response_mapping: { detectors: "$.detectors.count" },
          alert_expression: "pulse_deep_health_up == 0",
          host_local: hostLocal,
        },
      },
    ],
  });
  const withHost = (cls: string, hostLocal: boolean) => ({
    hosts: [{ name: "h1", collection_class: cls, addresses: ["10.0.0.4"] }],
    ...svc("h1", hostLocal),
  });

  test("a host_local probe on a managed-linux host → no finding", () => {
    expect(run(checkHostLocalProbeHost, withHost("managed-linux", true))).toHaveLength(0);
  });

  test("a host_local probe on a nas-api host → one HOST_LOCAL_PROBE_HOST error", () => {
    const out = run(checkHostLocalProbeHost, withHost("nas-api", true));
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.HOST_LOCAL_PROBE_HOST);
    expect(out[0]!.severity).toBe("error");
    expect(out[0]!.path).toContain("services[0].deep_health.host_local");
  });

  test("a NON-host-local (central) probe on a nas-api host → no finding", () => {
    expect(run(checkHostLocalProbeHost, withHost("nas-api", false))).toHaveLength(0);
  });

  test("an unresolved host is left to UNRESOLVED_HOST (no finding here)", () => {
    expect(run(checkHostLocalProbeHost, svc("ghost", true))).toHaveLength(0);
  });
});

describe("names rendered into Gatus (GATUS_UNSAFE_NAME, issue #1)", () => {
  const ingress = (name: string, host: string, extra: Record<string, unknown> = {}) => ({
    services: [{ name, host, kind: "http", managed: true, ingress_url: "https://w.example", ...extra }],
  });

  test("plain names → no finding", () => {
    expect(run(checkGatusNames, ingress("web-app", "web01"))).toHaveLength(0);
  });

  for (const [label, bad] of [
    ["double quote", 'we"b'],
    ["backslash", "we\\b"],
    ["newline", "we\nb"],
    ["carriage return", "we\rb"],
  ] as const) {
    test(`a ${label} in an ingress service name → one GATUS_UNSAFE_NAME error`, () => {
      const out = run(checkGatusNames, ingress(bad, "web01"));
      expect(out).toHaveLength(1);
      expect(out[0]!.code).toBe(FINDING_CODES.GATUS_UNSAFE_NAME);
      expect(out[0]!.severity).toBe("error");
      expect(out[0]!.path).toBe("services[0].name");
    });
  }

  test("an unsafe host name on an ingress service is flagged at services[i].host", () => {
    const out = run(checkGatusNames, ingress("web", 'h"1'));
    expect(out.map((f) => f.path)).toEqual(["services[0].host"]);
  });

  test("an unsafe probe-only host name is flagged; other host classes are not rendered", () => {
    const out = run(checkGatusNames, {
      hosts: [
        { name: 'edge"1', collection_class: "probe-only", probe: { kind: "http", target: "https://e" } },
        { name: 'box"2', collection_class: "managed-linux", addresses: ["10.0.0.5"] },
      ],
    });
    expect(out.map((f) => f.path)).toEqual(["hosts[0].name"]);
  });

  test("a service that renders no check (no ingress_url, or suppressed) is not flagged", () => {
    expect(run(checkGatusNames, { services: [{ name: 'a"b', host: "h" }] })).toHaveLength(0);
    expect(
      run(checkGatusNames, ingress('a"b', "h", { suppressed: { class: "excluded", rationale: "x" } })),
    ).toHaveLength(0);
  });
});

describe("alerts: binding threshold bounds (issue #1)", () => {
  test("failure/success thresholds accept 1..60 and reject 0 and 61", () => {
    for (const key of ["failure_threshold", "success_threshold"]) {
      expect(endpointAlertSchema.safeParse({ type: "custom", [key]: 1 }).success).toBe(true);
      expect(endpointAlertSchema.safeParse({ type: "custom", [key]: 60 }).success).toBe(true);
      expect(endpointAlertSchema.safeParse({ type: "custom", [key]: 0 }).success).toBe(false);
      expect(endpointAlertSchema.safeParse({ type: "custom", [key]: 61 }).success).toBe(false);
    }
  });
});

describe("nas-api API-override completeness (INCOMPLETE_NAS_API, issue #4)", () => {
  const nas = (extra: Record<string, unknown>) => ({
    hosts: [{ name: "nas", collection_class: "nas-api", addresses: ["10.0.0.6"], ...extra }],
  });

  test("neither api_endpoint nor credential (the node_exporter default) → no finding", () => {
    expect(run(checkNasApiCompleteness, nas({}))).toHaveLength(0);
  });

  test("both api_endpoint and credential (the opt-in override) → no finding", () => {
    const out = run(
      checkNasApiCompleteness,
      nas({ api_endpoint: "https://nas/api", credential: "${NAS_TOKEN}" }),
    );
    expect(out).toHaveLength(0);
  });

  test("api_endpoint without credential → one INCOMPLETE_NAS_API error citing credential", () => {
    const out = run(checkNasApiCompleteness, nas({ api_endpoint: "https://nas/api" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INCOMPLETE_NAS_API);
    expect(out[0]!.severity).toBe("error");
    expect(out[0]!.path).toContain("hosts[0].credential");
  });

  test("credential without api_endpoint → one INCOMPLETE_NAS_API error citing api_endpoint", () => {
    const out = run(checkNasApiCompleteness, nas({ credential: "${NAS_TOKEN}" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INCOMPLETE_NAS_API);
    expect(out[0]!.path).toContain("hosts[0].api_endpoint");
  });

  test("a non-nas-api host is ignored", () => {
    const out = run(checkNasApiCompleteness, {
      hosts: [
        { name: "hv", collection_class: "hypervisor-api", addresses: ["1"], api_endpoint: "x" },
      ],
    });
    expect(out).toHaveLength(0);
  });
});

describe("telegram channel requires options.chat_id (MISSING_CHAT_ID, issue #2)", () => {
  test("a telegram channel with no options → one MISSING_CHAT_ID error", () => {
    const out = run(checkTelegramOptions, {
      channels: [{ name: "tg", kind: "telegram", credential: "${TELEGRAM_BOT_TOKEN}" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_CHAT_ID);
    expect(out[0]!.severity).toBe("error");
    expect(out[0]!.path).toContain("channels[0].options.chat_id");
  });

  test("a telegram channel with an empty options map (no chat_id) → MISSING_CHAT_ID", () => {
    const out = run(checkTelegramOptions, {
      channels: [{ name: "tg", kind: "telegram", credential: "${T}", options: {} }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_CHAT_ID);
  });

  test("a numeric chat_id → no finding", () => {
    const out = run(checkTelegramOptions, {
      channels: [{ name: "tg", kind: "telegram", credential: "${T}", options: { chat_id: -1002001002003 } }],
    });
    expect(out).toHaveLength(0);
  });

  test("a string chat_id (@channelname) → no finding", () => {
    const out = run(checkTelegramOptions, {
      channels: [{ name: "tg", kind: "telegram", credential: "${T}", options: { chat_id: "@ops_alerts" } }],
    });
    expect(out).toHaveLength(0);
  });

  test("a non-telegram channel is ignored (chat_id not required)", () => {
    const out = run(checkTelegramOptions, {
      channels: [{ name: "c", kind: "chat", credential: "${T}" }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("host-agent vocabulary through the validation pipeline", () => {
  test("managed-linux defaults and deep-health references normalize without resolving secrets", () => {
    const res = loadAndValidate(join(FIXTURES, "host-agent-valid"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const host = res.model.hosts[0];
    expect(host?.collectionClass).toBe("managed-linux");
    if (host?.collectionClass !== "managed-linux") return;
    expect(host.cadvisor).toBe(false);
    expect(host.deliveryForm).toBe("systemd");

    expect(res.model.services[0]?.deepHealth?.credential).toEqual({
      kind: "env",
      raw: "${HEALTH_TOKEN}",
      varName: "HEALTH_TOKEN",
    });
    expect(res.model.services[1]?.deepHealth?.credential).toEqual({
      kind: "op",
      raw: "op://infra/health/token",
      vault: "infra",
      item: "health",
      field: "token",
    });
    expect(res.model.services[2]?.deepHealth).not.toHaveProperty("credential");
  });

  test("a literal deep-health credential is refused with its precise YAML path", () => {
    const res = loadAndValidate(join(FIXTURES, "host-agent-literal"));
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(res.findings[0]?.path).toBe("services[0].deep_health.credential");
  });
});

describe("exactly-one-class backstop (INVALID_ENUM)", () => {
  test("a host with an unknown collection_class → INVALID_ENUM", () => {
    const out = run(checkExactlyOneClass, {
      hosts: [{ name: "h", collection_class: "not-a-class", addresses: ["1"] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INVALID_ENUM);
    expect(out[0]!.path).toContain("hosts[0].collection_class");
  });

  test("a host with an absent collection_class → INVALID_ENUM", () => {
    const out = run(checkExactlyOneClass, {
      hosts: [{ name: "h", addresses: ["1"] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INVALID_ENUM);
  });

  test("a valid collection_class → no finding", () => {
    const out = run(checkExactlyOneClass, {
      hosts: [{ name: "h", collection_class: "managed-linux", addresses: ["1"], exporter_ports: [9100] }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("required timezone (MISSING_TIMEZONE / INVALID_TIMEZONE)", () => {
  test("a missing timezone → MISSING_TIMEZONE", () => {
    const out = run(checkTimezone, { estate: { name: "e" } });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.MISSING_TIMEZONE);
  });

  test("a garbage timezone → INVALID_TIMEZONE", () => {
    const out = run(checkTimezone, { estate: { name: "e", timezone: "Not/AZone" } });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.INVALID_TIMEZONE);
  });

  test("a valid IANA zone → no finding, host-locale-independent", () => {
    expect(run(checkTimezone, { estate: { name: "e", timezone: "America/Chicago" } })).toHaveLength(0);
    expect(run(checkTimezone, { estate: { name: "e", timezone: "UTC" } })).toHaveLength(0);
  });
});

describe("cross-references (UNRESOLVED_HOST / UNRESOLVED_CHANNEL)", () => {
  test("a service.host naming an undeclared host → UNRESOLVED_HOST", () => {
    const out = run(checkCrossReferences, {
      hosts: [{ name: "real", collection_class: "managed-linux", addresses: ["1"] }],
      services: [{ name: "svc", host: "ghost", kind: "http", managed: true }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.UNRESOLVED_HOST);
    expect(out[0]!.path).toContain("services[0].host");
  });

  test("a routing override channel naming an undeclared channel → UNRESOLVED_CHANNEL", () => {
    const out = run(checkCrossReferences, {
      channels: [{ name: "ops", kind: "chat", credential: "${T}" }],
      routing_overrides: [{ severity: "critical", channels: ["nope"] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe(FINDING_CODES.UNRESOLVED_CHANNEL);
    expect(out[0]!.path).toContain("routing_overrides[0].channels[0]");
  });

  test("resolved references → no finding", () => {
    const out = run(checkCrossReferences, {
      hosts: [{ name: "real", collection_class: "managed-linux", addresses: ["1"] }],
      services: [{ name: "svc", host: "real", kind: "http", managed: true }],
      channels: [{ name: "ops", kind: "chat", credential: "${T}" }],
      routing_overrides: [{ severity: "critical", channels: ["ops"] }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("version short-circuit (SC-06)", () => {
  test("an unsupported version returns EXACTLY ONE version finding, no field-level findings", () => {
    const res = loadAndValidate(join(FIXTURES, "bad-version/unsupported"));
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.code).toBe(FINDING_CODES.UNSUPPORTED_VERSION);
    // Prove body validation did not run: no shape/semantic (field-level) finding alongside.
    const bodyCodes: string[] = [
      FINDING_CODES.UNKNOWN_FIELD,
      FINDING_CODES.MISSING_FIELD,
      FINDING_CODES.WRONG_TYPE,
      FINDING_CODES.INVALID_ENUM,
      FINDING_CODES.MISSING_RATIONALE,
      FINDING_CODES.SECRET_LITERAL,
      FINDING_CODES.UNRESOLVED_HOST,
      FINDING_CODES.UNRESOLVED_CHANNEL,
      FINDING_CODES.MISSING_TIMEZONE,
      FINDING_CODES.INVALID_TIMEZONE,
    ];
    expect(res.findings.some((f) => bodyCodes.includes(f.code))).toBe(false);
  });

  test("an absent version returns EXACTLY ONE MISSING_VERSION finding, no field-level findings", () => {
    const res = loadAndValidate(join(FIXTURES, "bad-version/missing"));
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.code).toBe(FINDING_CODES.MISSING_VERSION);
  });
});
