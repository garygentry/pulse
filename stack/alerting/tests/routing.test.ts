// stack/alerting/tests/routing.test.ts
// Tier-A unit tests for the routing composition root (04 §2/§3/§6/§7/§12):
//   - liftReceivers strips the abstract {name,config} wrapper and preserves the ${VAR} slots intact.
//   - buildSeverityRoute realizes the fixed severity policy (group_by, critical 10s/30m/continue/
//     no-mute, warning mute+15m, info active daily-0900).
//   - reconcileHumanCoverage: no finding when human present, WEBHOOK_ONLY_CRITICAL (improvement) for
//     webhook-only, NO_HUMAN_CHANNEL (error) for no channels.
//   - buildAlertmanagerConfig: null on any error finding, else a fully-assembled, stably-sorted config.
// Exercises the ROUTING_GAP / NO_HUMAN_CHANNEL / WEBHOOK_ONLY_CRITICAL members owned by item 007.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  buildAlertmanagerConfig,
  buildSeverityRoute,
  liftReceivers,
  reconcileHumanCoverage,
} from "../src/transform/routing.js";
import type { AmRoute } from "../src/transform/am-config.js";
import type { AmRoutingRendered } from "../src/transform/rendered.js";
import type { Channel, EstateModel } from "../src/transform/estate.js";
import type { AlertingFinding } from "../src/transform/findings.js";
import { GROUP_BY } from "../src/constants.js";

const PROV = { file: "estate.yaml", path: "estate", line: 1, col: 1 } as const;

/** A rendered routing tree with critical→oncall and warning→ops matches, plus the two receivers. */
function makeRendered(over: Partial<AmRoutingRendered> = {}): AmRoutingRendered {
  return {
    route: {
      receiver: "oncall",
      routes: [
        { continue: false, match: { severity: "critical" }, receiver: "oncall" },
        { continue: false, match: { severity: "warning" }, receiver: "ops" },
      ],
    },
    receivers: [
      { name: "oncall", config: { webhook_configs: [{ url: "${OPSGENIE_WEBHOOK}" }] } },
      { name: "ops", config: { slack_configs: [{ api_url: "${SLACK_TOKEN}" }] } },
    ],
    ...over,
  };
}

function chatChannel(name: string): Channel {
  return {
    name,
    kind: "chat",
    credential: { kind: "env", raw: "${SLACK_TOKEN}", varName: "SLACK_TOKEN" },
    provenance: PROV,
  };
}

function webhookChannel(name: string): Channel {
  return {
    name,
    kind: "webhook",
    credential: { kind: "env", raw: "${HOOK_URL}", varName: "HOOK_URL" },
    provenance: PROV,
  };
}

function telegramChannel(name: string): Channel {
  return {
    name,
    kind: "telegram",
    credential: { kind: "env", raw: "${TELEGRAM_BOT_TOKEN}", varName: "TELEGRAM_BOT_TOKEN" },
    options: { chat_id: -1002001002003 },
    provenance: PROV,
  };
}

function makeModel(over: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "acme-fictional",
      domains: ["acme.example"],
      timezone: "America/New_York",
      deadmanHook: "${PULSE_DEADMANSSWITCH_URL}",
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: [chatChannel("primary")],
    routingOverrides: [],
    suppressions: [],
    ...over,
  };
}

/** Find the sole child route whose matchers include the given `severity="…"` matcher. */
function severityRoutes(root: AmRoute, severity: string): AmRoute[] {
  return (root.routes ?? []).filter((r) => (r.matchers ?? []).includes(`severity="${severity}"`));
}

describe("liftReceivers (§2)", () => {
  test("strips the {name,config} wrapper and preserves slots with ${VAR} refs intact", () => {
    const findings: AlertingFinding[] = [];
    const receivers = liftReceivers(makeRendered(), findings);

    expect(findings.length).toBe(0);
    // Sorted by name: oncall < ops.
    expect(receivers.map((r) => r.name)).toEqual(["oncall", "ops"]);

    const oncall = receivers[0]!;
    expect(oncall).toHaveProperty("webhook_configs");
    expect(oncall).not.toHaveProperty("config");
    expect(oncall.webhook_configs![0]!.url).toBe("${OPSGENIE_WEBHOOK}");

    const ops = receivers[1]!;
    expect(ops.slack_configs![0]!.api_url).toBe("${SLACK_TOKEN}");
  });

  test("preserves the telegram_configs slot with a bot_token ref + chat_id (issue #2)", () => {
    const findings: AlertingFinding[] = [];
    const receivers = liftReceivers(
      makeRendered({
        receivers: [
          {
            name: "tg-alerts",
            config: {
              telegram_configs: [{ bot_token: "${TELEGRAM_BOT_TOKEN}", chat_id: -1002001002003 }],
            },
          },
        ],
      }),
      findings,
    );
    expect(findings.length).toBe(0);
    const tg = receivers[0]!;
    expect(tg).toHaveProperty("telegram_configs");
    expect(tg).not.toHaveProperty("config");
    expect(tg.telegram_configs![0]!.bot_token).toBe("${TELEGRAM_BOT_TOKEN}");
    expect(tg.telegram_configs![0]!.chat_id).toBe(-1002001002003);
  });

  test("a telegram receiver embedding a resolved bot_token literal yields SECRET_LITERAL (error)", () => {
    const findings: AlertingFinding[] = [];
    liftReceivers(
      makeRendered({
        receivers: [
          {
            name: "leaky-tg",
            config: { telegram_configs: [{ bot_token: "123456:AAreal-bot-token", chat_id: 42 }] },
          },
        ],
      }),
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("SECRET_LITERAL");
    expect(findings[0]!.message).not.toContain("123456:AAreal-bot-token");
  });

  test("a receiver with no known slot yields INVALID_ROUTE (error)", () => {
    const findings: AlertingFinding[] = [];
    liftReceivers(
      makeRendered({ receivers: [{ name: "bogus", config: { unknown_configs: [{}] } }] }),
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("INVALID_ROUTE");
    expect(findings[0]!.severity).toBe("error");
  });

  test("a receiver embedding a resolved credential literal yields SECRET_LITERAL (error)", () => {
    const findings: AlertingFinding[] = [];
    liftReceivers(
      makeRendered({
        receivers: [{ name: "leaky", config: { slack_configs: [{ api_url: "xoxb-real-token-1234" }] } }],
      }),
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("SECRET_LITERAL");
    // The literal secret must never appear in the finding.
    expect(findings[0]!.message).not.toContain("xoxb-real-token-1234");
  });
});

describe("buildSeverityRoute (§3)", () => {
  test("realizes the fixed severity policy (group_by, critical, warning mute, info active)", () => {
    const findings: AlertingFinding[] = [];
    const root = buildSeverityRoute(makeRendered(), "quiet-hours", "daily-0900", findings);

    expect(findings.length).toBe(0);
    expect(root.receiver).toBe("pulse-default-ops");
    expect(root.group_by).toEqual([...GROUP_BY]);

    // Critical human route (continue:true, no mute).
    const critical = severityRoutes(root, "critical").find((r) => r.continue === true)!;
    expect(critical.receiver).toBe("oncall");
    expect(critical.group_wait).toBe("10s");
    expect(critical.repeat_interval).toBe("30m");
    expect(critical.continue).toBe(true);
    expect(critical.mute_time_intervals).toBeUndefined();

    // Critical mirror route (continue:false).
    const mirror = severityRoutes(root, "critical").find((r) => r.continue === false)!;
    expect(mirror.receiver).toBe("pulse-webhook-mirror");
    expect(mirror.continue).toBe(false);

    // Warning route: mute ['quiet-hours'], 15m grouping.
    const warning = severityRoutes(root, "warning")[0]!;
    expect(warning.receiver).toBe("ops");
    expect(warning.group_interval).toBe("15m");
    expect(warning.mute_time_intervals).toEqual(["quiet-hours"]);

    // Info route: active ['daily-0900'], digest receiver.
    const info = severityRoutes(root, "info")[0]!;
    expect(info.receiver).toBe("pulse-digest");
    expect(info.active_time_intervals).toEqual(["daily-0900"]);
  });

  test("omits the warning mute when quiet hours are not declared", () => {
    const findings: AlertingFinding[] = [];
    const root = buildSeverityRoute(makeRendered(), undefined, "daily-0900", findings);
    const warning = severityRoutes(root, "warning")[0]!;
    expect(warning.mute_time_intervals).toBeUndefined();
  });

  test("an unmatched severity yields ROUTING_GAP (inconsistency)", () => {
    const findings: AlertingFinding[] = [];
    // Rendered tree declares only warning — critical has no explicit target.
    const rendered = makeRendered({
      route: {
        receiver: "ops",
        routes: [{ continue: false, match: { severity: "warning" }, receiver: "ops" }],
      },
    });
    buildSeverityRoute(rendered, undefined, "daily-0900", findings);
    const gap = findings.find((f) => f.code === "ROUTING_GAP")!;
    expect(gap).toBeDefined();
    expect(gap.severity).toBe("inconsistency");
    expect(gap.path).toContain("critical");
  });
});

describe("reconcileHumanCoverage (§7)", () => {
  test("no finding when a human critical channel is present", () => {
    const findings: AlertingFinding[] = [];
    reconcileHumanCoverage(makeModel(), makeRendered(), findings);
    expect(findings.length).toBe(0);
  });

  test("no finding when a telegram channel provides human critical coverage (issue #2)", () => {
    const findings: AlertingFinding[] = [];
    reconcileHumanCoverage(
      makeModel({ channels: [telegramChannel("tg-alerts")] }),
      makeRendered(),
      findings,
    );
    expect(findings.length).toBe(0);
  });

  test("WEBHOOK_ONLY_CRITICAL (improvement) for a webhook-only estate", () => {
    const findings: AlertingFinding[] = [];
    reconcileHumanCoverage(
      makeModel({ channels: [webhookChannel("automation")] }),
      makeRendered(),
      findings,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("WEBHOOK_ONLY_CRITICAL");
    expect(findings[0]!.severity).toBe("improvement");
  });

  test("NO_HUMAN_CHANNEL (error) with no human channel and no webhook policy", () => {
    const findings: AlertingFinding[] = [];
    reconcileHumanCoverage(makeModel({ channels: [] }), makeRendered(), findings);
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("NO_HUMAN_CHANNEL");
    expect(findings[0]!.severity).toBe("error");
  });
});

describe("buildAlertmanagerConfig (§12)", () => {
  test("assembles a fully-sorted config on a valid estate", () => {
    const findings: AlertingFinding[] = [];
    const config = buildAlertmanagerConfig(
      { estate: makeModel(), routing: makeRendered() },
      findings,
    );
    expect(config).not.toBeNull();
    expect(config!.global.resolve_timeout).toBe("5m");

    // Receivers are stably sorted by name and include every product-static receiver.
    const names = config!.receivers.map((r) => r.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("pulse-default-ops");
    expect(names).toContain("pulse-digest");
    expect(names).toContain("pulse-webhook-mirror");
    expect(names).toContain("pulse-deadman");
    expect(names).toContain("oncall");

    // send_resolved policy (REQ-SEV-05, §5/§6).
    const digest = config!.receivers.find((r) => r.name === "pulse-digest")!;
    expect(digest.webhook_configs![0]!.send_resolved).toBe(false);
    const mirror = config!.receivers.find((r) => r.name === "pulse-webhook-mirror")!;
    expect(mirror.webhook_configs![0]!.url).toBe("${PULSE_WEBHOOK_MIRROR_URL}");
    expect(mirror.webhook_configs![0]!.send_resolved).toBe(true);

    // Route children are stably sorted by matcher; the deadman child is present and isolated.
    const matcherKeys = (config!.route.routes ?? []).map((r) => JSON.stringify(r.matchers ?? []));
    expect(matcherKeys).toEqual([...matcherKeys].sort());
    const deadman = (config!.route.routes ?? []).find((r) =>
      (r.matchers ?? []).includes('alertname="DeadMansSwitch"'),
    )!;
    expect(deadman.receiver).toBe("pulse-deadman");
    expect(deadman.continue).toBe(false);
  });

  test("is deterministic: identical input → identical config", () => {
    const a = buildAlertmanagerConfig({ estate: makeModel(), routing: makeRendered() }, []);
    const b = buildAlertmanagerConfig({ estate: makeModel(), routing: makeRendered() }, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("returns null when a NO_HUMAN_CHANNEL error is pushed", () => {
    const findings: AlertingFinding[] = [];
    const config = buildAlertmanagerConfig(
      { estate: makeModel({ channels: [] }), routing: makeRendered() },
      findings,
    );
    expect(config).toBeNull();
    expect(findings.some((f) => f.code === "NO_HUMAN_CHANNEL" && f.severity === "error")).toBe(true);
  });

  test("a webhook-only estate yields WEBHOOK_ONLY_CRITICAL (improvement) and a non-null config", () => {
    const findings: AlertingFinding[] = [];
    const config = buildAlertmanagerConfig(
      { estate: makeModel({ channels: [webhookChannel("automation")] }), routing: makeRendered() },
      findings,
    );
    expect(config).not.toBeNull();
    expect(findings.some((f) => f.code === "WEBHOOK_ONLY_CRITICAL" && f.severity === "improvement")).toBe(
      true,
    );
  });
});
