// stack/alerting/tests/webhook.test.ts
// The automation-webhook event contract test (06 §6). Asserts the guaranteed subset of Alertmanager's
// native webhook payload that Pulse publishes as `contract/webhook-event.schema.json` (item 010):
//
//   §6.2  Schema validation      — firing/resolved fixtures conform; firing endsAt is the zero time,
//                                  resolved endsAt is a real RFC 3339 timestamp; both share one fp.
//   §6.3  Human⇄structured parity — every payload with annotations.summary carries labels.severity/
//                                  alertname/estate; severity is TEXT (a taxonomy word), never color.
//   §6.4  Retry idempotency      — an original send and a retry of the same identity share a fingerprint.
//   §6.4  Firing-before-resolved  — a loopback Bun.serve receiver (port 0) records the ordered sequence
//                                  per fingerprint and asserts, per identity, firing is never observed
//                                  after its resolved. No cross-identity total ordering is asserted.
//
// Tier A: pure in-process, no Docker. The Bun.serve receiver binds LOOPBACK ONLY and posts fictional
// fixtures — it contacts no real provider (REQ-TEST-01). Tier A never self-skips (must fail RED).
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITY_TAXONOMY } from "../src/index.js";
import {
  WEBHOOK_FIXTURE_DIR,
  WEBHOOK_SCHEMA,
  isRfc3339DateTime,
  validateAgainstSchema,
} from "./harness.js";

// ── payload shapes (the guaranteed subset — the schema's own required fields) ─────────────────────

interface WebhookAlert {
  status: "firing" | "resolved";
  fingerprint: string;
  labels: {
    alertname?: string;
    severity?: string;
    estate?: string;
    host?: string;
    service?: string;
    [k: string]: string | undefined;
  };
  annotations: { summary?: string; description?: string; [k: string]: string | undefined };
  startsAt: string;
  endsAt?: string;
}
interface WebhookPayload {
  version: string;
  status: "firing" | "resolved";
  groupKey: string;
  commonLabels: Record<string, string>;
  alerts: WebhookAlert[];
}

/** The AM zero time — the value `endsAt` carries while an alert is still firing (00 §8, schema §4.2). */
const ZERO_TIME = "0001-01-01T00:00:00Z";

/** Every text severity the taxonomy defines (critical/warning/info) — the allowed `severity` values. */
const SEVERITY_WORDS = new Set<string>(SEVERITY_TAXONOMY.map((s) => s.name));

function loadPayload(name: string): WebhookPayload {
  return JSON.parse(readFileSync(join(WEBHOOK_FIXTURE_DIR, `${name}.json`), "utf8")) as WebhookPayload;
}

const firing = loadPayload("firing");
const resolved = loadPayload("resolved");
const lifecycle = JSON.parse(
  readFileSync(join(WEBHOOK_FIXTURE_DIR, "lifecycle.json"), "utf8"),
) as WebhookPayload[];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.2 — Schema validation (Tier A)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("§6.2 webhook payload schema validation", () => {
  for (const [name, payload] of [
    ["firing", firing],
    ["resolved", resolved],
  ] as const) {
    test(`${name} payload conforms to webhook-event.schema.json (REQ-HOOK-02)`, () => {
      const errors = validateAgainstSchema(WEBHOOK_SCHEMA, payload);
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(SEVERITY_WORDS.has(payload.alerts[0]!.labels.severity ?? "")).toBe(true);
    });
  }

  test("firing endsAt is the zero time; resolved endsAt is a real RFC 3339 timestamp", () => {
    const f = firing.alerts[0]!;
    const r = resolved.alerts[0]!;
    // firing: still-open → the sentinel zero time (which is itself a valid RFC 3339 instant).
    expect(f.endsAt).toBe(ZERO_TIME);
    expect(isRfc3339DateTime(f.endsAt!)).toBe(true);
    // resolved: a real, non-zero RFC 3339 timestamp strictly after startsAt.
    expect(r.endsAt).not.toBe(ZERO_TIME);
    expect(isRfc3339DateTime(r.endsAt!)).toBe(true);
    expect(Date.parse(r.endsAt!)).toBeGreaterThan(Date.parse(r.startsAt));
  });

  test("firing and resolved share one alerts[].fingerprint (same identity, REQ-HOOK-04)", () => {
    expect(firing.alerts[0]!.fingerprint).toBe(resolved.alerts[0]!.fingerprint);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.3 — Human⇄structured parity (REQ-A11Y-01/02)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Enumerated set: every alert (across firing, resolved, and every lifecycle post) that carries a
//   human-readable `annotations.summary`. Each MUST also carry the structured equivalents
//   labels.severity/alertname/estate, and severity MUST be conveyed as a taxonomy WORD (text), never
//   a color token — so an agent reader receives the same essential state as a human.
// Non-goal: it does not police the free-text CONTENT of summary/description beyond the color check;
//   prose wording is out of scope.

/** Every alert with a human summary, flattened across all fixtures. */
function alertsWithSummary(): WebhookAlert[] {
  const all = [firing, resolved, ...lifecycle].flatMap((p) => p.alerts);
  return all.filter((a) => typeof a.annotations.summary === "string" && a.annotations.summary.length > 0);
}

/** A hex color literal (`#a00`, `ff0000`, …) — the shape severity must NEVER be encoded as. */
const HEX_COLOR = /^#?[0-9a-fA-F]{3,8}$/;
/** Common color WORDS a color-only encoding might use instead of a severity word. */
const COLOR_WORDS = new Set(["red", "amber", "orange", "yellow", "green", "grey", "gray"]);

describe("§6.3 human⇄structured parity", () => {
  test("every summarized alert carries labels.severity/alertname/estate", () => {
    const alerts = alertsWithSummary();
    expect(alerts.length, "fixtures must exercise at least one summarized alert").toBeGreaterThan(0);
    for (const a of alerts) {
      expect(typeof a.labels.severity, `severity for ${a.fingerprint}`).toBe("string");
      expect(typeof a.labels.alertname, `alertname for ${a.fingerprint}`).toBe("string");
      expect(typeof a.labels.estate, `estate for ${a.fingerprint}`).toBe("string");
    }
  });

  test("severity is conveyed as a taxonomy WORD (text), never a color", () => {
    for (const a of alertsWithSummary()) {
      const sev = a.labels.severity ?? "";
      expect(SEVERITY_WORDS.has(sev), `severity "${sev}" must be a taxonomy word`).toBe(true);
      expect(HEX_COLOR.test(sev), `severity "${sev}" must not be a hex color`).toBe(false);
      expect(COLOR_WORDS.has(sev.toLowerCase()), `severity "${sev}" must not be a color word`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 — Retry idempotency & firing-before-resolved ordering (REQ-HOOK-03/04)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Identity key for an alert (the label subset the fingerprint is derived from). */
function identity(a: WebhookAlert): string {
  return `${a.labels.alertname}|${a.labels.host ?? ""}|${a.labels.service ?? ""}`;
}

describe("§6.4 retry idempotency (REQ-HOOK-04)", () => {
  test("an original send and a retry of the same identity carry the same fingerprint", () => {
    // The lifecycle carries two firing posts for the camera-svc identity (an original + a retry).
    const original = firing.alerts[0]!;
    const retry = lifecycle
      .flatMap((p) => p.alerts)
      .find((a) => a.status === "firing" && identity(a) === identity(original) && a !== original);
    expect(retry, "lifecycle must contain a retry of the firing identity").toBeDefined();
    expect(retry!.fingerprint).toBe(original.fingerprint);
  });

  test("all posts sharing an identity carry one stable fingerprint (across firing + resolved + retry)", () => {
    const byIdentity = new Map<string, Set<string>>();
    for (const a of lifecycle.flatMap((p) => p.alerts)) {
      const set = byIdentity.get(identity(a)) ?? new Set<string>();
      set.add(a.fingerprint);
      byIdentity.set(identity(a), set);
    }
    expect(byIdentity.size, "lifecycle must span more than one identity").toBeGreaterThan(1);
    for (const [id, fps] of byIdentity) {
      expect(fps.size, `identity ${id} must map to exactly one fingerprint`).toBe(1);
    }
  });
});

// Firing-before-resolved: a loopback Bun.serve receiver records the ordered post sequence per
// fingerprint. Per identity, a firing must never be observed AFTER its resolved. No total ordering
// across unrelated fingerprints is asserted (explicitly allowed — REQ-HOOK-03): the lifecycle
// deliberately resolves host-beta BEFORE host-alpha to prove cross-identity order is not constrained.
describe("§6.4 firing-before-resolved per identity (REQ-HOOK-03)", () => {
  const received: { fp: string; status: string }[] = [];
  let server: { url: URL; stop(): void };

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1", // loopback only (REQ-TEST-01)
      fetch: async (req) => {
        const body = (await req.json()) as WebhookPayload;
        for (const a of body.alerts) received.push({ fp: a.fingerprint, status: a.status });
        return new Response("ok");
      },
    });
    // Replay the lifecycle sequence in order; sequential awaits preserve post order.
    for (const post of lifecycle) {
      await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(post),
      });
    }
  });
  afterAll(() => server?.stop());

  test("the receiver observed every replayed post", () => {
    const expected = lifecycle.reduce((n, p) => n + p.alerts.length, 0);
    expect(received.length).toBe(expected);
  });

  test("for each identity, a firing is never observed after its resolved", () => {
    const fingerprints = new Set(received.map((r) => r.fp));
    expect(fingerprints.size, "receiver must have seen more than one fingerprint").toBeGreaterThan(1);
    for (const fp of fingerprints) {
      const seq = received.filter((r) => r.fp === fp).map((r) => r.status);
      const firstResolved = seq.indexOf("resolved");
      if (firstResolved !== -1) {
        expect(
          seq.slice(firstResolved).includes("firing"),
          `fp ${fp}: firing observed after resolved in sequence ${seq.join(",")}`,
        ).toBe(false);
      }
    }
  });
});
