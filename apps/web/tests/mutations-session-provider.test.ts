// apps/web/tests/mutations-session-provider.test.ts — the process-wide write-path provider seam and
// the /healthz writePath block (mutation-foundation 04 §5.1, §6; REQ-AUTHZ-02, REQ-CFG-02/03,
// REQ-OBS-02). The provider is process-global, so every test resets it in afterEach.

import { afterEach, describe, expect, test } from "bun:test";

import type { Identity } from "@pulse/web-data/identity";

import { healthzRoute } from "../src/server/routes/healthz.js";
import { setRuntimeStatus, type RuntimeStatus } from "../src/server/refresh.js";
import {
  currentCapabilities,
  currentHealthWritePath,
  currentWritePathSnapshot,
  resetWritePathProvider,
  setWritePathProvider,
} from "../src/server/mutations/session-provider.js";
import type { WritePathReason, WritePathSnapshot, WritePathStore } from "../src/server/mutations/write-path.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";
import type { HealthBody, SourceHealth } from "../src/shared/snapshot.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const OK = { ok: true, reason: null } as const;
function snapshot(down: Partial<Record<WritePathStore, WritePathReason>> = {}): WritePathSnapshot {
  const s = (store: WritePathStore) => (down[store] === undefined ? OK : { ok: false, reason: down[store]! });
  return { audit: s("audit"), acks: s("acks"), proposals: s("proposals"), secret: s("secret"), alertmanager: s("alertmanager") };
}

const ALICE: Identity = { subject: "alice", displayName: "alice", source: "proxy-header" };
const ALL_FALSE = { silence: false, ack: false, proposeEstateEdit: false };
const ALL_TRUE = { silence: true, ack: true, proposeEstateEdit: true };

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: "2026-09-29T12:00:00.000Z", error: null, ...over };
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: Date.parse("2026-09-29T12:00:00.000Z"),
    ...over,
  };
}

function routeReq(path: string): RouteRequest {
  return {
    request: new Request(`http://pulse.test${path}`),
    params: {},
    routePattern: path,
    peerIp: null,
    disableTimeout() {},
  };
}

/** A ServerContext carrying only the auth mode (the one field /healthz reads). */
function ctxFor(mode: "none" | "proxy-header"): ServerContext {
  return { config: { identity: { mode } } } as unknown as ServerContext;
}

async function healthz(ctx: ServerContext): Promise<{ res: Response; body: HealthBody }> {
  const res = await healthzRoute.handler(routeReq("/healthz"), ctx);
  return { res, body: (await res.json()) as HealthBody };
}

const throwing = (): WritePathSnapshot => {
  throw new Error("provider boom");
};

// ── Provider seam ────────────────────────────────────────────────────────────────────────────────

describe("session-provider: fail-closed capabilities (REQ-AUTHZ-02, REQ-CFG-03)", () => {
  afterEach(() => resetWritePathProvider());

  test("default (no provider): snapshot null and every capability false (REQ-AUTHZ-02)", () => {
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
  });

  test("an installed healthy provider enables a trusted proxy-header identity (positive control)", () => {
    setWritePathProvider(() => snapshot());
    expect(currentWritePathSnapshot()).toEqual(snapshot());
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_TRUE);
    expect(currentCapabilities(null, "proxy-header")).toEqual(ALL_FALSE);
    expect(currentCapabilities(ALICE, "none")).toEqual(ALL_FALSE);
  });

  test("setWritePathProvider(null) and resetWritePathProvider() both restore the all-false default", () => {
    setWritePathProvider(() => snapshot());
    setWritePathProvider(null);
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);

    setWritePathProvider(() => snapshot());
    resetWritePathProvider();
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
  });

  test("a throwing provider fails closed: all capabilities false, health not-configured (REQ-AUTHZ-02, REQ-CFG-02)", () => {
    setWritePathProvider(throwing);
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
    const nc = { ok: false, reason: "not-configured" } as const;
    expect(currentHealthWritePath("proxy-header")).toEqual({ silence: nc, ack: nc, proposeEstateEdit: nc });
  });
});

// ── /healthz writePath block ─────────────────────────────────────────────────────────────────────

describe("GET /healthz writePath block (REQ-OBS-02, REQ-CFG-02, REQ-CFG-03)", () => {
  afterEach(() => resetWritePathProvider());

  test("`{} as ServerContext` → 200 with auth-mode-none for all three capabilities (REQ-CFG-03)", async () => {
    setRuntimeStatus(status());
    const { res, body } = await healthz({} as ServerContext);
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    const none = { ok: false, reason: "auth-mode-none" } as const;
    expect(body.writePath).toEqual({ silence: none, ack: none, proposeEstateEdit: none });
  });

  test("auth mode none ignores an installed provider → auth-mode-none (REQ-CFG-03)", async () => {
    setRuntimeStatus(status());
    setWritePathProvider(() => snapshot());
    const { body } = await healthz(ctxFor("none"));
    const none = { ok: false, reason: "auth-mode-none" } as const;
    expect(body.writePath).toEqual({ silence: none, ack: none, proposeEstateEdit: none });
  });

  test("proxy-header with no provider → not-configured for every capability (REQ-CFG-02)", async () => {
    setRuntimeStatus(status());
    const { res, body } = await healthz(ctxFor("proxy-header"));
    expect(res.status).toBe(200);
    const nc = { ok: false, reason: "not-configured" } as const;
    expect(body.writePath).toEqual({ silence: nc, ack: nc, proposeEstateEdit: nc });
  });

  test("proxy-header with a throwing provider → not-configured, status unaffected (REQ-CFG-02)", async () => {
    setRuntimeStatus(status());
    setWritePathProvider(throwing);
    const { res, body } = await healthz(ctxFor("proxy-header"));
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    const nc = { ok: false, reason: "not-configured" } as const;
    expect(body.writePath).toEqual({ silence: nc, ack: nc, proposeEstateEdit: nc });
  });

  test("healthy provider → every capability ok", async () => {
    setRuntimeStatus(status());
    setWritePathProvider(() => snapshot());
    const { body } = await healthz(ctxFor("proxy-header"));
    expect(body.writePath).toEqual({ silence: OK, ack: OK, proposeEstateEdit: OK });
  });

  test("secret-missing degrades only proposeEstateEdit and never changes body.status (REQ-OBS-02, REQ-CFG-02)", async () => {
    setRuntimeStatus(status());
    const { body: before } = await healthz(ctxFor("proxy-header"));

    setWritePathProvider(() => snapshot({ secret: "secret-missing" }));
    const { res, body } = await healthz(ctxFor("proxy-header"));
    expect(res.status).toBe(200);
    expect(body.writePath).toEqual({
      silence: OK,
      ack: OK,
      proposeEstateEdit: { ok: false, reason: "secret-missing" },
    });
    expect(body.status).toBe("ok");
    expect(body.status).toBe(before.status);
  });

  test("a degraded runtime stays degraded and a degraded write path never flips it to ok (REQ-OBS-02)", async () => {
    setRuntimeStatus(status({ sources: { metrics: health(), alerts: health({ ok: false, error: "boom" }), checks: health() } }));
    setWritePathProvider(() => snapshot({ audit: "unwritable" }));
    const { res, body } = await healthz(ctxFor("proxy-header"));
    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    const unwritable = { ok: false, reason: "unwritable" } as const;
    expect(body.writePath).toEqual({ silence: unwritable, ack: unwritable, proposeEstateEdit: unwritable });
  });
});
