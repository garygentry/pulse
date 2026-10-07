/** vmalert.test.ts — evidence for item 015 (03-source-clients-and-validation.md §7).
 *  Covers the vmalert client:
 *   - rules() performs exactly one GET /api/v1/rules and returns every validated group and
 *     active/inactive/deadman rule (criterion 1);
 *   - rule results preserve required state, health, family/group, evaluation timing, bounded
 *     error, and safe (allowlisted, bounded) field semantics (criterion 2);
 *   - malformed consumed nested members and unsupported rule discriminators fail the whole
 *     operation; additive unknown fields pass and are stripped (criterion 3);
 *   - the deadman marker derives from configured identity, never from firing state;
 *   - pinned fixtures and recovery cover no real hostnames/credentials/headers (criterion 4).
 *
 * Pure module: no DOM registration required. Fixtures live in tests/fixtures/vmalert/**.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/sources/types.js";
import { createVmalertClient } from "../../src/sources/vmalert.js";
import { SourceConfigError } from "../../src/sources/fetch.js";
import { SOURCE_MAX_NAME_BYTES } from "../../src/wire/common.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "vmalert");
const BASE = "http://vmalert.internal:8880";

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

/** A fetch serving a fixture body, capturing the request URL and init. */
function fetchFromFixture(
  name: string,
  status = 200,
): { fetchImpl: FetchLike; url: () => string; init: () => RequestInit | undefined; calls: () => number } {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let calls = 0;
  const fetchImpl: FetchLike = (input, init) => {
    calls += 1;
    capturedUrl = input.toString();
    capturedInit = init;
    return Promise.resolve(new Response(fixtureText(name), { status }));
  };
  return { fetchImpl, url: () => capturedUrl, init: () => capturedInit, calls: () => calls };
}

/** A fetch returning a raw body, counting invocations (for status/recovery checks). */
function fetchReturning(
  body: string,
  status: number,
): { fetchImpl: FetchLike; calls: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    calls += 1;
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, calls: () => calls };
}

describe("createVmalertClient — factory validation", () => {
  test("fails closed on a credential-bearing or non-HTTP(S) base URL", () => {
    expect(() => createVmalertClient("http://user:pw@vmalert:8880")).toThrow(SourceConfigError);
    expect(() => createVmalertClient("ftp://vmalert:8880")).toThrow(SourceConfigError);
  });
});

describe("rules() — exact request and complete group/rule retention (criteria 1 & 2)", () => {
  test("issues exactly one GET /api/v1/rules", async () => {
    const fx = fetchFromFixture("rules-success.json");
    const result = await createVmalertClient(BASE, { fetchImpl: fx.fetchImpl }).rules();
    expect(fx.calls()).toBe(1);
    expect(fx.init()?.method ?? "GET").toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v1/rules");
    expect(result.ok).toBe(true);
  });

  test("returns every group and every rule including active, inactive, unhealthy, and recording", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.map((g) => g.group)).toEqual(["deadman", "harbor-hosts"]);
    const hosts = result.data.find((g) => g.group === "harbor-hosts");
    // Every rule survives: firing, pending, inactive/unhealthy, and the recording rule.
    expect(hosts?.rules.map((r) => r.name)).toEqual([
      "HypervisorUnreachable",
      "NasCapacityHigh",
      "PortalErrorBudgetBurn",
      "job:harbor_up:ratio",
    ]);
  });

  test("preserves group identity, derived family, interval, and evaluation timing", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    const hosts = result.data.find((g) => g.group === "harbor-hosts");
    expect(hosts?.file).toBe("/etc/vmalert/rules/hosts.yml");
    expect(hosts?.family).toBe("hosts");
    expect(hosts?.intervalSeconds).toBe(30);
    expect(hosts?.lastEvaluationAt).toBe("2026-01-01T00:00:00.000Z");
    const deadman = result.data.find((g) => g.group === "deadman");
    expect(deadman?.family).toBe("deadman");
  });

  test("preserves rule state, normalized health, evaluation timing, and bounded last error", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    const hosts = result.data.find((g) => g.group === "harbor-hosts");
    const byName = new Map(hosts?.rules.map((r) => [r.name, r]) ?? []);

    const firing = byName.get("HypervisorUnreachable");
    expect(firing?.type).toBe("alerting");
    expect(firing?.state).toBe("firing");
    expect(firing?.health).toBe("healthy");
    expect(firing?.lastEvaluationAt).toBe("2026-01-01T00:00:00.000Z");
    expect(firing?.lastError).toBeNull();

    // An unhealthy rule normalizes health and preserves its bounded last error.
    const unhealthy = byName.get("PortalErrorBudgetBurn");
    expect(unhealthy?.state).toBe("inactive");
    expect(unhealthy?.health).toBe("unhealthy");
    expect(unhealthy?.lastError).toBe('cannot execute query: unknown metric name "portal_error_ratio"');

    // A recording rule has no state and is retained.
    const recording = byName.get("job:harbor_up:ratio");
    expect(recording?.type).toBe("recording");
    expect(recording?.state).toBe("");
    expect(recording?.health).toBe("healthy");
  });

  test("retains only allowlisted, bounded labels and annotations; unknown keys are dropped", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    const hosts = result.data.find((g) => g.group === "harbor-hosts");
    const firing = hosts?.rules.find((r) => r.name === "HypervisorUnreachable");
    // `estate` and `team_owner` are dropped; `severity` is retained.
    expect(firing?.labels).toEqual({ severity: "critical" });
    expect("estate" in (firing?.labels ?? {})).toBe(false);
    expect("team_owner" in (firing?.labels ?? {})).toBe(false);
    // `internal_note` is dropped; `summary` is retained.
    expect(firing?.annotations).toEqual({ summary: "A hypervisor API scrape target has been unreachable for 5m" });
    expect("internal_note" in (firing?.annotations ?? {})).toBe(false);
    // The dropped keys never surface anywhere in the result.
    expect(JSON.stringify(result)).not.toContain("team_owner");
    expect(JSON.stringify(result)).not.toContain("internal_note");
  });
});

describe("deadman marker — derived from identity, not firing state", () => {
  test("the canary rule is marked deadman while ordinary firing rules are not", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    const deadman = result.data.find((g) => g.group === "deadman")?.rules[0];
    expect(deadman?.name).toBe("DeadMansSwitch");
    expect(deadman?.deadman).toBe(true);
    const firing = result.data
      .find((g) => g.group === "harbor-hosts")
      ?.rules.find((r) => r.name === "HypervisorUnreachable");
    // A currently-firing non-canary rule is never a deadman.
    expect(firing?.state).toBe("firing");
    expect(firing?.deadman).toBe(false);
  });

  test("an inactive canary rule remains marked deadman (independent of firing status)", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "deadman",
            file: "/etc/vmalert/rules/deadman.yml",
            interval: 30,
            rules: [
              {
                type: "alerting",
                name: "Watchdog",
                query: "vector(1)",
                state: "inactive",
                health: "ok",
                lastError: "",
                labels: {},
                annotations: {},
                lastEvaluation: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    if (!result.ok) throw new Error("unreachable");
    const rule = result.data[0]?.rules[0];
    expect(rule?.state).toBe("inactive");
    expect(rule?.deadman).toBe(true);
  });
});

describe("rule annotation and label bounds", () => {
  const ruleWith = (labels: Record<string, string>, annotations: Record<string, string>): string =>
    JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "estate",
            file: "/etc/vmalert/rules/estate.yml",
            interval: 30,
            rules: [
              {
                type: "alerting",
                name: "DriftNewFindings",
                query: "vector(1)",
                state: "inactive",
                health: "ok",
                lastError: "",
                labels,
                annotations,
                lastEvaluation: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    });

  test("a live-sized 484-byte rule description is kept, not a source failure", async () => {
    const description = "r".repeat(484);
    const body = ruleWith({ severity: "warning" }, { description });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    if (!result.ok) throw new Error(`unexpected failure: ${result.error.kind}`);
    expect(result.data[0]?.rules[0]?.annotations.description).toBe(description);
  });

  test("an over-bound rule LABEL still fails the source with incompatible", async () => {
    const body = ruleWith({ severity: "s".repeat(300) }, {});
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("incompatible");
  });
});

describe("additive tolerance and malformed rejection (criterion 3)", () => {
  test("accepts additive unknown fields and strips them", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-additive.json").fetchImpl,
    }).rules();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("unknownGroupField");
    expect(JSON.stringify(result)).not.toContain("unknownRuleField");
    expect(JSON.stringify(result)).not.toContain("groupNextEvaluationHint");
  });

  test("a malformed top-level body fails the whole operation", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-malformed-top.json").fetchImpl,
    }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("a malformed consumed nested rule field fails the whole operation", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-malformed-nested.json").fetchImpl,
    }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an unsupported rule discriminator fails the whole operation, publishing no subset", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-unsupported-type.json").fetchImpl,
    }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an alerting rule missing its state fails the whole operation", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "g",
            file: "/etc/vmalert/rules/g.yml",
            rules: [{ type: "alerting", name: "NoState", health: "ok" }],
          },
        ],
      },
    });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an over-bound label map fails with incompatible, never truncating", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "g",
            file: "/etc/vmalert/rules/g.yml",
            rules: [
              {
                type: "alerting",
                name: "OverBound",
                state: "firing",
                health: "ok",
                labels: { severity: "x".repeat(300) },
                annotations: {},
              },
            ],
          },
        ],
      },
    });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("incompatible");
  });

  test("a present but unparseable evaluation timestamp fails the whole operation", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "g",
            file: "/etc/vmalert/rules/g.yml",
            rules: [
              {
                type: "alerting",
                name: "BadTime",
                state: "firing",
                health: "ok",
                lastEvaluation: "not-a-timestamp",
              },
            ],
          },
        ],
      },
    });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an over-length last error is bounded to null rather than failing", async () => {
    const body = JSON.stringify({
      status: "success",
      data: {
        groups: [
          {
            name: "g",
            file: "/etc/vmalert/rules/g.yml",
            rules: [
              {
                type: "alerting",
                name: "LongError",
                state: "inactive",
                health: "err",
                lastError: "e".repeat(SOURCE_MAX_NAME_BYTES + 1),
              },
            ],
          },
        ],
      },
    });
    const result = await createVmalertClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).rules();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data[0]?.rules[0]?.lastError).toBeNull();
    expect(result.data[0]?.rules[0]?.health).toBe("unhealthy");
  });
});

describe("failure-as-data and recovery (criterion 4)", () => {
  test("a non-2xx never rejects and a later success recovers", async () => {
    const failure = await createVmalertClient(BASE, {
      fetchImpl: fetchReturning("upstream boom", 503).fetchImpl,
    }).rules();
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("unreachable");
    expect(failure.error.kind).toBe("upstream-status");
    expect(failure.error.status).toBe(503);

    const recovered = await createVmalertClient(BASE, {
      fetchImpl: fetchFromFixture("rules-success.json").fetchImpl,
    }).rules();
    expect(recovered.ok).toBe(true);
  });

  test("malformed JSON surfaces as data and never leaks the raw body", async () => {
    const result = await createVmalertClient(BASE, {
      fetchImpl: fetchReturning("{ not valid json", 200).fetchImpl,
    }).rules();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed-json");
  });
});

describe("fixture hygiene (criterion 4)", () => {
  test("no pinned vmalert fixture leaks credentials, hostnames, headers, or secrets", () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) {
      const text = fixtureText(name).toLowerCase();
      expect(text).not.toContain("authorization");
      expect(text).not.toContain("password");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("token");
      // No embedded userinfo credentials in any URL.
      expect(fixtureText(name)).not.toContain("@");
    }
  });
});
