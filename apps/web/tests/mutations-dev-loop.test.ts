// apps/web/tests/mutations-dev-loop.test.ts — dev-loop end-to-end for the mutation foundation
// (10 §7.3; SC-03, SC-04, SC-07).
//
// Self-skips unless PULSE_DEV_LOOP=1. When enabled it needs the dev loop's REAL Alertmanager at
// PULSE_ALERTMANAGER_URL (the `--mock` engine is read-only) and fails loudly without it. The other
// engine URLs default to the dev-loop ports and may be down: only Alertmanager is load-bearing here.
//
// The suite composes its own proxy-header server — loadServerConfig → buildWriteRuntime →
// createServerRuntime(config, write.runtimeDeps) → write.attachRuntime → createFetchHandler(runtime,
// undefined, write.dispatcher) served by Bun.serve({port: 0}) — so the dev entry stays write-dark
// (01 §4). The git estate is built inline (copy overlay-estate, `pulse render`, commit) and the CLI is
// always spawned as `bun apps/cli/src/index.ts …`: apps/web/tsconfig.tests.json has rootDir apps/web,
// so nothing under apps/cli may be imported. Cycles are driven with `runtime.runOnce()` over an
// injected monotonic clock, so "the next cycle" and "the next slow cycle" are explicit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEvent } from "@pulse/web-data/audit";
import type { AlertsPayload, ActiveAlert, OverviewAlertSummary } from "@pulse/web-data/wire";
import { loadProposalSecret, loadServerConfig } from "../src/server/config.js";
import { buildWriteRuntime, type WriteRuntime } from "../src/server/mutations/bootstrap.js";
import { resetWritePathProvider } from "../src/server/mutations/session-provider.js";
import { resetProposalStoreProvider } from "../src/server/mutations/stores/proposal-store.js";
import { createFetchHandler } from "../src/server/router.js";
import { createServerRuntime, type ServerRuntime } from "../src/server/refresh.js";
import { setWritePathStatusProvider } from "../src/server/routes/metrics.js";
import type { HealthBody } from "../src/shared/snapshot.js";
import {
  SILENCE_DEFAULT_DURATION_MS,
  type CreateProposalResult,
  type CreateSilenceResult,
  type MutationSuccess,
  type ProposalListBody,
  type RemoveAckResult,
  type SetAckResult,
} from "../src/shared/mutations.js";

const devLoopDescribe = process.env.PULSE_DEV_LOOP === "1" ? describe : describe.skip;

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");
const OVERLAY_ESTATE = join(REPO_ROOT, "packages/core/tests/fixtures/overlay-estate");
const IS_ROOT = process.getuid?.() === 0;

/** Per-run tag so concurrent/repeated runs never collide in the shared dev Alertmanager. */
const RUN = `pulse-e2e-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const SECRET = `dev-loop-proposal-secret-${randomUUID()}`;
const IDENTITY = "Dev Loop Operator";
const CLI_ENV = {
  PULSE_PROPOSAL_SECRET: SECRET,
  CHAT_WEBHOOK_URL: "https://chat.example.invalid/hook",
  DEADMAN_URL: "https://deadman.example.invalid/ping",
};
const WRITE_CAPABILITIES = ["silence", "ack", "proposeEstateEdit"] as const;
const CYCLE_ROUTES = ["/api/overview", "/api/alerts", "/api/estate", "/api/timeline", "/api/engine"] as const;
const SLOW_CADENCE_MS = 60_000;
const HOST_TARGET = { kind: "host", id: "host:app-01" } as const;

let amUrl = "";
let root = "";
let dataDir = "";
let proposalsDir = "";
let write: WriteRuntime | null = null;
let runtime: ServerRuntime | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";
let mono = 0;
/** Label sets of every synthetic alert posted, so afterAll can resolve them all. */
const posted: Record<string, string>[] = [];
/** Every mutation request id answered by the server (step 4 audit pairing). */
const requestIds: { action: string; requestId: string }[] = [];

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
  const r = run(["git", ...args], cwd);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr}`);
  return r.stdout;
}

function cli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  return run(["bun", CLI_ENTRY, ...args], root, CLI_ENV);
}

/** Post alerts to the dev Alertmanager (inject or resolve). */
async function amPost(alerts: { labels: Record<string, string>; startsAt?: string; endsAt?: string }[]): Promise<void> {
  const res = await fetch(`${amUrl}/api/v2/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alerts.map((a) => ({ annotations: { summary: `synthetic ${RUN}` }, ...a }))),
  });
  if (!res.ok) throw new Error(`Alertmanager POST /api/v2/alerts → ${res.status}`);
}

async function injectAlert(suffix: string): Promise<Record<string, string>> {
  const labels = {
    alertname: `${RUN}-${suffix}`,
    severity: "warning",
    job: "pulse-dev-loop-e2e",
    instance: `${RUN}.invalid:9100`,
  };
  posted.push(labels);
  await amPost([{ labels, startsAt: new Date().toISOString() }]);
  return labels;
}

async function resolveAlert(labels: Record<string, string>): Promise<void> {
  const now = new Date().toISOString();
  await amPost([{ labels, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: now }]);
}

/** Run one cycle; `slow` advances the clock past the slow cadence so the slow-cycle hook fires. */
async function cycle(slow = false): Promise<void> {
  mono += slow ? SLOW_CADENCE_MS + 1_000 : 10_000;
  await runtime!.runOnce();
}

/** Run cycles until `check` returns a value (not undefined), or fail after `tries`. */
async function eventually<T>(what: string, check: () => Promise<T | undefined>, opts: { tries?: number; slow?: boolean } = {}): Promise<T> {
  const tries = opts.tries ?? 20;
  for (let i = 0; i < tries; i++) {
    await cycle(opts.slow === true);
    const v = await check();
    if (v !== undefined) return v;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Poll without driving cycles (for effects of the fire-and-forget slow-cycle hook). */
async function poll<T>(what: string, check: () => Promise<T | undefined>, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function get(path: string, trusted = false): Promise<Response> {
  return fetch(`${base}${path}`, trusted ? { headers: { "remote-user": IDENTITY } } : undefined);
}

async function mutate<R>(path: string, body: unknown, action: string): Promise<{ status: number; body: MutationSuccess<R> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `e2e-${randomUUID()}`,
      "sec-fetch-site": "same-origin",
      origin: base,
      "remote-user": IDENTITY,
    },
    body: JSON.stringify(body),
  });
  const requestId = res.headers.get("x-request-id");
  if (requestId !== null) requestIds.push({ action, requestId });
  return { status: res.status, body: (await res.json()) as MutationSuccess<R> };
}

async function alerts(): Promise<AlertsPayload> {
  const res = await get("/api/alerts");
  expect(res.status).toBe(200);
  return (await res.json()) as AlertsPayload;
}

async function alertNamed(name: string): Promise<ActiveAlert | undefined> {
  return (await alerts()).alerts.find((a) => a.name === name);
}

async function overviewAlert(fingerprint: string): Promise<OverviewAlertSummary | undefined> {
  const res = await get("/api/overview");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { alerts: readonly OverviewAlertSummary[] };
  return body.alerts.find((a) => a.fingerprint === fingerprint);
}

async function health(): Promise<HealthBody> {
  const res = await get("/healthz");
  expect(res.status).toBe(200);
  return (await res.json()) as HealthBody;
}

async function sessionCaps(): Promise<Record<string, boolean>> {
  const res = await get("/api/session", true);
  expect(res.status).toBe(200);
  return ((await res.json()) as { capabilities: Record<string, boolean> }).capabilities;
}

async function proposalList(): Promise<ProposalListBody> {
  const res = await get(`/api/proposals?kind=${HOST_TARGET.kind}&id=${encodeURIComponent(HOST_TARGET.id)}`, true);
  expect(res.status).toBe(200);
  return (await res.json()) as ProposalListBody;
}

function auditEvents(): AuditEvent[] {
  const text = readFileSync(join(dataDir, "audit/audit.jsonl"), "utf8");
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as AuditEvent);
}

/** Recursively set a tree's permissions (dirs / files), children before the parent when locking. */
function chmodTree(dir: string, dirMode: number, fileMode: number): void {
  if (dirMode & 0o200) chmodSync(dir, dirMode); // unlocking: open the dir first so children are reachable
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) chmodTree(p, dirMode, fileMode);
    else chmodSync(p, fileMode);
  }
  if (!(dirMode & 0o200)) chmodSync(dir, dirMode);
}

// ── suite ───────────────────────────────────────────────────────────────────────────────────────

devLoopDescribe("dev-loop e2e — silences, acks, proposals and the degraded write path (SC-03, SC-04, SC-07)", () => {
  beforeAll(async () => {
    const am = process.env.PULSE_ALERTMANAGER_URL;
    if (am === undefined || am.trim() === "") {
      throw new Error("PULSE_DEV_LOOP=1 requires PULSE_ALERTMANAGER_URL (the dev loop's real Alertmanager; --mock is read-only)");
    }
    amUrl = am.replace(/\/+$/, "");

    // Temp git estate, built inline (copy → config → git init → `pulse render` subprocess → commit).
    root = mkdtempSync(join(tmpdir(), "pulse-dev-loop-estate-"));
    dataDir = mkdtempSync(join(tmpdir(), "pulse-dev-loop-data-"));
    proposalsDir = join(root, "proposals");
    cpSync(OVERLAY_ESTATE, join(root, "estate"), { recursive: true });
    writeFileSync(join(root, "pulse.config.yaml"), "estateDir: estate\noutputRoot: rendered\nproposalsDir: proposals\n");
    mkdirSync(proposalsDir);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Pulse Dev Loop");
    git(root, "config", "user.email", "pulse-dev-loop@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    const render = cli("render");
    if (render.exitCode !== 0) throw new Error(`pulse render failed (${render.exitCode}): ${render.stderr}`);
    git(root, "add", "-A", "--", ".", ":!proposals");
    git(root, "commit", "-q", "-m", "initial estate");

    // Proxy-header composition: the production index.ts wiring with a trusted loopback peer.
    const env: Record<string, string | undefined> = {
      PULSE_VM_URL: process.env.PULSE_VM_URL ?? "http://127.0.0.1:8428",
      PULSE_ALERTMANAGER_URL: amUrl,
      PULSE_GATUS_URL: process.env.PULSE_GATUS_URL ?? "http://127.0.0.1:8080",
      PULSE_VMALERT_URL: process.env.PULSE_VMALERT_URL ?? "http://127.0.0.1:8880",
      // `pulse render` writes the web artifacts flat under the output root.
      PULSE_WEB_ESTATE_MODEL: join(root, "rendered/web-estate-model.json"),
      PULSE_WEB_AUTH_MODE: "proxy-header",
      PULSE_WEB_AUTH_HEADER: "Remote-User",
      PULSE_WEB_TRUSTED_PROXIES: "127.0.0.0/8",
      PULSE_WEB_DATA_DIR: dataDir,
      PULSE_WEB_PROPOSALS_DIR: proposalsDir, // shared with the CLI's --proposals-dir
      PULSE_PROPOSAL_SECRET: SECRET,
    };
    const config = loadServerConfig(env);
    write = await buildWriteRuntime(config, { secret: loadProposalSecret(env) });
    runtime = createServerRuntime(config, { ...write.runtimeDeps, monotonicNow: () => mono });
    write.attachRuntime(runtime);
    const handler = createFetchHandler(runtime, undefined, write.dispatcher);
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request): Promise<Response> =>
        handler(request, {
          peerIp: srv.requestIP(request)?.address.replace(/^::ffff:/, "") ?? null,
          disableTimeout: () => srv.timeout(request, 0),
        }),
    });
    server = srv;
    base = `http://127.0.0.1:${srv.port}`;
    await cycle(true); // prime: estate + first (slow) cycle
  }, 120_000);

  afterAll(async () => {
    if (amUrl !== "" && posted.length > 0) {
      const now = new Date().toISOString();
      await amPost(posted.map((labels) => ({ labels, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: now }))).catch(() => undefined);
    }
    await server?.stop(true);
    server = null;
    runtime?.close();
    runtime = null;
    await write?.close(); // uninstalls the session, metrics-status and proposal-store providers
    write = null;
    resetWritePathProvider();
    setWritePathStatusProvider(null);
    resetProposalStoreProvider();
    if (dataDir !== "") {
      try {
        chmodTree(dataDir, 0o700, 0o600);
      } catch {
        // best effort — the rm below reports anything left behind
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("step 1: silence create (one label removed, 2 h default, rationale rule) → visible next cycle → expire (SC-03, REQ-SIL-01, REQ-SIL-04, REQ-SIL-07)", async () => {
    const labels = await injectAlert("silence");
    const alert = await eventually("synthetic silence alert firing", async () => {
      const a = await alertNamed(labels.alertname!);
      return a?.state === "firing" ? a : undefined;
    });
    // Every allowlisted label except one (never alertname): the operator narrows by removing a label.
    const names = Object.keys(alert.labels);
    const dropped = names.find((n) => n !== "alertname");
    const matchers = names.filter((n) => n !== dropped).map((name) => ({ name, value: alert.labels[name]! }));
    expect(matchers.some((m) => m.name === "alertname")).toBe(true);

    const endsAt = new Date(Date.now() + SILENCE_DEFAULT_DURATION_MS).toISOString();
    const created = await mutate<CreateSilenceResult>(
      "/api/mutations/silences",
      { fingerprint: alert.fingerprint, matchers, endsAt, rationale: "dev-loop e2e: silencing a synthetic alert" },
      "silence.create",
    );
    expect(created.status).toBe(201);
    const silenceId = created.body.result.silenceId;
    expect(silenceId).not.toBe("");

    await eventually("silence active and alert silenced", async () => {
      const p = await alerts();
      const s = p.silences.find((x) => x.id === silenceId);
      const a = p.alerts.find((x) => x.fingerprint === alert.fingerprint);
      if (s?.state !== "active" || a?.state !== "silenced" || !a.silencedBy.includes(silenceId)) return undefined;
      expect(s.comment.startsWith("[pulse] ")).toBe(true);
      expect(s.matchers.map((m) => m.name).sort()).toEqual(matchers.map((m) => m.name).sort());
      return true;
    });

    const expired = await mutate<{ silenceId: string }>(
      "/api/mutations/silences/expire",
      { silenceId, rationale: "dev-loop e2e: done" },
      "silence.expire",
    );
    expect(expired.status).toBe(200);
    await eventually("silence expired and alert firing again", async () => {
      const p = await alerts();
      const s = p.silences.find((x) => x.id === silenceId);
      const a = p.alerts.find((x) => x.fingerprint === alert.fingerprint);
      return (s === undefined || s.state === "expired") && a?.state === "firing" ? true : undefined;
    });
  }, 120_000);

  test("step 2: ack with note → alerts ack + overview acked → unack; ack again → resolve in AM → auto-cleared next current cycle (SC-03, REQ-ACK-01, REQ-ACK-04)", async () => {
    const labels = await injectAlert("ack");
    const alert = await eventually("synthetic ack alert firing", async () => {
      const a = await alertNamed(labels.alertname!);
      return a?.state === "firing" ? a : undefined;
    });
    const fp = alert.fingerprint;
    const note = "dev-loop e2e: looking into it";

    const set = await mutate<SetAckResult>("/api/mutations/acks", { fingerprint: fp, note }, "ack.set");
    expect(set.status).toBe(200);
    await eventually("ack joined into alerts + overview", async () => {
      const a = (await alerts()).alerts.find((x) => x.fingerprint === fp);
      const o = await overviewAlert(fp);
      if (a?.ack === undefined || o?.acked !== true) return undefined;
      expect(a.ack.note).toBe(note);
      expect(a.ack.by).toBe(IDENTITY);
      return true;
    });

    const removed = await mutate<RemoveAckResult>("/api/mutations/acks/remove", { fingerprint: fp }, "ack.remove");
    expect(removed.status).toBe(200);
    expect(removed.body.result.removed).toBe(true);
    await eventually("ack removed from alerts + overview", async () => {
      const a = (await alerts()).alerts.find((x) => x.fingerprint === fp);
      const o = await overviewAlert(fp);
      return a !== undefined && !("ack" in a) && o !== undefined && !("acked" in o) ? true : undefined;
    });

    const again = await mutate<SetAckResult>("/api/mutations/acks", { fingerprint: fp }, "ack.set");
    expect(again.status).toBe(200);
    expect(readFileSync(join(dataDir, "acks.json"), "utf8")).toContain(fp);

    await resolveAlert(labels);
    await eventually("resolved alert gone and its ack auto-cleared", async () => {
      const gone = (await alerts()).alerts.every((x) => x.fingerprint !== fp);
      const cleared = !readFileSync(join(dataDir, "acks.json"), "utf8").includes(fp);
      return gone && cleared ? true : undefined;
    });
  }, 120_000);

  test("step 3: propose → `pulse proposals apply` → one commit → applied; second proposal → reject → rejected + reason (SC-03, REQ-PROP-01, REQ-PROP-08, REQ-PROP-09)", async () => {
    const first = await mutate<CreateProposalResult>(
      "/api/mutations/proposals",
      {
        target: HOST_TARGET,
        changes: [{ field: "expectedChurn", seen: false, proposed: true }],
        rationale: "dev-loop e2e: app-01 is rebuilt nightly",
      },
      "proposal.create",
    );
    expect(first.status).toBe(201);
    const second = await mutate<CreateProposalResult>(
      "/api/mutations/proposals",
      {
        target: HOST_TARGET,
        changes: [{ field: "heartbeat", seen: true, proposed: false }],
        rationale: "dev-loop e2e: second proposal to reject",
      },
      "proposal.create",
    );
    expect(second.status).toBe(201);
    const applyId = first.body.result.proposalId;
    const rejectId = second.body.result.proposalId;

    const pending = await proposalList();
    expect(pending.enabled).toBe(true);
    expect(pending.proposals.find((p) => p.id === applyId)?.state).toBe("pending");

    const before = Number(git(root, "rev-list", "--count", "HEAD").trim());
    const apply = cli("proposals", "apply", applyId, "--proposals-dir", proposalsDir, "--json");
    expect(apply.exitCode, apply.stderr).toBe(0);
    expect(apply.stdout).not.toContain(SECRET);
    expect(Number(git(root, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    const head = git(root, "rev-parse", "HEAD").trim();

    const applied = (await proposalList()).proposals.find((p) => p.id === applyId);
    expect(applied?.state).toBe("applied");
    expect(applied?.commit).toBe(head);

    const reason = "dev-loop e2e: heartbeat must stay on";
    const reject = cli("proposals", "reject", rejectId, "--reason", reason, "--proposals-dir", proposalsDir, "--json");
    expect(reject.exitCode, reject.stderr).toBe(0);
    expect(Number(git(root, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    const rejected = (await proposalList()).proposals.find((p) => p.id === rejectId);
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.reason).toBe(reason);
  }, 120_000);

  test("step 4: every action has paired attempted + final audit lines with all REQ-AUD-01 fields (SC-04, REQ-AUD-01)", () => {
    const events = auditEvents();
    const actions = new Set(requestIds.map((r) => r.action));
    for (const a of ["silence.create", "silence.expire", "ack.set", "ack.remove", "proposal.create"]) {
      expect(actions.has(a), a).toBe(true);
    }
    for (const { action, requestId } of requestIds) {
      const mine = events.filter((e) => e.requestId === requestId);
      expect(mine.map((e) => e.outcome), `${action} ${requestId}`).toEqual(["attempted", "succeeded"]);
      for (const e of mine) {
        expect(e.action).toBe(action);
        expect(Number.isNaN(Date.parse(e.at))).toBe(false);
        expect(e.actor.displayName).toBe(IDENTITY);
        expect(e.capability).toBe(action.startsWith("silence.") ? "silence" : action.startsWith("ack.") ? "ack" : "proposeEstateEdit");
        expect(e.target.length).toBeGreaterThan(0);
        expect(typeof e.details).toBe("object");
      }
    }
    expect(readFileSync(join(dataDir, "audit/audit.jsonl"), "utf8")).not.toContain(SECRET);
  });

  // Root ignores permission bits, so the read-only degradation cannot be produced there.
  test.skipIf(IS_ROOT)(
    "step 5: read-only data dir → reads served, /healthz reasons non-ok, capabilities false; restore → recovers next slow cycle (SC-07, REQ-CFG-02)",
    async () => {
      chmodTree(dataDir, 0o500, 0o400);
      try {
        await cycle(true); // slow-due: the hook re-probes the write path (fire-and-forget)
        const degraded = await poll("write path degraded", async () => {
          const h = await health();
          return WRITE_CAPABILITIES.every((c) => h.writePath?.[c]?.ok === false) ? h : undefined;
        });
        expect(degraded.status).not.toBe("error");
        for (const c of WRITE_CAPABILITIES) {
          expect(degraded.writePath?.[c]?.reason, c).not.toBe("ok");
          expect(degraded.writePath?.[c]?.reason, c).not.toBe("auth-mode-none");
        }
        for (const p of CYCLE_ROUTES) expect((await get(p)).status, p).toBe(200);
        expect(await sessionCaps()).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
      } finally {
        chmodTree(dataDir, 0o700, 0o600);
      }

      await cycle(true);
      await poll("write path recovered", async () => {
        const h = await health();
        return WRITE_CAPABILITIES.every((c) => h.writePath?.[c]?.ok === true) ? true : undefined;
      });
      expect(await sessionCaps()).toEqual({ silence: true, ack: true, proposeEstateEdit: true });
    },
    120_000,
  );
});
