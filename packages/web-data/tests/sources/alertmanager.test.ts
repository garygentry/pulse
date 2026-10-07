/** alertmanager.test.ts — evidence for item 013 (03-source-clients-and-validation.md §6,
 *  09-identity-audit-and-dark-mutation-seams.md §9). Covers the Alertmanager client:
 *   - alert reads use the exact paths and retain fingerprint, derived state, receivers,
 *     suppression relations, group, timing, allowlisted labels/annotations, complete silences,
 *     and safe status/receiver summaries (criterion 1);
 *   - create/expire silence validate closed bounded input, use exact methods/paths, require
 *     valid success output, never retry, and surface every failure as data (criterion 2);
 *   - pinned fixtures cover success, additive fields, malformed nested data, suppression
 *     relationships, map bounds, and recovery (criterion 3);
 *   - no apps/web production module selects or calls the dark write methods (criterion 4).
 *
 * Pure module: no DOM registration required. Fixtures live in tests/fixtures/alertmanager/**.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/sources/types.js";
import {
  createAlertmanagerClient,
  createAlertmanagerWriteClient,
  type CreateSilenceRequest,
} from "../../src/sources/alertmanager.js";
import { SourceConfigError } from "../../src/sources/fetch.js";
import { MAX_ANNOTATION_VALUE_BYTES } from "../../src/sources/annotations.js";
import { SOURCE_MAX_NAME_BYTES } from "../../src/wire/common.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "alertmanager");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const BASE = "http://alertmanager.internal:9093";

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

/** A fetch returning a raw body, counting invocations (for status/recovery/no-retry checks). */
function fetchReturning(
  body: string,
  status: number,
): { fetchImpl: FetchLike; url: () => string; init: () => RequestInit | undefined; calls: () => number } {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let calls = 0;
  const fetchImpl: FetchLike = (input, init) => {
    calls += 1;
    capturedUrl = input.toString();
    capturedInit = init;
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetchImpl, url: () => capturedUrl, init: () => capturedInit, calls: () => calls };
}

/** A fetch that never resolves until aborted, then rejects like a real aborted fetch. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

const VALID_CREATE: CreateSilenceRequest = {
  matchers: [{ name: "alertname", value: "HighCpu", isRegex: false, isEqual: true }],
  startsAt: "2026-09-16T00:00:00.000Z",
  endsAt: "2026-09-16T04:00:00.000Z",
  createdBy: "operator-one",
  comment: "planned maintenance",
};

describe("createAlertmanagerClient / write client — factory validation", () => {
  test("both factories fail closed on a credential-bearing or non-HTTP(S) base URL", () => {
    expect(() => createAlertmanagerClient("http://user:pw@am:9093")).toThrow(SourceConfigError);
    expect(() => createAlertmanagerClient("ftp://am:9093")).toThrow(SourceConfigError);
    expect(() => createAlertmanagerWriteClient("http://user:pw@am:9093")).toThrow(SourceConfigError);
  });
});

describe("alerts() — exact request and relationship retention (criterion 1)", () => {
  test("issues one GET /api/v2/alerts with the exact suppression query", async () => {
    const fx = fetchFromFixture("alerts-success.json");
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fx.fetchImpl }).alerts();
    const url = new URL(fx.url());
    expect(fx.init()?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v2/alerts");
    expect(url.searchParams.get("active")).toBe("true");
    expect(url.searchParams.get("silenced")).toBe("true");
    expect(url.searchParams.get("inhibited")).toBe("true");
    expect(result.ok).toBe(true);
  });

  test("retains fingerprint, derived state, relations, group, timing, and allowlisted maps", async () => {
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-success.json").fetchImpl,
    }).alerts();
    if (!result.ok) throw new Error("unreachable");
    const byFp = new Map(result.data.map((a) => [a.fingerprint, a]));

    const firing = byFp.get("fp-firing");
    expect(firing?.state).toBe("firing");
    expect(firing?.name).toBe("HighCpu");
    expect(firing?.severity).toBe("warning");
    expect(firing?.startsAt).toBe("2026-09-16T00:00:00.000Z");
    expect(firing?.endsAt).toBe("2026-09-16T01:00:00.000Z");
    expect(firing?.group).toBe("cpu-group");
    // Receivers are sorted and deduped (team-b appeared twice, out of order).
    expect(firing?.receivers).toEqual(["team-a", "team-b"]);
    // Only allowlisted triage keys survive; unknown keys are dropped.
    expect(firing?.labels).toEqual({
      alertname: "HighCpu",
      severity: "warning",
      host: "harbor-1",
      instance: "harbor-1:9100",
      service: "api",
    });
    expect(firing?.annotations).toEqual({
      description: "CPU usage above threshold",
      runbook_url: "http://runbooks.internal/cpu",
      summary: "CPU high",
    });
    expect("team_owner" in (firing?.labels ?? {})).toBe(false);
    expect("internal_note" in (firing?.annotations ?? {})).toBe(false);

    const silenced = byFp.get("fp-silenced");
    expect(silenced?.state).toBe("silenced");
    expect(silenced?.silencedBy).toEqual(["sil-1", "sil-2"]);
    expect(silenced?.group).toBeNull();

    const inhibited = byFp.get("fp-inhibited");
    expect(inhibited?.state).toBe("inhibited");
    expect(inhibited?.inhibitedBy).toEqual(["fp-firing"]);
  });

  test("silenced takes precedence over inhibited when both relations are present", async () => {
    const body = JSON.stringify([
      {
        fingerprint: "fp-both",
        labels: { alertname: "Both", severity: "warning" },
        annotations: {},
        startsAt: "2026-09-16T00:00:00.000Z",
        endsAt: "2026-09-16T01:00:00.000Z",
        status: { state: "suppressed", silencedBy: ["sil-9"], inhibitedBy: ["fp-x"] },
        receivers: [{ name: "team-a" }],
      },
    ]);
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchReturning(body, 200).fetchImpl,
    }).alerts();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data[0]?.state).toBe("silenced");
  });

  test("accepts additive unknown fields and strips them", async () => {
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-additive.json").fetchImpl,
    }).alerts();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toHaveLength(1);
    const alert = result.data[0];
    expect("unknown_label" in (alert?.labels ?? {})).toBe(false);
    expect("unknown_annotation" in (alert?.annotations ?? {})).toBe(false);
    expect(JSON.stringify(result)).not.toContain("generatorURL");
    expect(JSON.stringify(result)).not.toContain("extraTopLevelField");
  });

  test("malformed top-level and malformed consumed nested field fail the whole operation", async () => {
    const top = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-malformed-top.json").fetchImpl,
    }).alerts();
    expect(top.ok).toBe(false);
    if (top.ok) throw new Error("unreachable");
    expect(top.error.kind).toBe("invalid-shape");

    const nested = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-malformed-nested.json").fetchImpl,
    }).alerts();
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("unreachable");
    expect(nested.error.kind).toBe("invalid-shape");
  });

  test("an unparseable timestamp fails the whole operation", async () => {
    const body = JSON.stringify([
      {
        fingerprint: "fp-bad-time",
        labels: { alertname: "Bad" },
        annotations: {},
        startsAt: "not-a-timestamp",
        endsAt: "2026-09-16T01:00:00.000Z",
        status: { state: "active" },
        receivers: [],
      },
    ]);
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).alerts();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an over-bound triage LABEL fails with incompatible, never truncating", async () => {
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-overbound.json").fetchImpl,
    }).alerts();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("incompatible");
  });
});

describe("alerts() — annotation bounds (prose is truncated, never fails the source)", () => {
  const withAnnotations = (annotations: Record<string, string>): FetchLike => async () =>
    new Response(
      JSON.stringify([
        {
          fingerprint: "fp-long",
          labels: { alertname: "DriftNewFindings", severity: "warning", host: "web" },
          annotations,
          receivers: [{ name: "default" }],
          status: { state: "active", silencedBy: [], inhibitedBy: [] },
          startsAt: "2026-09-26T00:00:00Z",
          endsAt: "2026-09-26T01:00:00Z",
          updatedAt: "2026-09-26T00:00:00Z",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  test("a live-sized 371-byte description is kept verbatim", async () => {
    const description = "d".repeat(371);
    const result = await createAlertmanagerClient(BASE, { fetchImpl: withAnnotations({ description }) }).alerts();
    if (!result.ok) throw new Error(`unexpected failure: ${result.error.kind}`);
    expect(result.data[0]!.annotations.description).toBe(description);
  });

  test("prose over the annotation bound is truncated with an ellipsis; an over-long runbook link is dropped", async () => {
    const huge = "é".repeat(MAX_ANNOTATION_VALUE_BYTES); // 2 bytes each: twice the bound
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: withAnnotations({ summary: "short", description: huge, runbook_url: `https://x/${"a".repeat(MAX_ANNOTATION_VALUE_BYTES)}` }),
    }).alerts();
    if (!result.ok) throw new Error(`unexpected failure: ${result.error.kind}`);
    const ann = result.data[0]!.annotations;
    expect(ann.summary).toBe("short");
    expect(ann.description!.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(ann.description!).length).toBeLessThanOrEqual(MAX_ANNOTATION_VALUE_BYTES);
    expect(ann.description!.slice(0, -1)).toMatch(/^é+$/); // never splits a code point
    expect("runbook_url" in ann).toBe(false);
  });
});

describe("silences() — exact request and validation (criterion 1)", () => {
  test("issues one GET /api/v2/silences and retains complete records", async () => {
    const fx = fetchFromFixture("silences-success.json");
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fx.fetchImpl }).silences();
    expect(fx.init()?.method).toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v2/silences");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.map((s) => s.id)).toEqual(["sil-1", "sil-2", "sil-3"]);
    expect(result.data.map((s) => s.state)).toEqual(["active", "pending", "expired"]);
    // A matcher without isEqual defaults to equality (true).
    const sil2 = result.data.find((s) => s.id === "sil-2");
    expect(sil2?.matchers[0]).toEqual({ name: "host", value: "harbor-.*", isRegex: true, isEqual: true });
    const sil3 = result.data.find((s) => s.id === "sil-3");
    expect(sil3?.matchers[0]?.isEqual).toBe(false);
    expect(sil3?.createdBy).toBe("operator-one");
    expect(sil3?.comment).toBe("expired silence retained for audit");
  });

  test("a malformed matcher fails the whole operation", async () => {
    const result = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("silences-malformed-nested.json").fetchImpl,
    }).silences();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("an unsupported silence state fails the whole operation", async () => {
    const body = JSON.stringify([
      {
        id: "sil-x",
        matchers: [{ name: "alertname", value: "X", isRegex: false, isEqual: true }],
        createdBy: "op",
        comment: "c",
        startsAt: "2026-09-16T00:00:00.000Z",
        endsAt: "2026-09-16T01:00:00.000Z",
        status: { state: "unknown" },
      },
    ]);
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).silences();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });
});

describe("status() / receivers() — safe summaries (criterion 1)", () => {
  test("status() issues one GET /api/v2/status and never surfaces raw config", async () => {
    const fx = fetchFromFixture("status-success.json");
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fx.fetchImpl }).status();
    expect(fx.init()?.method).toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v2/status");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.version).toBe("0.27.0");
    expect(result.data.cluster).toEqual({ status: "ready", peerCount: 2 });
    expect(result.data.uptime).toBe("2026-09-16T00:00:00.000Z");
    // The raw config body never enters the result.
    expect(JSON.stringify(result)).not.toContain("REDACTED-CONFIG-BODY-MUST-NOT-SURFACE");
    expect(JSON.stringify(result)).not.toContain("configYAML");
  });

  test("status() reports peerCount null and uptime null when the endpoint omits them", async () => {
    // A single-node/disabled cluster reports neither peers nor uptime; unavailable must stay
    // explicitly null rather than collapsing to zero or an empty string.
    const body = JSON.stringify({ versionInfo: { version: "0.27.0" }, cluster: { status: "disabled" } });
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fetchReturning(body, 200).fetchImpl }).status();
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.version).toBe("0.27.0");
    expect(result.data.cluster).toEqual({ status: "disabled", peerCount: null });
    expect(result.data.uptime).toBeNull();
  });

  test("receivers() issues one GET /api/v2/receivers and returns sorted safe summaries", async () => {
    const fx = fetchFromFixture("receivers-success.json");
    const result = await createAlertmanagerClient(BASE, { fetchImpl: fx.fetchImpl }).receivers();
    expect(fx.init()?.method).toBe("GET");
    expect(new URL(fx.url()).pathname).toBe("/api/v2/receivers");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.map((r) => r.name)).toEqual(["team-a", "team-b", "team-catchall"]);
    expect(result.data[0]?.integrations).toEqual(["email", "slack"]);
    expect(result.data[1]?.integrations).toEqual([]);
  });
});

describe("dark writes — createSilence / expireSilence (criterion 2)", () => {
  test("createSilence POSTs /api/v2/silences with the validated body and returns the id", async () => {
    const fx = fetchFromFixture("create-silence-success.json");
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).createSilence(VALID_CREATE);
    const url = new URL(fx.url());
    expect(fx.init()?.method).toBe("POST");
    expect(url.pathname).toBe("/api/v2/silences");
    const body = JSON.parse(String(fx.init()?.body));
    expect(body.matchers).toEqual([{ name: "alertname", value: "HighCpu", isRegex: false, isEqual: true }]);
    expect(body.startsAt).toBe("2026-09-16T00:00:00.000Z");
    expect(body.createdBy).toBe("operator-one");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ id: "sil-created-123" });
  });

  test("createSilence rejects invalid input as data before issuing any request", async () => {
    const fx = fetchReturning("{}", 200);
    const client = createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl });
    // Empty matchers array violates the closed min-1 contract.
    const empty = await client.createSilence({ ...VALID_CREATE, matchers: [] });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.error.kind).toBe("invalid-shape");
    // A non-parseable timestamp is rejected too.
    const badTime = await client.createSilence({ ...VALID_CREATE, startsAt: "nope" });
    expect(badTime.ok).toBe(false);
    // No request was ever issued for either invalid input.
    expect(fx.calls()).toBe(0);
  });

  test("createSilence requires a non-empty returned id", async () => {
    const result = await createAlertmanagerWriteClient(BASE, {
      fetchImpl: fetchReturning(JSON.stringify({ silenceID: "" }), 200).fetchImpl,
    }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("createSilence surfaces a non-2xx as data and never retries", async () => {
    const fx = fetchReturning("boom", 503);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("upstream-status");
    expect(result.error.status).toBe(503);
    expect(fx.calls()).toBe(1);
  });

  test("createSilence surfaces a mid-flight abort as transport data", async () => {
    const controller = new AbortController();
    const promise = createAlertmanagerWriteClient(BASE, { fetchImpl: hangingFetch }).createSilence(VALID_CREATE, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
  });

  test("expireSilence DELETEs /api/v2/silence/:encodedId and accepts an empty success body", async () => {
    const fx = fetchReturning("", 200);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).expireSilence("sil-1");
    expect(fx.init()?.method).toBe("DELETE");
    expect(new URL(fx.url()).pathname).toBe("/api/v2/silence/sil-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toBeNull();
  });

  test("expireSilence percent-encodes the id in the path segment", async () => {
    const fx = fetchReturning("", 200);
    await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).expireSilence("sil 1/2");
    expect(fx.url()).toContain("/api/v2/silence/sil%201%2F2");
  });

  test("expireSilence rejects an empty or control-bearing id before any request", async () => {
    const fx = fetchReturning("", 200);
    const client = createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl });
    expect((await client.expireSilence("")).ok).toBe(false);
    expect((await client.expireSilence("sil\n1")).ok).toBe(false);
    expect(fx.calls()).toBe(0);
  });

  test("expireSilence surfaces a non-2xx as data and never retries", async () => {
    const fx = fetchReturning("boom", 404);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).expireSilence("sil-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("upstream-status");
    expect(result.error.status).toBe(404);
    expect(fx.calls()).toBe(1);
  });
});

describe("dark write failure matrix — timeout / network / malformed success / closed input (criterion 2)", () => {
  test("createSilence surfaces an internal deadline timeout as data", async () => {
    const result = await createAlertmanagerWriteClient(BASE, {
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("timeout");
    expect(result.error.status).toBeNull();
  });

  test("expireSilence surfaces an internal deadline timeout as data", async () => {
    const result = await createAlertmanagerWriteClient(BASE, {
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    }).expireSilence("sil-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("timeout");
  });

  test("createSilence surfaces a raw network rejection as transport data, leaking no exception text, never retrying", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new TypeError("ECONNREFUSED network down"));
    };
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("transport");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(calls).toBe(1);
  });

  test("createSilence surfaces a malformed 2xx success body as data", async () => {
    const fx = fetchReturning("{ not: valid json", 200);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("malformed-json");
    expect(fx.calls()).toBe(1);
  });

  test("createSilence surfaces a well-formed but wrong-shape success body as data", async () => {
    // Valid JSON, but the required non-empty silenceID is absent.
    const result = await createAlertmanagerWriteClient(BASE, {
      fetchImpl: fetchReturning(JSON.stringify({ notTheId: "x" }), 200).fetchImpl,
    }).createSilence(VALID_CREATE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
  });

  test("createSilence rejects an extra unknown request key as closed-input data before any request", async () => {
    const fx = fetchReturning("{}", 200);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).createSilence(
      { ...VALID_CREATE, unexpectedField: "x" } as unknown as CreateSilenceRequest,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
    expect(fx.calls()).toBe(0);
  });

  test("createSilence rejects an over-bound field before any request", async () => {
    const fx = fetchReturning("{}", 200);
    const result = await createAlertmanagerWriteClient(BASE, { fetchImpl: fx.fetchImpl }).createSilence({
      ...VALID_CREATE,
      createdBy: "x".repeat(SOURCE_MAX_NAME_BYTES + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("invalid-shape");
    expect(fx.calls()).toBe(0);
  });
});

describe("recovery and failure-as-data (criterion 3)", () => {
  test("a non-2xx read never rejects and a later success recovers", async () => {
    const failure = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchReturning("upstream boom", 502).fetchImpl,
    }).alerts();
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("unreachable");
    expect(failure.error.kind).toBe("upstream-status");
    expect(failure.error.status).toBe(502);

    const recovered = await createAlertmanagerClient(BASE, {
      fetchImpl: fetchFromFixture("alerts-success.json").fetchImpl,
    }).alerts();
    expect(recovered.ok).toBe(true);
  });
});

describe("darkness and fixture hygiene (criterion 4)", () => {
  test("no apps/web production module selects or calls the dark write methods", () => {
    const serverRoot = join(REPO_ROOT, "apps", "web", "src", "server");
    // M2 write zone (J56): the mutation layer is allowed to reach the write client.
    const mutationsRoot = join(serverRoot, "mutations");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (full !== mutationsRoot) walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const text = readFileSync(full, "utf-8");
        if (/\bcreateSilence\b|\bexpireSilence\b|\bcreateAlertmanagerWriteClient\b|\bAlertmanagerWriteClient\b/.test(text)) {
          offenders.push(full);
        }
      }
    };
    walk(serverRoot);
    expect(offenders).toEqual([]);
  });

  test("no pinned alertmanager fixture leaks credentials or authorization headers", () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const text = fixtureText(name).toLowerCase();
      expect(text).not.toContain("authorization");
      expect(text).not.toContain("password");
      expect(text).not.toContain("secret");
      // No embedded userinfo credentials in any URL.
      expect(fixtureText(name)).not.toContain("@");
    }
  });
});
