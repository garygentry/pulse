// mutations-proposals.test.ts — proposal.create body schema, validate hook, handler, and the proposal
// store's exclusive write and listFor (07-proposals-core-and-web.md §7–§8, §11; 10 §3.4). Handlers are
// driven directly with a stub ServerContext holding the proposals-parity V2 model. Route cases for
// GET /api/proposals are appended by item 024; registration is item 025.

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAndValidate } from "@pulse/core";
import {
  PROPOSAL_ID_RE,
  newProposalId,
  proposalFileName,
  resultFileName,
  type ProposalPayload,
} from "@pulse/core/proposals";
import { signProposal, verifyProposal } from "@pulse/core/proposals/sign";
import { buildWebEstateModel, type WebEstateModelV2 } from "@pulse/renderer";
import type { Identity } from "@pulse/web-data/identity";

import type { SecretProvider } from "../src/server/config.js";
import { zodIssuePaths } from "../src/server/mutations/guards.js";
import { createProposalBodySchema, createProposalMutation } from "../src/server/mutations/handlers/proposals.js";
import { resetWritePathProvider, setWritePathProvider } from "../src/server/mutations/session-provider.js";
import type { MutationHandlerMeta } from "../src/server/mutations/registry.js";
import {
  createProposalStore,
  currentProposalStore,
  resetProposalStoreProvider,
  setProposalStoreProvider,
  type ProposalStore,
} from "../src/server/mutations/stores/proposal-store.js";
import type { WritePath, WritePathReason, WritePathSnapshot, WritePathStore } from "../src/server/mutations/write-path.js";
import { proposalsRoute } from "../src/server/routes/proposals.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

const FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/proposals-parity");

function loadModel(): WebEstateModelV2 {
  const loaded = loadAndValidate(FIXTURE);
  if (!loaded.ok) throw new Error("parity fixture failed to load");
  const web = buildWebEstateModel(loaded.model);
  if (!web.ok) throw new Error("parity fixture tripped web safety");
  return web.value;
}
const MODEL = loadModel();
const CTX = { estate: { model: MODEL } } as unknown as ServerContext;
const NO_ESTATE = { estate: null } as unknown as ServerContext;

/** ≥ 32 UTF-8 bytes; the canary for REQ-SEC-04. */
const SECRET = "canary-proposal-secret-0123456789-abcdef";
/** A non-ASCII secret (multibyte UTF-8). */
const SECRET_NON_ASCII = "ключ-предложения-Ω-π-✓-0123456789";
const utf8 = new TextEncoder();

function secretOf(s: string | null): SecretProvider {
  return s === null
    ? { bytes: () => null, status: { present: false, reason: "secret-missing" } }
    : { bytes: () => utf8.encode(s), status: { present: true } };
}

type MarkCall = [string, string];
function fakeWritePath(): WritePath & { readonly marks: MarkCall[] } {
  const marks: MarkCall[] = [];
  return {
    marks,
    snapshot: () => ({}) as WritePathSnapshot,
    markFailed(store, reason) {
      marks.push([store, reason]);
    },
    probe: async () => ({}) as WritePathSnapshot,
  };
}

const ACTOR: Identity = { subject: "alice-subject", displayName: "Alice A.", source: "proxy-header" };
const NOW = new Date("2026-09-30T02:30:00.000Z");
const META: MutationHandlerMeta = { requestId: "5f0c7a52-3a8e-4f7b-9a53-8a0c2d9b1e44", now: NOW };
const RATIONALE = "Container metrics are needed for the new stack.";

/** A fixed random source → a deterministic proposal id (for collision injection). */
const fixedBytes = (b: readonly number[]) => () => Uint8Array.from(b);

let tmpRoots: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pulse-proposals-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: { kind: "host", id: "host:app-01" },
    changes: [{ field: "cadvisor", seen: false, proposed: true }],
    rationale: RATIONALE,
    ...over,
  };
}

function refusedPaths(input: unknown): string[] {
  const r = createProposalBodySchema.safeParse(input);
  if (r.success) throw new Error("expected the body to be refused");
  return zodIssuePaths(r.error.issues);
}

function parse(input: unknown) {
  const r = createProposalBodySchema.safeParse(input);
  if (!r.success) throw new Error(`expected the body to parse: ${JSON.stringify(r.error.issues)}`);
  return r.data;
}

/** A store that records calls and never touches the filesystem. */
function recordingStore(): ProposalStore & { readonly writes: ProposalPayload[] } {
  const writes: ProposalPayload[] = [];
  return {
    writes,
    async write(p) {
      writes.push(p);
      return { ok: false, error: "write-failed" };
    },
    async listFor() {
      return { enabled: false, proposals: [], invalidCount: 0 };
    },
  };
}

// ── body schema ────────────────────────────────────────────────────────────────────────────────────

describe("createProposalBodySchema (REQ-PROP-02, REQ-PROP-04, REQ-SEC-07)", () => {
  test("rationale bounds count code points, like the client: 300 emoji pass, 6 emoji fail", () => {
    expect(parse(body({ rationale: "😀".repeat(300) })).rationale).toBe("😀".repeat(300)); // 600 UTF-16 units
    expect(refusedPaths(body({ rationale: "😀".repeat(501) }))).toEqual(["rationale"]);
    expect(refusedPaths(body({ rationale: "😀".repeat(6) }))).toEqual(["rationale"]); // 12 UTF-16 units
  });

  test("a minimal valid body parses and the rationale is trimmed", () => {
    const b = parse(body({ rationale: `  ${RATIONALE}\n ` }));
    expect(b.rationale).toBe(RATIONALE);
  });

  test("0 and 6 changes are refused; 1 and 5 are accepted", () => {
    expect(refusedPaths(body({ changes: [] }))).toContain("changes");
    const five = [
      { field: "expectedChurn", seen: false, proposed: true },
      { field: "scrapeIntervalClass", seen: null, proposed: "slow" },
      { field: "cadvisor", seen: false, proposed: true },
      { field: "heartbeat", seen: true, proposed: false },
      { field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Parked host." } },
    ];
    expect(parse(body({ changes: five })).changes.length).toBe(5);
    expect(refusedPaths(body({ changes: [...five, five[0]] }))).toContain("changes");
  });

  test("a duplicate field, cadvisor on a service, and proposed === seen are refused", () => {
    const dup = [
      { field: "cadvisor", seen: false, proposed: true },
      { field: "cadvisor", seen: false, proposed: true },
    ];
    expect(refusedPaths(body({ changes: dup })).some((p) => p.startsWith("changes"))).toBe(true);
    expect(
      refusedPaths(body({ target: { kind: "service", id: "svc:app-01/api" }, changes: [{ field: "cadvisor", seen: false, proposed: true }] }))
        .some((p) => p.startsWith("changes")),
    ).toBe(true);
    expect(refusedPaths(body({ changes: [{ field: "cadvisor", seen: true, proposed: true }] })).some((p) => p.startsWith("changes"))).toBe(true);
  });

  test("proposed deep-equal to seen with key-reordered suppression marks is refused", () => {
    const changes = [
      {
        field: "suppressed",
        seen: { class: "known-expected", rationale: "Batch worker idles by design." },
        proposed: { rationale: "Batch worker idles by design.", class: "known-expected" },
      },
    ];
    expect(refusedPaths(body({ target: { kind: "service", id: "svc:app-01/batch" }, changes })).some((p) => p.startsWith("changes"))).toBe(true);
  });

  test("a 9- or 501-char trimmed rationale and a \\u0007 are refused; 10 and 500 pass", () => {
    expect(refusedPaths(body({ rationale: `  ${"x".repeat(9)}  ` }))).toEqual(["rationale"]);
    expect(refusedPaths(body({ rationale: "x".repeat(501) }))).toEqual(["rationale"]);
    expect(refusedPaths(body({ rationale: `bell here \u0007 please` }))).toEqual(["rationale"]);
    expect(parse(body({ rationale: "x".repeat(10) })).rationale).toBe("x".repeat(10));
    expect(parse(body({ rationale: "x".repeat(500) })).rationale.length).toBe(500);
    expect(parse(body({ rationale: "line one of it\nline two" })).rationale).toContain("\n");
  });

  test("a 248-byte target.id is refused on 'target.id'; 247 bytes passes", () => {
    const id248 = `host:${"é".repeat(121)}x`; // 5 + 242 + 1 = 248 bytes
    const id247 = `host:${"é".repeat(121)}`; // 5 + 242 = 247 bytes
    expect(utf8.encode(id248).byteLength).toBe(248);
    expect(utf8.encode(id247).byteLength).toBe(247);
    expect(refusedPaths(body({ target: { kind: "host", id: id248 } }))).toContain("target.id");
    expect(parse(body({ target: { kind: "host", id: id247 } })).target.id).toBe(id247);
  });

  test("unknown keys at the root, in target and in a change are refused (REQ-SEC-03)", () => {
    expect(createProposalBodySchema.safeParse({ ...body(), extra: 1 }).success).toBe(false);
    expect(createProposalBodySchema.safeParse(body({ target: { kind: "host", id: "host:app-01", name: "x" } })).success).toBe(false);
    expect(
      createProposalBodySchema.safeParse(body({ changes: [{ field: "cadvisor", seen: false, proposed: true, note: "x" }] })).success,
    ).toBe(false);
  });
});

// ── definition + validate ──────────────────────────────────────────────────────────────────────────

describe("proposal.create definition and validate (REQ-PROP-02, REQ-PROP-04)", () => {
  const def = createProposalMutation({ store: recordingStore() });

  test("method, path, capability, action, auditTarget and auditDetails", () => {
    expect([def.method, def.path, def.capability, def.action]).toEqual([
      "POST",
      "/api/mutations/proposals",
      "proposeEstateEdit",
      "proposal.create",
    ]);
    expect(def.body).toBe(createProposalBodySchema);
    const b = parse(body({ changes: [{ field: "cadvisor", seen: false, proposed: true }, { field: "heartbeat", seen: true, proposed: false }] }));
    expect(def.auditTarget(b)).toBe("host:host:app-01");
    expect(def.auditDetails(b)).toEqual({ fields: "cadvisor,heartbeat", rationale: RATIONALE });
  });

  test("heartbeat on a probe-only host → {ok:false, fields:['changes.0.field']}", () => {
    const b = parse(body({ target: { kind: "host", id: "host:edge-probe" }, changes: [{ field: "heartbeat", seen: true, proposed: false }] }));
    expect(def.validate?.(b, CTX, NOW)).toEqual({ ok: false, fields: ["changes.0.field"] });
  });

  test("suppressed on a standalone-covered service → {ok:false, fields:['changes.0.field']}", () => {
    const b = parse(
      body({
        target: { kind: "service", id: "svc:db-01/cache" },
        changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Cache restarts often." } }],
      }),
    );
    expect(def.validate?.(b, CTX, NOW)).toEqual({ ok: false, fields: ["changes.0.field"] });
  });

  test("an unresolvable target, or no estate, → {ok:true} (the handler reports entity-not-found)", () => {
    const b = parse(body({ target: { kind: "host", id: "host:nope" } }));
    expect(def.validate?.(b, CTX, NOW)).toEqual({ ok: true });
    expect(def.validate?.(parse(body()), NO_ESTATE, NOW)).toEqual({ ok: true });
  });

  test("applicable fields → {ok:true}", () => {
    expect(def.validate?.(parse(body()), CTX, NOW)).toEqual({ ok: true });
  });
});

// ── handler ────────────────────────────────────────────────────────────────────────────────────────

describe("proposal.create handler (REQ-PROP-02, REQ-PROP-05)", () => {
  test("unknown drilldown id or estate null → failed 404 TARGET_NOT_FOUND entity-not-found; nothing written", async () => {
    const store = recordingStore();
    const def = createProposalMutation({ store });
    const expected = { outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "entity-not-found" } as const;
    expect(await def.handler(parse(body({ target: { kind: "host", id: "host:nope" } })), CTX, ACTOR, META)).toEqual(expected);
    expect(await def.handler(parse(body({ target: { kind: "service", id: "host:app-01" }, changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Parked." } }] })), CTX, ACTOR, META)).toEqual(expected);
    expect(await def.handler(parse(body()), NO_ESTATE, ACTOR, META)).toEqual(expected);
    expect(store.writes).toEqual([]);
  });

  test("a stale seen → 409 INVALID_REQUEST stale-proposal with details.staleField; nothing written", async () => {
    const store = recordingStore();
    const def = createProposalMutation({ store });
    // db-01 declares cadvisor: true, so seen:false is stale.
    const b = parse(
      body({
        target: { kind: "host", id: "host:db-01" },
        changes: [
          { field: "expectedChurn", seen: true, proposed: false },
          { field: "cadvisor", seen: false, proposed: true },
        ],
      }),
    );
    expect(await def.handler(b, CTX, ACTOR, META)).toEqual({
      outcome: "failed",
      status: 409,
      code: "INVALID_REQUEST",
      reason: "stale-proposal",
      details: { staleField: "cadvisor" },
    });
    expect(store.writes).toEqual([]);
  });

  test("an inapplicable field reaching the handler (estate changed after validate) → stale-proposal", async () => {
    const def = createProposalMutation({ store: recordingStore() });
    const b = parse(body({ target: { kind: "host", id: "host:edge-probe" }, changes: [{ field: "heartbeat", seen: true, proposed: false }] }));
    const out = await def.handler(b, CTX, ACTOR, META);
    expect(out).toMatchObject({ status: 409, reason: "stale-proposal", details: { staleField: "heartbeat" } });
  });

  for (const [label, secret] of [
    ["ASCII", SECRET],
    ["non-ASCII", SECRET_NON_ASCII],
  ] as const) {
    test(`success (${label} secret) → 201 {proposalId}; the file verifies with the same secret (REQ-PROP-05, REQ-SEC-05)`, async () => {
      const dir = tmpDir();
      const wp = fakeWritePath();
      const def = createProposalMutation({ store: createProposalStore(dir, secretOf(secret), { writePath: wp }) });
      const b = parse(
        body({
          changes: [
            { field: "cadvisor", seen: false, proposed: true },
            { field: "scrapeIntervalClass", seen: null, proposed: "slow" },
          ],
        }),
      );
      const out = await def.handler(b, CTX, ACTOR, META);
      if (out.outcome !== "succeeded") throw new Error("expected success");
      expect(out.status).toBe(201);
      expect(out.result.proposalId).toMatch(PROPOSAL_ID_RE);
      expect(out.details).toEqual({ proposalId: out.result.proposalId });

      const path = join(dir, proposalFileName(out.result.proposalId));
      const bytes = readFileSync(path);
      // The CLI path encodes the secret with TextEncoder too (cross-tool).
      const v = verifyProposal(new Uint8Array(bytes), utf8.encode(secret));
      if (!v.ok) throw new Error(`verify failed: ${v.reason}`);
      const p = v.file.payload;
      expect(p.id).toBe(out.result.proposalId);
      expect(p.requestId).toBe(META.requestId);
      expect(p.createdAt).toBe(NOW.toISOString());
      expect(p.target).toEqual({ kind: "host", id: "host:app-01", name: "app-01" });
      expect(p.proposer).toEqual({ subject: ACTOR.subject, displayName: ACTOR.displayName });
      expect(p.changes).toEqual([
        { field: "cadvisor", seen: false, proposed: true },
        { field: "scrapeIntervalClass", seen: null, proposed: "slow" },
      ]);
      expect(bytes.toString("utf8").endsWith("}\n")).toBe(true);
      expect(readdirSync(dir)).toEqual([proposalFileName(out.result.proposalId)]); // no tmp left, no sidecar
      expect(wp.marks).toEqual([]);
      // A wrong secret does not verify.
      expect(verifyProposal(new Uint8Array(bytes), utf8.encode(`${secret}-other`)).ok).toBe(false);
    });
  }

  test("a service target records the core service name", async () => {
    const dir = tmpDir();
    const def = createProposalMutation({ store: createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() }) });
    const b = parse(
      body({
        target: { kind: "service", id: "svc:app-01/api" },
        changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Being migrated." } }],
      }),
    );
    const out = await def.handler(b, CTX, ACTOR, META);
    if (out.outcome !== "succeeded") throw new Error("expected success");
    const v = verifyProposal(readFileSync(join(dir, proposalFileName(out.result.proposalId))), utf8.encode(SECRET));
    if (!v.ok) throw new Error("verify failed");
    expect(v.file.payload.target).toEqual({ kind: "service", id: "svc:app-01/api", name: "api" });
  });
});

// ── store write ────────────────────────────────────────────────────────────────────────────────────

describe("proposal store exclusive write (REQ-PROP-01, REQ-PROP-05)", () => {
  test("an injected id collision → 500 write-failed, existing file unchanged, markFailed NOT called", async () => {
    const dir = tmpDir();
    const wp = fakeWritePath();
    const randomBytes = fixedBytes([0xde, 0xad, 0xbe, 0xef]);
    const def = createProposalMutation({ store: createProposalStore(dir, secretOf(SECRET), { writePath: wp }), randomBytes });
    const first = await def.handler(parse(body()), CTX, ACTOR, META);
    if (first.outcome !== "succeeded") throw new Error("expected success");
    expect(first.result.proposalId).toBe("p-20260930T023000Z-deadbeef");
    const path = join(dir, proposalFileName(first.result.proposalId));
    const before = readFileSync(path);

    const second = await def.handler(
      parse(body({ rationale: "A different rationale entirely." })),
      CTX,
      { ...ACTOR, displayName: "Mallory" },
      { ...META, requestId: "other-request" },
    );
    expect(second).toEqual({
      outcome: "failed",
      status: 500,
      code: "INTERNAL_ERROR",
      reason: "write-failed",
      details: { proposalId: first.result.proposalId },
    });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual([proposalFileName(first.result.proposalId)]);
    expect(wp.marks).toEqual([]);
  });

  test("an unwritable dir → 500 write-failed and markFailed('proposals','write-failed')", async () => {
    // Root-proof: a proposals dir that does not exist fails at the open step.
    const dir = join(tmpDir(), "missing", "proposals");
    const wp = fakeWritePath();
    const def = createProposalMutation({ store: createProposalStore(dir, secretOf(SECRET), { writePath: wp }) });
    const out = await def.handler(parse(body()), CTX, ACTOR, META);
    expect(out).toMatchObject({ outcome: "failed", status: 500, code: "INTERNAL_ERROR", reason: "write-failed" });
    expect(wp.marks).toEqual([["proposals", "write-failed"]]);
  });

  test("secret null → write-failed with no markFailed and no file", async () => {
    const dir = tmpDir();
    const wp = fakeWritePath();
    const store = createProposalStore(dir, secretOf(null), { writePath: wp });
    const def = createProposalMutation({ store });
    const out = await def.handler(parse(body()), CTX, ACTOR, META);
    expect(out).toMatchObject({ status: 500, reason: "write-failed" });
    expect(readdirSync(dir)).toEqual([]);
    expect(wp.marks).toEqual([]);
  });
});

// ── store listFor ──────────────────────────────────────────────────────────────────────────────────

let seq = 0;
function payloadFor(targetId: string, name: string, at: Date, subject = "bob-subject"): ProposalPayload {
  const n = seq++;
  return {
    id: newProposalId(at, () => Uint8Array.of(0, 0, (n >> 8) & 0xff, n & 0xff)),
    createdAt: at.toISOString(),
    requestId: randomUUID(),
    proposer: { subject, displayName: "Bob B." },
    target: { kind: "host", id: targetId, name },
    changes: [{ field: "expectedChurn", seen: true, proposed: false }],
    rationale: "Churn is no longer expected here.",
  };
}

function writeSidecar(dir: string, id: string, sidecar: unknown): void {
  writeFileSync(join(dir, resultFileName(id)), `${JSON.stringify(sidecar, null, 2)}\n`);
}

describe("proposal store listFor (REQ-PROP-06, REQ-SEC-05)", () => {
  test("newest first, capped at 50, other-target files excluded, subject never present", async () => {
    const dir = tmpDir();
    const store = createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() });
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    for (let i = 0; i < 55; i++) {
      expect((await store.write(payloadFor("host:db-01", "db-01", new Date(base + i * 60_000)))).ok).toBe(true);
    }
    // Two proposals in the same second: tie broken by id descending.
    const tieAt = new Date(base + 100 * 60_000);
    const tieA = payloadFor("host:db-01", "db-01", tieAt);
    const tieB = payloadFor("host:db-01", "db-01", tieAt);
    await store.write(tieA);
    await store.write(tieB);
    await store.write(payloadFor("host:app-01", "app-01", new Date(base + 200 * 60_000)));

    const list = await store.listFor("host", "host:db-01");
    expect(list.enabled).toBe(true);
    expect(list.invalidCount).toBe(0);
    expect(list.proposals.length).toBe(50);
    expect(list.proposals[0]?.id).toBe([tieA.id, tieB.id].sort().reverse()[0]);
    expect(list.proposals[1]?.id).toBe([tieA.id, tieB.id].sort()[0]);
    for (let i = 1; i < list.proposals.length; i++) {
      const [a, b] = [list.proposals[i - 1]!, list.proposals[i]!];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)).toBe(true);
    }
    expect(list.proposals.every((p) => p.state === "pending" && p.reason === null && p.commit === null)).toBe(true);
    expect(list.proposals[0]?.proposer).toBe("Bob B.");
    expect(JSON.stringify(list)).not.toContain("subject");
    expect(JSON.stringify(list)).not.toContain("bob-subject");

    const other = await store.listFor("host", "host:app-01");
    expect(other.proposals.map((p) => p.id).length).toBe(1);
    expect((await store.listFor("service", "host:db-01")).proposals).toEqual([]);
    expect((await store.listFor("host", "host:unknown")).proposals).toEqual([]);
  });

  test("forged, oversize, symlinked and misnamed files count in invalidCount; foreign names are ignored", async () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const store = createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() });
    const at = new Date("2026-09-02T00:00:00.000Z");
    const good = payloadFor("host:db-01", "db-01", at);
    await store.write(good);

    // forged: signed with a different secret
    const forged = payloadFor("host:db-01", "db-01", at);
    writeFileSync(join(dir, proposalFileName(forged.id)), JSON.stringify(signProposal(forged, utf8.encode(`${SECRET}-forger`))));
    // oversize: a valid name with > 64 KiB of content
    const big = payloadFor("host:db-01", "db-01", at);
    writeFileSync(join(dir, proposalFileName(big.id)), " ".repeat(64 * 1024 + 1));
    // symlinked: a validly signed file outside the dir, linked in under its own id
    const linked = payloadFor("host:db-01", "db-01", at);
    const outsidePath = join(outside, proposalFileName(linked.id));
    writeFileSync(outsidePath, JSON.stringify(signProposal(linked, utf8.encode(SECRET))));
    symlinkSync(outsidePath, join(dir, proposalFileName(linked.id)));
    // misnamed: a validly signed file stored under another id's name
    const renamedTo = payloadFor("host:db-01", "db-01", at);
    writeFileSync(join(dir, proposalFileName(renamedTo.id)), readFileSync(join(dir, proposalFileName(good.id))));
    // tampered: a one-field payload edit
    const tampered = payloadFor("host:db-01", "db-01", at);
    const signed = signProposal(tampered, utf8.encode(SECRET));
    writeFileSync(
      join(dir, proposalFileName(tampered.id)),
      JSON.stringify({ ...signed, payload: { ...signed.payload, rationale: "Tampered rationale text." } }),
    );
    // ignored: not a proposal file name
    writeFileSync(join(dir, "README.txt"), "not a proposal");
    writeFileSync(join(dir, "p-bad.proposal.json"), "{}");

    const list = await store.listFor("host", "host:db-01");
    expect(list.proposals.map((p) => p.id)).toEqual([good.id]);
    expect(list.invalidCount).toBe(5);
    // invalidCount spans every target
    expect((await store.listFor("host", "host:app-01")).invalidCount).toBe(5);
  });

  test("a valid sidecar → applied+commit / rejected+reason; an invalid sidecar → not shown and invalidCount++ (as the CLI)", async () => {
    const dir = tmpDir();
    const store = createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() });
    const base = Date.parse("2026-09-03T00:00:00.000Z");
    const [applied, rejected, badShape, wrongId, symSide, pending] = [0, 1, 2, 3, 4, 5].map((i) =>
      payloadFor("host:db-01", "db-01", new Date(base + i * 1000)),
    ) as [ProposalPayload, ProposalPayload, ProposalPayload, ProposalPayload, ProposalPayload, ProposalPayload];
    for (const p of [applied, rejected, badShape, wrongId, symSide, pending]) await store.write(p);
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const at = "2026-09-04T00:00:00.000Z";
    writeSidecar(dir, applied.id, { format: "pulse-proposal-result/v1", id: applied.id, state: "applied", at, by: "gary", commit });
    writeSidecar(dir, rejected.id, {
      format: "pulse-proposal-result/v1",
      id: rejected.id,
      state: "rejected",
      at,
      by: "gary",
      reason: "Not needed after the migration.",
    });
    writeSidecar(dir, badShape.id, { format: "pulse-proposal-result/v1", id: badShape.id, state: "applied", at, by: "gary" });
    writeSidecar(dir, wrongId.id, { format: "pulse-proposal-result/v1", id: applied.id, state: "applied", at, by: "gary", commit });
    const sideOutside = join(tmpDir(), "side.json");
    writeFileSync(sideOutside, JSON.stringify({ format: "pulse-proposal-result/v1", id: symSide.id, state: "applied", at, by: "gary", commit }));
    symlinkSync(sideOutside, join(dir, resultFileName(symSide.id)));

    const list = await store.listFor("host", "host:db-01");
    const byId = new Map(list.proposals.map((p) => [p.id, p]));
    expect(byId.get(applied.id)).toMatchObject({ state: "applied", commit, reason: null });
    expect(byId.get(rejected.id)).toMatchObject({ state: "rejected", reason: "Not needed after the migration.", commit: null });
    expect(byId.get(pending.id)).toMatchObject({ state: "pending", reason: null, commit: null });
    for (const p of [badShape, wrongId, symSide]) expect(byId.has(p.id)).toBe(false);
    expect(list.invalidCount).toBe(3);
  });

  test("secret null or a missing dir → {enabled:false, proposals:[], invalidCount:0}", async () => {
    const dir = tmpDir();
    await createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() }).write(
      payloadFor("host:db-01", "db-01", new Date("2026-09-05T00:00:00.000Z")),
    );
    const disabled = { enabled: false, proposals: [], invalidCount: 0 };
    expect(await createProposalStore(dir, secretOf(null), { writePath: fakeWritePath() }).listFor("host", "host:db-01")).toEqual(disabled);
    const wp = fakeWritePath();
    expect(await createProposalStore(join(dir, "missing"), secretOf(SECRET), { writePath: wp }).listFor("host", "host:db-01")).toEqual(
      disabled,
    );
    expect(wp.marks).toEqual([]); // reads never markFailed
  });

  test("a wrong secret counts every file invalid and lists nothing", async () => {
    const dir = tmpDir();
    await createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() }).write(
      payloadFor("host:db-01", "db-01", new Date("2026-09-06T00:00:00.000Z")),
    );
    const list = await createProposalStore(dir, secretOf(SECRET_NON_ASCII), { writePath: fakeWritePath() }).listFor("host", "host:db-01");
    expect(list).toEqual({ enabled: true, proposals: [], invalidCount: 1 });
  });
});

// ── provider seam ──────────────────────────────────────────────────────────────────────────────────

describe("proposal store provider seam (07 §8.4)", () => {
  afterEach(() => resetProposalStoreProvider());

  test("default null; set installs; reset restores null", () => {
    expect(currentProposalStore()).toBeNull();
    const store = recordingStore();
    setProposalStoreProvider(store);
    expect(currentProposalStore()).toBe(store);
    setProposalStoreProvider(null);
    expect(currentProposalStore()).toBeNull();
    setProposalStoreProvider(store);
    resetProposalStoreProvider();
    expect(currentProposalStore()).toBeNull();
  });
});

// ── secret canary ──────────────────────────────────────────────────────────────────────────────────

describe("secret canary (REQ-SEC-04)", () => {
  let logSpy: ReturnType<typeof spyOn> | null = null;
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    logSpy?.mockRestore();
    logSpy = null;
  });

  for (const secret of [SECRET, SECRET_NON_ASCII]) {
    test(`the secret and its hex/base64 forms appear in no file, handler result, list body or log line (${secret.length} chars)`, async () => {
      const dir = tmpDir();
      const wp = fakeWritePath();
      const store = createProposalStore(dir, secretOf(secret), { writePath: wp });
      const def = createProposalMutation({ store, randomBytes: fixedBytes([1, 2, 3, 4]) });
      const results = [
        await def.handler(parse(body()), CTX, ACTOR, META),
        await def.handler(parse(body()), CTX, ACTOR, META), // collision → write-failed
        await def.handler(parse(body({ target: { kind: "host", id: "host:nope" } })), CTX, ACTOR, META),
        await createProposalMutation({ store: createProposalStore(join(dir, "missing"), secretOf(secret), { writePath: wp }) }).handler(
          parse(body()),
          CTX,
          ACTOR,
          META,
        ),
      ];
      const list = await store.listFor("host", "host:app-01");
      expect(list.proposals.length).toBe(1);

      const raw = Buffer.from(secret, "utf8");
      const forms = [secret, raw.toString("hex"), raw.toString("base64"), raw.toString("base64url")];
      const haystacks = [
        ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(dir, e.name), "utf8")),
        JSON.stringify(results),
        JSON.stringify(list),
        JSON.stringify(store),
        ...logged,
      ];
      expect(haystacks.length).toBeGreaterThan(3);
      for (const h of haystacks) for (const f of forms) expect(h.includes(f)).toBe(false);
    });
  }
});

// ── GET /api/proposals route (item 024) ─────────────────────────────────────────────────────────────

const OK_STORE = { ok: true, reason: null } as const;
function healthySnapshot(down: Partial<Record<WritePathStore, WritePathReason>> = {}): WritePathSnapshot {
  const s = (store: WritePathStore) => (down[store] === undefined ? OK_STORE : { ok: false, reason: down[store]! });
  return { audit: s("audit"), acks: s("acks"), proposals: s("proposals"), secret: s("secret"), alertmanager: s("alertmanager") };
}

function routeCtx(identity: Identity | null, mode: "proxy-header" | "none" = "proxy-header"): ServerContext {
  return { identity, config: { identity: { mode } } } as unknown as ServerContext;
}

function getProposals(query: string, ctx: ServerContext = routeCtx(ACTOR)): Promise<Response> {
  const req: RouteRequest<"/api/proposals"> = {
    request: new Request(`http://pulse.test/api/proposals${query}`, { headers: { host: "pulse.test" } }),
    params: {},
    routePattern: "/api/proposals",
    peerIp: null,
    disableTimeout: () => undefined,
  };
  return Promise.resolve(proposalsRoute.handler(req, ctx));
}

async function expect400(query: string, param: "kind" | "id"): Promise<void> {
  const res = await getProposals(query);
  expect(res.status).toBe(400);
  const b = (await res.json()) as { code: string; details?: { param?: string } };
  expect(b.code).toBe("INVALID_REQUEST");
  expect(b.details?.param).toBe(param);
}

const DISABLED_BODY = { enabled: false, proposals: [], invalidCount: 0 };

describe("GET /api/proposals (REQ-PROP-06, REQ-UX-01)", () => {
  afterEach(() => {
    resetWritePathProvider();
    resetProposalStoreProvider();
  });

  test("route is GET /api/proposals", () => {
    expect(proposalsRoute.method).toBe("GET");
    expect(proposalsRoute.path).toBe("/api/proposals");
  });

  test("missing, duplicate or invalid kind → 400 INVALID_REQUEST param kind (REQ-SEC-07)", async () => {
    await expect400("?id=host:db-01", "kind");
    await expect400("?kind=host&kind=host&id=host:db-01", "kind");
    await expect400("?kind=entity&id=host:db-01", "kind");
    await expect400("?kind=&id=host:db-01", "kind");
  });

  test("missing, duplicate, oversize, control-char, wrong-prefix or malformed id → 400 param id (REQ-SEC-07)", async () => {
    const id248 = `host:${"é".repeat(121)}x`; // 248 UTF-8 bytes
    const id247 = `host:${"é".repeat(121)}`; // 247 bytes — well-formed
    await expect400("?kind=host", "id");
    await expect400("?kind=host&id=host:db-01&id=host:db-01", "id");
    await expect400(`?kind=host&id=${encodeURIComponent(id248)}`, "id");
    await expect400(`?kind=host&id=${encodeURIComponent("host:db\u000701")}`, "id");
    await expect400(`?kind=host&id=${encodeURIComponent("host:db\u008501")}`, "id");
    await expect400("?kind=host&id=svc:app-01/api", "id");
    await expect400("?kind=service&id=host:db-01", "id");
    await expect400("?kind=host&id=host:", "id");
    await expect400("?kind=service&id=svc:", "id");
    await expect400("?kind=service&id=svc:app-01", "id");
    expect((await getProposals(`?kind=host&id=${encodeURIComponent(id247)}`)).status).toBe(200);
  });

  test("no installed store (auth mode none) → 200 enabled:false even with a healthy provider", async () => {
    setWritePathProvider(() => healthySnapshot());
    for (const ctx of [routeCtx(ACTOR, "none"), routeCtx(ACTOR)]) {
      const res = await getProposals("?kind=host&id=host:db-01", ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual(DISABLED_BODY);
    }
  });

  test("proposeEstateEdit false (no identity, no provider, unhealthy secret/proposals, none mode) → enabled:false (REQ-AUTHZ-02)", async () => {
    // A store that WOULD list something, so an enabled:false answer proves the capability gate.
    const store: ProposalStore = {
      write: async () => ({ ok: false, error: "write-failed" }),
      listFor: async () => ({ enabled: true, proposals: [], invalidCount: 7 }),
    };
    setProposalStoreProvider(store);
    const cases: ReadonlyArray<readonly [ServerContext, WritePathSnapshot | null]> = [
      [routeCtx(ACTOR), null], // no provider installed
      [routeCtx(null), healthySnapshot()], // no trusted identity
      [routeCtx(ACTOR, "none"), healthySnapshot()],
      [routeCtx(ACTOR), healthySnapshot({ secret: "secret-missing" })],
      [routeCtx(ACTOR), healthySnapshot({ secret: "secret-too-short" })],
      [routeCtx(ACTOR), healthySnapshot({ proposals: "unwritable" })],
      [routeCtx(ACTOR), healthySnapshot({ audit: "write-failed" })],
    ];
    for (const [ctx, snap] of cases) {
      if (snap === null) resetWritePathProvider();
      else setWritePathProvider(() => snap);
      const res = await getProposals("?kind=host&id=host:db-01", ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual(DISABLED_BODY);
    }
    // Positive control: the same store with a healthy provider and trusted identity is consulted.
    setWritePathProvider(() => healthySnapshot());
    expect(await (await getProposals("?kind=host&id=host:db-01")).json()).toEqual({ enabled: true, proposals: [], invalidCount: 7 });
  });

  test("installed store + healthy provider + trusted proxy-header identity → store.listFor body, no subject (REQ-SEC-06)", async () => {
    const dir = tmpDir();
    const store = createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() });
    const at = new Date("2026-09-03T00:00:00.000Z");
    expect((await store.write(payloadFor("host:db-01", "db-01", at))).ok).toBe(true);
    expect((await store.write(payloadFor("host:db-01", "db-01", new Date(at.getTime() + 1000)))).ok).toBe(true);
    setProposalStoreProvider(store);
    setWritePathProvider(() => healthySnapshot());
    expect(currentProposalStore()).toBe(store);

    const res = await getProposals("?kind=host&id=host:db-01");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(await store.listFor("host", "host:db-01"))));
    const parsed = JSON.parse(text) as { enabled: boolean; proposals: unknown[] };
    expect(parsed.enabled).toBe(true);
    expect(parsed.proposals).toHaveLength(2);
    expect(text).not.toContain("subject");
    expect(text).not.toContain("bob-subject");
  });

  test("an unknown but well-formed id → 200 enabled:true with an empty list (no existence leak)", async () => {
    const dir = tmpDir();
    const store = createProposalStore(dir, secretOf(SECRET), { writePath: fakeWritePath() });
    await store.write(payloadFor("host:db-01", "db-01", new Date("2026-09-04T00:00:00.000Z")));
    setProposalStoreProvider(store);
    setWritePathProvider(() => healthySnapshot());
    for (const q of ["?kind=host&id=host:does-not-exist", "?kind=service&id=svc:nowhere/nothing"]) {
      const res = await getProposals(q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, proposals: [], invalidCount: 0 });
    }
  });
});
