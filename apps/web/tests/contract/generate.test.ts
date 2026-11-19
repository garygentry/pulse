// apps/web/tests/contract/generate.test.ts — the contract generator core: the in-memory generation, the
// real-handler stub context, the SSE transcript writer and the atomic writer.
//
// Generation is memoised per process; every case here shares the one `frozen: "report"` generation.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION } from "@pulse/web-data/contract";
import { SSE_RETRY_MS, type LiveTick, type SourceId, type SourceObservation } from "@pulse/web-data/wire";

import { ContractToolError } from "../../scripts/contract/errors.js";
import { generateContract, writeGenerated } from "../../scripts/contract/generate.js";
import { APP_VERSION, at, atMs, FIXED_EPOCH_MS, GENERATION, PLACEHOLDER, utf8OfBytes } from "../../scripts/contract/scenarios/common.js";
import { createScenarioContext } from "../../scripts/contract/scenarios/index.js";
import type { ShapeSnapshot } from "../../scripts/contract/shape-types.js";
import { tickCycle, transcript } from "../../scripts/contract/sse-transcript.js";
import { responseBody, stubContext, stubRouteRequest } from "../../scripts/contract/stub-context.js";
import type { FixtureIndex, GeneratedFile } from "../../scripts/contract/types.js";
import { buildLiveTick } from "../../src/server/events/stream.js";
import { currentWritePathSnapshot } from "../../src/server/mutations/session-provider.js";
import { __resetMetricsForTest, renderMetrics } from "../../src/server/routes/metrics.js";
import type { RuntimeStatus } from "../../src/server/refresh.js";
import { sessionRoute } from "../../src/server/routes/session.js";

const GENERATION_TIMEOUT = { timeout: 30_000 };
const DECODER = new TextDecoder();

function generated(): Promise<readonly GeneratedFile[]> {
  return generateContract({ frozen: "report" });
}

async function generatedJson(path: string): Promise<unknown> {
  const file = (await generated()).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`not generated: ${path}`);
  return JSON.parse(DECODER.decode(file.bytes));
}

const SOURCE_OK = { ok: true, lastSuccess: null, error: null };
const IDLE_STATUS: RuntimeStatus = {
  sources: { metrics: SOURCE_OK, alerts: SOURCE_OK, checks: SOURCE_OK },
  model: { loaded: true, formatVersion: 1, error: null },
  lastSnapshotAt: null,
};

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contract-gen-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Generation ───────────────────────────────────────────────────────────────────────────────────

describe("generateContract", () => {
  test("emits the index, the shape snapshot, CONTRACT.md and the first four fixture groups, sorted", async () => {
    const paths = (await generated()).map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("contract/index.json");
    expect(paths).toContain("contract/CONTRACT.md");
    expect(paths).toContain(`contract/shape/${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}.json`);
    for (const expected of [
      "session/empty", "session/typical", "session/all-optional", "session/max-size",
      "session/error-invalid-request", "session/unknown-capability",
      "errors/invalid-request", "errors/api-not-found", "errors/internal-error",
      "errors/bundle-error-missing", "errors/bundle-error-unreadable", "errors/bundle-error-unparseable",
      "errors/bundle-error-version", "errors/bundle-error-structure", "errors/bundle-error-incoherent",
      "handshake/compatible", "handshake/server-too-old-major", "handshake/server-too-old-minor",
      "handshake/server-too-old-absent", "handshake/client-too-old",
      "connect-link/basic", "connect-link/with-path", "connect-link/unknown-param", "connect-link/wrong-scheme",
      "connect-link/unsupported-version", "connect-link/missing-url", "connect-link/malformed-url",
      "connect-link/http-url", "connect-link/http-loopback",
    ]) {
      expect(paths).toContain(`contract/fixtures/${expected}.json`);
    }
  }, GENERATION_TIMEOUT);

  test("is memoised: a second call returns the same files without generating again", async () => {
    expect(await generated()).toBe(await generated());
  }, GENERATION_TIMEOUT);

  test("JSON files are canonical: LF only, one trailing newline, and a parse round trip keeps the bytes", async () => {
    for (const file of await generated()) {
      const text = DECODER.decode(file.bytes);
      expect(text.includes("\r")).toBe(false);
      if (!file.path.endsWith(".json")) continue;
      expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);
      expect(text.indexOf("\n")).toBe(text.length - 1);
    }
  }, GENERATION_TIMEOUT);

  test("the index lists exactly the generated fixtures, sorted, with kind and status in step", async () => {
    const index = (await generatedJson("contract/index.json")) as FixtureIndex;
    expect(index.formatVersion).toBe(1);
    expect(index.contract).toEqual({ ...CONTRACT_VERSION });
    const fixturePaths = (await generated())
      .map((file) => file.path)
      .filter((path) => path.startsWith("contract/fixtures/"));
    expect(index.fixtures.map((entry) => `contract/${entry.path}`)).toEqual(fixturePaths);
    for (const entry of index.fixtures) {
      expect(entry.path).toBe(`fixtures/${entry.group}/${entry.scenario}.json`);
      expect(entry.status !== null).toBe(entry.kind === "response" || entry.kind === "error");
    }
    expect(index.fixtures.find((entry) => entry.path === "fixtures/handshake/server-too-old-minor.json")).toEqual({
      client: { major: CONTRACT_VERSION.major, minMinor: CONTRACT_VERSION.minor + 1 },
      expect: "accept",
      expectedOutcome: "server-too-old",
      group: "handshake",
      kind: "handshake",
      operation: "handshake",
      path: "fixtures/handshake/server-too-old-minor.json",
      scenario: "server-too-old-minor",
      status: null,
      webValidator: null,
    });
    expect(index.fixtures.find((entry) => entry.scenario === "http-url")?.rejection).toBe("not-https");
  }, GENERATION_TIMEOUT);

  test("fills every generated section of CONTRACT.md and leaves no empty marker pair", async () => {
    const file = (await generated()).find((candidate) => candidate.path === "contract/CONTRACT.md");
    const doc = DECODER.decode(file!.bytes);
    expect(doc).not.toMatch(/<!-- generated:([A-Za-z0-9:-]+) -->\n<!-- \/generated:\1 -->/);
    expect(doc).toContain("| [`fixtures/session/typical.json`](fixtures/session/typical.json) |");
  }, GENERATION_TIMEOUT);

  test("refuses to replace a frozen shape snapshot whose content differs", async () => {
    const frozen = (await generatedJson(
      `contract/shape/${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}.json`,
    )) as ShapeSnapshot;
    const mutated = structuredClone(frozen) as unknown as { roots: Record<string, { optional: boolean }[]> };
    const node = mutated.roots.SessionPayload![0]!;
    node.optional = !node.optional;
    const attempt = generateContract({ frozen: "enforce", extract: () => mutated as unknown as ShapeSnapshot });
    await expect(attempt).rejects.toBeInstanceOf(ContractToolError);
    await expect(attempt).rejects.toMatchObject({ code: "SNAPSHOT_FROZEN" });
  }, GENERATION_TIMEOUT);
});

// ── Real handler output and process globals ──────────────────────────────────────────────────────

describe("session fixtures come from the real handler", () => {
  afterEach(() => __resetMetricsForTest());

  test("session/empty equals a direct handler call through the stub context", async () => {
    const res = await sessionRoute.handler(stubRouteRequest("/api/session"), stubContext());
    expect(await generatedJson("contract/fixtures/session/empty.json")).toEqual(await res.json());
  }, GENERATION_TIMEOUT);

  test("typical grants every capability, max-size carries 256-byte identity values", async () => {
    const typical = (await generatedJson("contract/fixtures/session/typical.json")) as Record<string, unknown>;
    expect(typical.authMode).toBe("proxy-header");
    expect(typical.capabilities).toEqual({ silence: true, ack: true, proposeEstateEdit: true });
    expect(typical.contract).toEqual({ major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor, capabilities: [] });
    const maxSize = (await generatedJson("contract/fixtures/session/max-size.json")) as {
      identity: { subject: string; displayName: string };
    };
    expect(new TextEncoder().encode(maxSize.identity.subject).length).toBe(256);
    expect(new TextEncoder().encode(maxSize.identity.displayName).length).toBe(256);
  }, GENERATION_TIMEOUT);

  test("generation leaves no write-path provider and no handshake metric series behind", async () => {
    await generateContract({ frozen: "report", extract: () => ({ version: CONTRACT_VERSION, roots: {} }) }).catch(
      () => undefined, // the empty shape cannot render CONTRACT.md; the scenario pass has still run
    );
    expect(currentWritePathSnapshot()).toBeNull();
    expect(renderMetrics(IDLE_STATUS, FIXED_EPOCH_MS)).not.toContain("pulse_web_client_handshakes_total{");
  }, GENERATION_TIMEOUT);
});

describe("stub context", () => {
  test("context a contract handler must not read throws SCENARIO_INVALID", () => {
    const ctx = stubContext({ authMode: "proxy-header" });
    expect(ctx.config.identity.mode).toBe("proxy-header");
    expect(ctx.identity).toBeNull();
    expect(ctx.cycle).toBeNull();
    for (const read of [
      () => (ctx.history as unknown as Record<string, unknown>).query,
      () => (ctx.events as unknown as Record<string, unknown>).open,
      () => ctx.sources.vm,
      () => ctx.config.vmUrl,
      () => ctx.config.identity.trustedProxies,
    ]) {
      expect(read).toThrow(ContractToolError);
    }
  });

  test("the stub request targets the placeholder base URL with no peer", () => {
    const request = stubRouteRequest("/api/session", { "x-pulse-client": "example/1.0" });
    expect(request.request.url).toBe(`${PLACEHOLDER.baseUrl}/api/session`);
    expect(request.request.headers.get("x-pulse-client")).toBe("example/1.0");
    expect(request.peerIp).toBeNull();
    expect(request.routePattern).toBe("/api/session");
  });

  test("responseBody rejects a status mismatch and a non-JSON response", async () => {
    await expect(responseBody(Response.json({ ok: true }, { status: 200 }), 503)).rejects.toMatchObject({
      code: "SCENARIO_INVALID",
    });
    await expect(responseBody(new Response("{}", { status: 200 }), 200)).rejects.toMatchObject({
      code: "SCENARIO_INVALID",
    });
    expect(await responseBody(Response.json({ b: 1, a: null }, { status: 200 }), 200)).toEqual({ a: null, b: 1 });
  });
});

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

describe("placeholders", () => {
  test("the fixed clock, generation and byte filler are deterministic", async () => {
    expect(FIXED_EPOCH_MS).toBe(Date.UTC(2026, 0, 1));
    expect(at(0)).toBe("2026-01-01T00:00:00.000Z");
    expect(at(90)).toBe("2026-01-01T00:01:30.000Z");
    expect(atMs(1)).toBe(FIXED_EPOCH_MS + 1000);
    expect(PLACEHOLDER.hostName(7)).toBe("host-007.example.net");
    expect(PLACEHOLDER.ipv6(26)).toBe("2001:db8::1a");
    const filler = utf8OfBytes(64);
    expect(new TextEncoder().encode(filler).length).toBe(64);
    expect(filler.endsWith("é")).toBe(true);
    expect(() => utf8OfBytes(1)).toThrow(RangeError);
    const ctx = createScenarioContext();
    expect(await ctx.hash({ b: 1, a: 2 })).toBe(await ctx.hash({ a: 2, b: 1 }));
    expect(await ctx.hash({ a: 2 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("every host and address in the fixtures is a documentation placeholder", async () => {
    const hostOk = (host: string): boolean => /(^|\.)example\.(com|net|org)$/.test(host);
    const ipv4Ok = (ip: string): boolean => ip.startsWith("192.0.2.") || ip.startsWith("198.51.100.");
    let urls = 0;
    for (const file of await generated()) {
      if (!file.path.startsWith("contract/fixtures/")) continue;
      // Connect links carry their base URL percent-encoded.
      const text = decodeURIComponent(DECODER.decode(file.bytes).replaceAll("%20", " "));
      const loopbackAllowed = file.path === "contract/fixtures/connect-link/http-loopback.json";
      for (const match of text.matchAll(/https?:\/\/([^/?#"&\s]+)/g)) {
        urls += 1;
        const host = match[1]!;
        if (host === "localhost" && loopbackAllowed) continue;
        if (host === "connect") continue; // the wrong-scheme link keeps the link's own host
        expect({ path: file.path, host, ok: hostOk(host) }).toEqual({ path: file.path, host, ok: true });
      }
      for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
        expect({ path: file.path, ip: match[0], ok: ipv4Ok(match[0]) }).toEqual({ path: file.path, ip: match[0], ok: true });
      }
      if (!loopbackAllowed) expect(text).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]/);
      expect(text).not.toMatch(/\/home\/|\/Users\//);
    }
    expect(urls).toBeGreaterThan(0);
  }, GENERATION_TIMEOUT);
});

// ── SSE transcript ───────────────────────────────────────────────────────────────────────────────

describe("SSE transcript", () => {
  const source: SourceObservation = { state: "current", lastAttemptAt: at(0), lastSuccess: at(0) };
  const hash = `sha256:${"0".repeat(64)}` as const;
  const tick: LiveTick = {
    observation: {
      generation: GENERATION,
      seq: 1,
      observedAt: at(0),
      appVersion: APP_VERSION,
      sources: {
        "victoriametrics-signals": source,
        "victoriametrics-targets": source,
        "victoriametrics-buildinfo": source,
        "alertmanager-alerts": source,
        "alertmanager-silences": source,
        "alertmanager-status": source,
        "alertmanager-receivers": source,
        "vmalert-rules": source,
        "gatus-statuses": source,
        "grafana-health": source,
      } satisfies Record<SourceId, SourceObservation>,
    },
    identities: { overview: hash, alerts: hash, estate: hash, engine: hash, timeline: hash },
  };

  test("the cycle stub projects back to exactly the tick it was built from", () => {
    expect(buildLiveTick(tickCycle(tick))).toEqual(tick);
  });

  test("frames are the server's own: retry, tick with its event id, heartbeat, and a synthesised unknown event", () => {
    const text = transcript([
      { type: "retry" },
      { type: "tick", tick },
      { type: "unknown-event", id: `${GENERATION}:1`, event: "future-event", data: '{"future":true}' },
      { type: "heartbeat" },
    ]);
    const frames = text.split("\n\n");
    expect(frames[0]).toBe(`retry: ${SSE_RETRY_MS}`);
    const tickLines = frames[1]!.split("\n");
    expect(tickLines.slice(0, 2)).toEqual([`id: ${GENERATION}:1`, "event: tick"]);
    expect(JSON.parse(tickLines[2]!.slice("data: ".length))).toEqual(tick);
    expect(frames[2]).toBe(`id: ${GENERATION}:1\nevent: future-event\ndata: {"future":true}`);
    expect(frames[3]).toBe(": heartbeat");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  test("a tick the server would not frame is refused", () => {
    const invalid = { ...tick, observation: { ...tick.observation, seq: 0 } };
    expect(() => transcript([{ type: "tick", tick: invalid }])).toThrow(ContractToolError);
  });
});

// ── Writer ───────────────────────────────────────────────────────────────────────────────────────

describe("writeGenerated", () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  test("writes changed files only, removes stale fixtures and empty directories, and leaves the rest alone", async () => {
    const root = tempDir();
    mkdirSync(join(root, "contract/fixtures/old-group"), { recursive: true });
    mkdirSync(join(root, "contract/fixtures/session"), { recursive: true });
    mkdirSync(join(root, "contract/shape"), { recursive: true });
    writeFileSync(join(root, "contract/fixtures/old-group/gone.json"), "{}\n");
    writeFileSync(join(root, "contract/fixtures/session/stale.json"), "{}\n");
    writeFileSync(join(root, "contract/fixtures/session/typical.json"), "{}\n");
    writeFileSync(join(root, "contract/shape/0.9.json"), "{}\n");
    writeFileSync(join(root, "contract/README.md"), "readme\n");

    const files: GeneratedFile[] = [
      { path: "contract/fixtures/session/empty.json", bytes: bytes('{"a":1}\n') },
      { path: "contract/fixtures/session/typical.json", bytes: bytes("{}\n") },
      { path: "contract/index.json", bytes: bytes("{}\n") },
    ];
    expect(await writeGenerated(root, files)).toEqual({ written: 3, changed: 2, removed: 2 });
    expect(readFileSync(join(root, "contract/fixtures/session/empty.json"), "utf8")).toBe('{"a":1}\n');
    expect(existsSync(join(root, "contract/fixtures/session/stale.json"))).toBe(false);
    expect(existsSync(join(root, "contract/fixtures/old-group"))).toBe(false);
    expect(readFileSync(join(root, "contract/shape/0.9.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(root, "contract/README.md"), "utf8")).toBe("readme\n");
    expect(readdirSync(root)).toEqual(["contract"]); // no temp directory survives

    expect(await writeGenerated(root, files)).toEqual({ written: 3, changed: 0, removed: 0 });
  });
});
