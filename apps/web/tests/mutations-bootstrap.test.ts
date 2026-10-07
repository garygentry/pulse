// apps/web/tests/mutations-bootstrap.test.ts — the proxy-header write-runtime composition (04 §8, §10).
//
// Drives the REAL buildWriteRuntime (via writeRuntimeFor) over temp data dirs and a scripted Alertmanager.
// Covers the five definitions (03 §8), the construction order (probe before the audit writer; the second
// probe sees a corrupt ack store), stubs for null paths, provider install/uninstall, the slow-cycle hook,
// degraded start-up (REQ-CFG-02) and secret non-disclosure (10 §5.4, REQ-SEC-04). Every provider this
// suite installs is uninstalled in afterEach (10 §1).

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAndValidate } from "@pulse/core";
import { buildWebEstateModel } from "@pulse/renderer";
import * as auditModule from "@pulse/web-data/audit";
import type { AlertmanagerWriteClient } from "@pulse/web-data/sources";
import type { Identity } from "@pulse/web-data/identity";
import { loadProposalSecret, loadServerConfig } from "../src/server/config.js";
import { buildWriteRuntime } from "../src/server/mutations/bootstrap.js";
import { createMutations } from "../src/server/mutations/definitions.js";
import * as idempotencyModule from "../src/server/mutations/idempotency.js";
import { createMutationRegistry, MutationRegistrationError } from "../src/server/mutations/registry.js";
import {
  currentCapabilities,
  currentWritePathSnapshot,
  resetWritePathProvider,
} from "../src/server/mutations/session-provider.js";
import type { AckStore } from "../src/server/mutations/stores/ack-store.js";
import {
  currentProposalStore,
  resetProposalStoreProvider,
  type ProposalStore,
} from "../src/server/mutations/stores/proposal-store.js";
import { getRuntimeStatus } from "../src/server/refresh.js";
import { healthzRoute } from "../src/server/routes/healthz.js";
import { __resetMetricsForTest, metricsRoute, renderMetrics } from "../src/server/routes/metrics.js";
import { proposalsRoute } from "../src/server/routes/proposals.js";
import { sessionRoute } from "../src/server/routes/session.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";
import {
  IDENTITY_VALUE,
  IS_ROOT,
  TEST_PROPOSAL_SECRET,
  trustedRequest,
  writeRuntimeFor,
  type WriteRuntimeHarness,
} from "./mutations-fixtures.js";

const ALL_FALSE = { silence: false, ack: false, proposeEstateEdit: false };
const ALICE: Identity = { subject: IDENTITY_VALUE, displayName: IDENTITY_VALUE, source: "proxy-header" };

let h: WriteRuntimeHarness | null = null;
const scratch: string[] = [];
let logSpy: Mock<typeof console.log>;
let logLines: string[] = [];

beforeEach(() => {
  logLines = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  await h?.cleanup();
  h = null;
  for (const d of scratch.splice(0)) {
    await chmod(d, 0o700).catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  resetWritePathProvider();
  resetProposalStoreProvider();
  __resetMetricsForTest();
});

async function scratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pulse-bootstrap-"));
  scratch.push(d);
  return d;
}

function writePathGauge(): string[] {
  return renderMetrics(getRuntimeStatus(), Date.now())
    .split("\n")
    .filter((l) => l.startsWith("pulse_web_write_path_status"));
}

// ── definitions.ts (03 §8) ───────────────────────────────────────────────────────────────────────────

describe("createMutations — the five M2 definitions (REQ-SEAM-01)", () => {
  const stubClient = {} as AlertmanagerWriteClient;
  const stubAcks = {} as AckStore;
  const stubProposals = {} as ProposalStore;
  const defs = createMutations({
    writeClient: stubClient,
    ackStore: stubAcks,
    proposalStore: stubProposals,
    now: () => new Date(),
  });

  test("paths, capabilities and actions follow the 03 §8 table in registration order", () => {
    expect(defs.map((d) => [d.method, d.path, d.capability, d.action])).toEqual([
      ["POST", "/api/mutations/silences", "silence", "silence.create"],
      ["POST", "/api/mutations/silences/expire", "silence", "silence.expire"],
      ["POST", "/api/mutations/acks", "ack", "ack.set"],
      ["POST", "/api/mutations/acks/remove", "ack", "ack.remove"],
      ["POST", "/api/mutations/proposals", "proposeEstateEdit", "proposal.create"],
    ]);
    expect(Object.isFrozen(defs)).toBe(true);
  });

  test("all five register without error in createMutationRegistry(\"proxy-header\") (REQ-SEAM-02)", () => {
    const registry = createMutationRegistry("proxy-header");
    for (const def of defs) registry.register(def);
    expect(registry.list().map((d) => d.path)).toEqual(defs.map((d) => d.path));
  });
});

// ── buildWriteRuntime (04 §8) ────────────────────────────────────────────────────────────────────────

describe("buildWriteRuntime — auth mode gate (REQ-SEAM-02)", () => {
  test("auth mode none throws MutationRegistrationError rule auth-mode and installs no provider", async () => {
    const env = {
      PULSE_VM_URL: "http://vm.test:8428",
      PULSE_ALERTMANAGER_URL: "http://alertmanager.test:9093",
      PULSE_GATUS_URL: "http://gatus.test:8080",
      PULSE_VMALERT_URL: "http://vmalert.test:8880",
    };
    const config = loadServerConfig(env);
    expect(config.identity.mode).toBe("none");
    let caught: unknown = null;
    try {
      await buildWriteRuntime(config, { secret: loadProposalSecret(env) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationRegistrationError);
    expect((caught as MutationRegistrationError).rule).toBe("auth-mode");
    expect((caught as MutationRegistrationError).path).toBeNull();
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentProposalStore()).toBeNull();
    expect(writePathGauge()).toEqual([]);
  });
});

describe("buildWriteRuntime — construction order (REQ-SEAM-02, REQ-CFG-02)", () => {
  test("probe #1 creates the audit parent and file BEFORE the audit writer is constructed", async () => {
    const root = await scratchDir(); // no audit/ subdir: only probe #1 can create it
    const seen: Array<{ parentExists: boolean; fileExists: boolean }> = [];
    const original = auditModule.createJsonlAuditWriter;
    const spy = spyOn(auditModule, "createJsonlAuditWriter").mockImplementation((opts) => {
      seen.push({ parentExists: existsSync(join(root, "audit")), fileExists: existsSync(opts.absolutePath) });
      return original(opts);
    });
    try {
      h = await writeRuntimeFor({ env: { PULSE_WEB_DATA_DIR: root } });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([{ parentExists: true, fileExists: true }]);
    expect(h.write.writePath.snapshot().audit).toEqual({ ok: true, reason: null });
  });

  test("a corrupt acks.json is visible as acks `corrupt` after the second probe; start-up continues", async () => {
    const root = await scratchDir();
    await writeFile(join(root, "acks.json"), "{ not json");
    h = await writeRuntimeFor({ env: { PULSE_WEB_DATA_DIR: root } });
    expect(h.write.writePath.snapshot().acks).toEqual({ ok: false, reason: "corrupt" });
    expect(currentWritePathSnapshot()?.acks).toEqual({ ok: false, reason: "corrupt" });
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual({ silence: true, ack: false, proposeEstateEdit: true });
    expect(await readFile(join(root, "acks.json"), "utf8")).toBe("{ not json"); // file preserved
    expect(h.write.runtimeDeps.ackStore?.loadStatus).toEqual({ ok: false, reason: "corrupt" });
  });

  test("null paths yield stubs, every store not-configured, and no proposal provider (REQ-CFG-02)", async () => {
    h = await writeRuntimeFor({ env: { PULSE_WEB_DATA_DIR: undefined } });
    const snap = h.write.writePath.snapshot();
    expect(snap.audit).toEqual({ ok: false, reason: "not-configured" });
    expect(snap.acks).toEqual({ ok: false, reason: "not-configured" });
    expect(snap.proposals).toEqual({ ok: false, reason: "not-configured" });
    expect(currentProposalStore()).toBeNull();
    const acks = h.write.runtimeDeps.ackStore!;
    expect(acks.loadStatus).toEqual({ ok: false, reason: "not-configured" });
    expect(acks.foldView().size).toBe(0);
    expect(await acks.reconcile({} as Parameters<AckStore["reconcile"]>[0])).toBe(0);
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
    // The registry shape is constant: the capability gate refuses before any stub handler runs.
    const res = await h.dispatch(trustedRequest("/api/mutations/acks", { fingerprint: "fp-1" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { details: { reason: string } }).details.reason).toBe("write-path-degraded");
  });

  test("a real proposals dir installs currentProposalStore() (REQ-SEAM-02)", async () => {
    h = await writeRuntimeFor();
    expect(currentProposalStore()).not.toBeNull();
    expect(h.write.writePath.snapshot().proposals).toEqual({ ok: true, reason: null });
  });

  test("an unwritable data dir never rejects start-up; all three store capabilities false (REQ-CFG-02)", async () => {
    const root = await scratchDir();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "x"); // a regular file where the data dir should be (root-proof)
    h = await writeRuntimeFor({ env: { PULSE_WEB_DATA_DIR: blocker } });
    const snap = h.write.writePath.snapshot();
    for (const store of ["audit", "acks", "proposals"] as const) expect(snap[store].ok).toBe(false);
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
    expect(writePathGauge()).toHaveLength(5);
  });

  test.skipIf(IS_ROOT)("a read-only (chmod 0500) parent dir never rejects start-up (REQ-CFG-02)", async () => {
    const root = await scratchDir();
    await chmod(root, 0o500);
    h = await writeRuntimeFor({ env: { PULSE_WEB_DATA_DIR: join(root, "data") } });
    const snap = h.write.writePath.snapshot();
    for (const store of ["audit", "acks", "proposals"] as const) expect(snap[store].ok).toBe(false);
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
  });

  test("a missing secret degrades only proposeEstateEdit", async () => {
    h = await writeRuntimeFor({ secret: null });
    expect(h.write.writePath.snapshot().secret).toEqual({ ok: false, reason: "secret-missing" });
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual({ silence: true, ack: true, proposeEstateEdit: false });
  });

  test("an unparseable Alertmanager URL for the write client degrades only silence", async () => {
    h = await writeRuntimeFor({ env: { PULSE_ALERTMANAGER_URL: "http://user:pw@alertmanager.test:9093" } });
    expect(h.write.writePath.snapshot().alertmanager).toEqual({ ok: false, reason: "not-configured" });
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual({ silence: false, ack: true, proposeEstateEdit: true });
  });
});

describe("buildWriteRuntime — providers, slow-cycle hook and close() (REQ-SEAM-02, REQ-CFG-02)", () => {
  test("providers are installed: session capabilities, the metrics gauge and the proposal store", async () => {
    h = await writeRuntimeFor();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual({ silence: true, ack: true, proposeEstateEdit: true });
    expect(writePathGauge()).toHaveLength(5);
    expect(currentProposalStore()).not.toBeNull();
  });

  test("runtimeDeps.onSlowCycle resolves and calls probe + idempotency sweep; the probe clears a write-failed mark", async () => {
    const sweeps: number[] = [];
    const original = idempotencyModule.createIdempotencyStore;
    const spy = spyOn(idempotencyModule, "createIdempotencyStore").mockImplementation((opts) => {
      const store = original(opts);
      return {
        ...store,
        sweep: () => {
          const n = store.sweep();
          sweeps.push(n);
          return n;
        },
      };
    });
    try {
      h = await writeRuntimeFor();
    } finally {
      spy.mockRestore();
    }
    const probe = spyOn(h.write.writePath, "probe");
    h.write.writePath.markFailed("audit", "write-failed");
    expect(h.write.writePath.snapshot().audit).toEqual({ ok: false, reason: "write-failed" });
    const hook = h.write.runtimeDeps.onSlowCycle!;
    await expect(Promise.resolve(hook())).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sweeps).toEqual([0]);
    expect(h.write.writePath.snapshot().audit).toEqual({ ok: true, reason: null });
    probe.mockRestore();
  });

  test("close() is idempotent and resets the session, metrics-status and proposal-store providers", async () => {
    h = await writeRuntimeFor();
    await h.write.close();
    await h.write.close();
    expect(currentWritePathSnapshot()).toBeNull();
    expect(currentCapabilities(ALICE, "proxy-header")).toEqual(ALL_FALSE);
    expect(writePathGauge()).toEqual([]);
    expect(currentProposalStore()).toBeNull();
  });

  test("attachRuntime binds the runtime: before it the dispatcher refuses internal, after it the request succeeds (REQ-SEAM-05)", async () => {
    // writeRuntimeFor attaches its stub; a fresh build over the same dir shows the unattached behaviour.
    h = await writeRuntimeFor();
    const unattached = await buildWriteRuntime(h.config, { secret: loadProposalSecret({ PULSE_PROPOSAL_SECRET: TEST_PROPOSAL_SECRET }) });
    try {
      const refused = await unattached.dispatcher(trustedRequest("/api/mutations/acks/remove", { fingerprint: "fp-1" }));
      expect(refused?.status).toBe(500);
      unattached.attachRuntime(h.runtime);
      const ok = await unattached.dispatcher(
        trustedRequest("/api/mutations/acks/remove", { fingerprint: "fp-1" }, { idempotencyKey: "attach-key-0002" }),
      );
      expect(ok?.status).toBe(200);
    } finally {
      await unattached.close();
    }
  });
});

// ── Secret non-disclosure (10 §5.4) ──────────────────────────────────────────────────────────────────

const PARITY_FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/proposals-parity");

function routeRequest<P extends string>(path: P, query = ""): RouteRequest<P> {
  return {
    request: new Request(`http://pulse.test${path}${query}`, { headers: { host: "pulse.test" } }),
    params: {},
    routePattern: path,
    peerIp: null,
    disableTimeout: () => undefined,
  } as unknown as RouteRequest<P>;
}

describe("secret non-disclosure (REQ-SEC-04, 10 §5.4)", () => {
  test("the proposal secret appears in no log line, audit file, proposal file or /healthz, /api/session, /metrics, /api/proposals body", async () => {
    expect(new TextEncoder().encode(TEST_PROPOSAL_SECRET).byteLength).toBeGreaterThanOrEqual(32);
    const loaded = loadAndValidate(PARITY_FIXTURE);
    if (!loaded.ok) throw new Error("parity fixture failed to load");
    const web = buildWebEstateModel(loaded.model);
    if (!web.ok) throw new Error("parity fixture tripped web safety");

    h = await writeRuntimeFor({ context: { estate: { model: web.value } as unknown as ServerContext["estate"] } });
    const res = await h.dispatch(
      trustedRequest("/api/mutations/proposals", {
        target: { kind: "host", id: "host:app-01" },
        changes: [{ field: "cadvisor", seen: false, proposed: true }],
        rationale: "Container metrics are needed for the new stack.",
      }),
    );
    expect(res.status).toBe(201);
    const responseText = await res.text();

    const secretBytes = Buffer.from(TEST_PROPOSAL_SECRET, "utf8");
    const forms = [TEST_PROPOSAL_SECRET, secretBytes.toString("hex"), secretBytes.toString("base64"), secretBytes.toString("base64url")];
    const assertClean = (label: string, text: string): void => {
      for (const form of forms) expect(text.includes(form), `${label} leaks the secret`).toBe(false);
    };

    expect(logLines.length).toBeGreaterThan(0);
    assertClean("console.log", logLines.join("\n"));
    assertClean("mutation response", responseText);

    const audit = await readFile(h.dir.auditPath, "utf8");
    expect(audit.length).toBeGreaterThan(0);
    assertClean("audit file", audit);

    const files = (await readdir(h.dir.proposalsDir)).filter((f) => f.endsWith(".proposal.json"));
    expect(files).toHaveLength(1);
    assertClean("proposal file", await readFile(join(h.dir.proposalsDir, files[0]!), "utf8"));

    const ctx = h.contextFor(ALICE);
    const bodies: Array<[string, Response]> = [
      ["/healthz", await Promise.resolve(healthzRoute.handler(routeRequest("/healthz"), ctx))],
      ["/api/session", await Promise.resolve(sessionRoute.handler(routeRequest("/api/session"), ctx))],
      ["/metrics", await Promise.resolve(metricsRoute.handler(routeRequest("/metrics"), ctx))],
      [
        "/api/proposals",
        await Promise.resolve(proposalsRoute.handler(routeRequest("/api/proposals", "?kind=host&id=host%3Aapp-01"), ctx)),
      ],
    ];
    for (const [label, r] of bodies) {
      expect(r.status).toBe(200);
      const text = await r.text();
      assertClean(label, text);
      if (label === "/api/proposals") expect(JSON.parse(text).proposals).toHaveLength(1); // non-vacuous
    }
  });
});
