/** alertmanager.test.ts — the routing + receivers emitter (02 §4.3, REQ-RND-08, REQ-SEC-02).
 *
 *  Asserts: exactly one alertmanager/routing.yaml with `route` + `receivers` derived only from
 *  channels/routingOverrides, and NO alerting-rule keys (`groups:`/PromQL); the zero-channel case
 *  emits the `pulse-default` stub with a valid root route; channel credentials render as SecretRef
 *  `.raw` references (refusal → omitted field + secret_literal finding); receivers sorted by name,
 *  routes sorted by severity then receiver; a single-target override is `continue: false` while a
 *  fan-out override is `continue: true`. */

import { expect, test, describe } from "bun:test";
import { parse as parseYaml } from "yaml";

import type { Channel, EstateModel, Provenance, RoutingOverride, SecretRef } from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import { emitAlertmanager } from "../src/render/alertmanager.js";

const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

const envRef = (raw: string): SecretRef => ({ kind: "env", raw, varName: raw.replace(/[^A-Z_]/g, "") });

function makeModel(over: {
  channels?: Channel[];
  routingOverrides?: RoutingOverride[];
}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "test-estate",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "https://deadman.example.com/ping",
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: over.channels ?? [],
    routingOverrides: over.routingOverrides ?? [],
    suppressions: [],
  };
}

const channel = (name: string, kind: Channel["kind"], credential: unknown): Channel =>
  ({ name, kind, credential, provenance: PROV } as Channel);

/** Parse the single emitted alertmanager/routing.yaml back into an object. */
function parsed(model: EstateModel): { doc: any; contents: string } {
  const { files } = emitAlertmanager(model);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("alertmanager/routing.yaml");
  return { doc: parseYaml(files[0].contents), contents: files[0].contents };
}

describe("emitAlertmanager — file + boundary (REQ-RND-08)", () => {
  test("always emits exactly one file with route + receivers", () => {
    const { doc } = parsed(
      makeModel({ channels: [channel("team-chat", "chat", envRef("${SLACK_TOKEN}"))] }),
    );
    expect(doc).toHaveProperty("route");
    expect(doc).toHaveProperty("receivers");
    expect(doc.route).toHaveProperty("receiver");
    expect(Array.isArray(doc.receivers)).toBe(true);
  });

  test("a grep for alerting-rule keys (groups:/PromQL) returns nothing", () => {
    const { contents } = parsed(
      makeModel({
        channels: [channel("oncall", "webhook", envRef("${OPSGENIE}"))],
        routingOverrides: [{ severity: "critical", channels: ["oncall"], provenance: PROV }],
      }),
    );
    expect(contents).not.toMatch(/groups:/);
    expect(contents).not.toMatch(/expr:/);
    expect(contents).not.toMatch(/alert:/);
    expect(contents).not.toMatch(/PromQL/i);
  });
});

describe("emitAlertmanager — zero channels (stub receiver)", () => {
  test("emits a single 'pulse-default' stub receiver and a valid root route", () => {
    const { doc } = parsed(makeModel({}));
    expect(doc.receivers).toEqual([{ name: "pulse-default", config: {} }]);
    expect(doc.route.receiver).toBe("pulse-default");
  });
});

describe("emitAlertmanager — credentials (REQ-SEC-02)", () => {
  test("channel credentials render as SecretRef .raw references, never resolved values", () => {
    const { doc, contents } = parsed(
      makeModel({
        channels: [
          channel("team-chat", "chat", { kind: "env", raw: "${SLACK}", varName: "SLACK", resolved: "s3cr3t" }),
          channel("oncall", "webhook", envRef("${OPSGENIE_WEBHOOK}")),
          channel("mailer", "email", envRef("${SMTP_PW}")),
        ],
      }),
    );
    const byName = Object.fromEntries(doc.receivers.map((r: any) => [r.name, r.config]));
    expect(byName["team-chat"].slack_configs[0].api_url).toBe("${SLACK}");
    expect(byName["oncall"].webhook_configs[0].url).toBe("${OPSGENIE_WEBHOOK}");
    expect(byName["mailer"].email_configs[0].auth_password).toBe("${SMTP_PW}");
    expect(contents).not.toContain("s3cr3t");
  });

  test("a telegram channel emits telegram_configs with a bot_token ref and the non-secret chat_id (issue #2)", () => {
    const tgChannel: Channel = {
      name: "ops-telegram",
      kind: "telegram",
      credential: envRef("${TELEGRAM_BOT_TOKEN}"),
      options: { chat_id: -1002001002003 },
      provenance: PROV,
    };
    const { doc, contents } = parsed(makeModel({ channels: [tgChannel] }));
    const cfg = doc.receivers[0].config.telegram_configs[0];
    expect(cfg.bot_token).toBe("${TELEGRAM_BOT_TOKEN}");
    expect(cfg.chat_id).toBe(-1002001002003); // non-secret, carried verbatim from options
    // The credential is a reference, never a resolved literal.
    expect(contents).not.toMatch(/bot_token:.*[0-9]{8,}:[A-Za-z0-9_-]{30,}/);
  });

  test("a refused (non-SecretRef) credential omits the field and adds a secret_literal finding", () => {
    const model = makeModel({ channels: [channel("bad", "chat", "literally-a-token")] });
    const { files, findings } = emitAlertmanager(model);
    const doc = parseYaml(files[0].contents);
    expect(doc.receivers[0].config.slack_configs[0].api_url).toBeUndefined();
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(FINDING_CODES.SECRET_LITERAL);
    expect(findings[0].severity).toBe("error");
    expect(files[0].contents).not.toContain("literally-a-token");
  });
});

describe("emitAlertmanager — routing + ordering", () => {
  test("default receiver is the first channel by name (code-point)", () => {
    const { doc } = parsed(
      makeModel({
        channels: [
          channel("zulip", "chat", envRef("${Z}")),
          channel("alpha", "webhook", envRef("${A}")),
        ],
      }),
    );
    expect(doc.route.receiver).toBe("alpha");
    // receivers sorted by name.
    expect(doc.receivers.map((r: any) => r.name)).toEqual(["alpha", "zulip"]);
  });

  test("a single-target override is continue:false; a fan-out override is continue:true", () => {
    const { doc } = parsed(
      makeModel({
        channels: [
          channel("a", "webhook", envRef("${A}")),
          channel("b", "webhook", envRef("${B}")),
          channel("c", "webhook", envRef("${C}")),
        ],
        routingOverrides: [
          { severity: "warning", channels: ["a"], provenance: PROV },
          { severity: "critical", channels: ["b", "c"], provenance: PROV },
        ],
      }),
    );
    const routes = doc.route.routes as Array<{ continue: boolean; match: { severity: string }; receiver: string }>;
    // sorted by severity then receiver: critical/b, critical/c, warning/a.
    expect(routes.map((r) => [r.match.severity, r.receiver])).toEqual([
      ["critical", "b"],
      ["critical", "c"],
      ["warning", "a"],
    ]);
    expect(routes.map((r) => r.continue)).toEqual([true, true, false]);
  });

  test("rendering the same model twice is byte-identical", () => {
    const model = makeModel({
      channels: [channel("a", "chat", envRef("${A}")), channel("b", "email", envRef("${B}"))],
      routingOverrides: [{ severity: "critical", channels: ["a", "b"], provenance: PROV }],
    });
    expect(emitAlertmanager(model).files).toEqual(emitAlertmanager(model).files);
  });
});
