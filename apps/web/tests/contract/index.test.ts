// apps/web/tests/contract/index.test.ts — the committed fixture index against the committed fixture files:
// the two list each other exactly, and the handshake, connect-link and transcript fixtures agree with the
// runtime functions a client ports.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTRACT_VERSION,
  decideCompatibility,
  KNOWN_LINK_PARAMS,
  parseConnectLink,
  type CompatibilityOutcome,
} from "@pulse/web-data/contract";
import type { ContractHandshake, LiveTick } from "@pulse/web-data/wire";

import { SCENARIO_MODULES } from "../../scripts/contract/scenarios/index.js";
import { tickCycle } from "../../scripts/contract/sse-transcript.js";
import type { ConnectLinkFixture, FixtureIndex, FixtureIndexEntry, HandshakeFixture } from "../../scripts/contract/types.js";
import { buildLiveTick } from "../../src/server/events/stream.js";
import { REPO_ROOT } from "./generated.js";

const CONTRACT_DIR = join(REPO_ROOT, "contract");
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const INDEX = JSON.parse(readFileSync(join(CONTRACT_DIR, "index.json"), "utf8")) as FixtureIndex;

/** Paths relative to `contract/` of every file under `dir`, forward slashes. */
function walk(dir: string): string[] {
  return readdirSync(join(CONTRACT_DIR, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const FILES = walk("fixtures").sort(byCodeUnit);

function fixtureText(entry: FixtureIndexEntry): string {
  return readFileSync(join(CONTRACT_DIR, entry.path), "utf8");
}

function entriesOf(group: string): readonly FixtureIndexEntry[] {
  const entries = INDEX.fixtures.filter((entry) => entry.group === group);
  expect(entries.length).toBeGreaterThan(0);
  return entries;
}

describe("index and files", () => {
  test("every fixture file is indexed and every entry's file exists", () => {
    expect(INDEX.fixtures.map((entry) => entry.path)).toEqual(FILES);
  });

  test("paths derive from group and scenario, slugs are well-formed and unique, entries are sorted", () => {
    const operations = new Map(SCENARIO_MODULES.map((module) => [module.group as string, module.operation]));
    const seen = new Set<string>();
    for (const entry of INDEX.fixtures) {
      const extension = entry.kind === "stream" ? "sse" : "json";
      expect(entry.path).toBe(`fixtures/${entry.group}/${entry.scenario}.${extension}`);
      expect(entry.scenario).toMatch(SLUG);
      expect(entry.operation).toBe(operations.get(entry.group)!);
      expect(seen.has(`${entry.group}/${entry.scenario}`)).toBe(false);
      seen.add(`${entry.group}/${entry.scenario}`);
    }
    const paths = INDEX.fixtures.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort(byCodeUnit));
    expect(new Set<string>(INDEX.fixtures.map((entry) => entry.group))).toEqual(new Set(operations.keys()));
  });

  test("the index carries the contract version", () => {
    expect(INDEX.formatVersion).toBe(1);
    expect(INDEX.contract).toEqual({ ...CONTRACT_VERSION });
  });

  test("kind, status, expect and rejection agree", () => {
    const REJECTABLE: ReadonlySet<string> = new Set(["connect-link", "request"]);
    for (const entry of INDEX.fixtures) {
      const hasStatus = entry.kind === "response" || entry.kind === "error";
      expect(`${entry.path} ${typeof entry.status}`).toBe(`${entry.path} ${hasStatus ? "number" : "object"}`);
      if (entry.kind === "response") expect(entry.status).toBe(entry.group === "push-pairing" ? 201 : 200);
      if (entry.kind === "error") expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.path.endsWith(".sse")).toBe(entry.kind === "stream");
      if (entry.expect === "reject") expect(REJECTABLE.has(entry.kind)).toBe(true);
      expect(entry.kind === "handshake").toBe(entry.group === "handshake");
      expect(entry.kind === "connect-link").toBe(entry.group === "connect-link");
      expect(entry.kind === "payload").toBe(entry.group === "push-payload");
      if (entry.kind === "payload") expect(entry.expect).toBe("accept");
      if (entry.kind === "request") expect(["push-pairing", "push-device"]).toContain(entry.group);
      expect(entry.client !== undefined && entry.expectedOutcome !== undefined).toBe(entry.kind === "handshake");
      expect(entry.rejection !== undefined).toBe(REJECTABLE.has(entry.kind) && entry.expect === "reject");
      if (entry.kind === "request" && entry.expect === "reject") expect(entry.rejection).toBe("INVALID_REQUEST");
      if (entry.group.startsWith("push-")) expect(entry.webValidator).toBeNull();
    }
  });

  test("JSON fixtures parse and end with one newline", () => {
    for (const entry of INDEX.fixtures) {
      if (entry.kind === "stream") continue;
      const text = fixtureText(entry);
      expect(text.endsWith("\n") && text.indexOf("\n") === text.length - 1).toBe(true);
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  test("the fixture set stays within 8 MiB", () => {
    const total = FILES.reduce((sum, path) => sum + readFileSync(join(CONTRACT_DIR, path)).length, 0);
    if (total > MAX_FIXTURE_BYTES) {
      throw new Error(`fixture set exceeds 8 MiB (${total} bytes); split max-size per collection`);
    }
    expect(total).toBeGreaterThan(0);
  });
});

describe("handshake fixtures", () => {
  test("the compatibility decision equals the expected outcome in the index and in the body", () => {
    const outcomes = new Set<CompatibilityOutcome>();
    for (const entry of entriesOf("handshake")) {
      const body = JSON.parse(fixtureText(entry)) as HandshakeFixture;
      const session = body.session as { readonly contract?: Pick<ContractHandshake, "major" | "minor"> };
      const decided = decideCompatibility(body.client, session.contract);
      expect([entry.path, decided]).toEqual([entry.path, entry.expectedOutcome!]);
      expect(body.expectedOutcome).toBe(decided);
      expect(entry.client).toEqual(body.client);
      outcomes.add(decided);
    }
    expect(outcomes).toEqual(new Set<CompatibilityOutcome>(["compatible", "server-too-old", "client-too-old"]));
  });

  test("a server that predates the contract is covered", () => {
    const absent = entriesOf("handshake").filter(
      (entry) => !Object.hasOwn((JSON.parse(fixtureText(entry)) as { session: object }).session, "contract"),
    );
    expect(absent.map((entry) => entry.expectedOutcome)).toEqual(["server-too-old"]);
  });
});

describe("connect-link fixtures", () => {
  test("the link parser agrees with every fixture and its index entry", () => {
    const verdicts = new Set<string>();
    let unknownParamAccepted = false;
    for (const entry of entriesOf("connect-link")) {
      const body = JSON.parse(fixtureText(entry)) as ConnectLinkFixture;
      const parsed = parseConnectLink(body.link);
      expect([entry.path, parsed.ok]).toEqual([entry.path, body.expect === "accept"]);
      expect(entry.expect).toBe(body.expect);
      if (parsed.ok) {
        expect(parsed.baseUrl).toBe(body.baseUrl!);
        expect(body.rejection).toBeUndefined();
        expect(entry.rejection).toBeUndefined();
        const names = [...new URL(body.link).searchParams.keys()].filter((name) => name !== "v" && name !== "url");
        if (names.some((name) => !KNOWN_LINK_PARAMS.includes(name))) unknownParamAccepted = true;
      } else {
        expect([entry.path, parsed.rejection]).toEqual([entry.path, body.rejection!]);
        expect(entry.rejection).toBe(parsed.rejection);
        expect(body.baseUrl).toBeUndefined();
      }
      verdicts.add(body.expect);
    }
    expect(verdicts).toEqual(new Set(["accept", "reject"]));
    expect(unknownParamAccepted).toBe(true);
  });
});

describe("event transcripts", () => {
  test("every tick frame projects back from a cycle to exactly itself", () => {
    const transcripts = entriesOf("events").filter((entry) => entry.kind === "stream");
    expect(transcripts.length).toBeGreaterThan(0);
    let ticks = 0;
    for (const entry of transcripts) {
      for (const frame of fixtureText(entry).split("\n\n")) {
        const lines = frame.split("\n");
        if (!lines.includes("event: tick")) continue;
        const data = lines.filter((line) => line.startsWith("data: "));
        expect(data).toHaveLength(1);
        const tick = JSON.parse(data[0]!.slice("data: ".length)) as LiveTick;
        expect(buildLiveTick(tickCycle(tick))).toEqual(tick);
        ticks += 1;
      }
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
