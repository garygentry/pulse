// apps/web/tests/mutations-fixtures.ts — shared mutation test fixtures (10 §4).
//
// Not a test file (no `.test.` in the name). Provides a trusted synthetic mutation request, a matching
// proxy-header IdentityConfig, a fake clock, a temp data dir with the write-path layout, and a scripted
// Alertmanager FetchLike. Synthetic Requests set `Host` explicitly (03 §3.2 note). `writeRuntimeFor`
// composes the REAL write runtime (buildWriteRuntime) over a temp data dir and a fake Alertmanager.

import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@pulse/web-data/audit";
import type { CycleState } from "@pulse/web-data/cycle";
import type { Identity, IdentityConfig } from "@pulse/web-data/identity";
import type { FetchLike } from "@pulse/web-data/sources";
import { loadProposalSecret, loadServerConfig, type ServerConfig } from "../src/server/config.js";
import { buildWriteRuntime, type WriteRuntime } from "../src/server/mutations/bootstrap.js";
import { resetWritePathProvider } from "../src/server/mutations/session-provider.js";
import { resetProposalStoreProvider } from "../src/server/mutations/stores/proposal-store.js";
import type { ServerRuntime } from "../src/server/refresh.js";
import type { MutationDispatchContext } from "../src/server/router.js";
import { setWritePathStatusProvider } from "../src/server/routes/metrics.js";
import type { ServerContext } from "../src/shared/registry.js";

/** Trusted proxy CIDR used by {@link TRUSTED_IDENTITY_CONFIG}. */
export const TRUSTED_PROXY_CIDR = "10.0.0.0/24";
/** A direct peer inside {@link TRUSTED_PROXY_CIDR}. */
export const TRUSTED_PEER_IP = "10.0.0.7";
/** A direct peer outside every trusted CIDR. */
export const UNTRUSTED_PEER_IP = "192.0.2.9";
/** The identity header name (the resolveIdentity default). */
export const IDENTITY_HEADER = "Remote-User";
/** A distinctive identity header value, so leak greps cannot match by accident. */
export const IDENTITY_VALUE = "alice-canary-q7zx";
/** The Host every synthetic request carries. */
export const TEST_HOST = "pulse.test";
/** A valid default Idempotency-Key (8–128 chars of [A-Za-z0-9_-]). */
export const DEFAULT_IDEMPOTENCY_KEY = "key-0000000000000001";

/** Proxy-header identity config matching {@link trustedRequest}'s peer and header. */
export const TRUSTED_IDENTITY_CONFIG: IdentityConfig = Object.freeze({
  mode: "proxy-header",
  headerName: IDENTITY_HEADER,
  trustedProxies: Object.freeze([TRUSTED_PROXY_CIDR]),
});

/** Overrides for {@link trustedRequest}. `null` omits the header / peer; `undefined` keeps the default. */
export interface TrustedRequestOptions {
  /** HTTP method (default POST). */ readonly method?: string;
  /** Idempotency-Key value, or null to omit. */ readonly idempotencyKey?: string | null;
  /** Identity header value, or null to omit. */ readonly identity?: string | null;
  /** Content-Type value, or null to omit. */ readonly contentType?: string | null;
  /** Sec-Fetch-Site value, or null to omit. */ readonly secFetchSite?: string | null;
  /** Host value, or null to omit. */ readonly host?: string | null;
  /** Direct peer IP, or null for none. */ readonly peerIp?: string | null;
  /** Raw body text instead of `JSON.stringify(body)`. */ readonly rawBody?: string;
  /** Extra headers (applied last; a null value deletes). */ readonly headers?: Readonly<Record<string, string | null>>;
}

/**
 * Build a trusted mutation dispatch context: POST, `content-type: application/json`, an Idempotency-Key,
 * `Sec-Fetch-Site: same-origin`, the identity header, an explicit Host, and a trusted peer.
 */
export function trustedRequest(path: string, body: unknown, opts: TrustedRequestOptions = {}): MutationDispatchContext {
  const headers = new Headers();
  const put = (name: string, value: string | null | undefined, fallback: string): void => {
    const v = value === undefined ? fallback : value;
    if (v !== null) headers.set(name, v);
  };
  put("content-type", opts.contentType, "application/json");
  put("idempotency-key", opts.idempotencyKey, DEFAULT_IDEMPOTENCY_KEY);
  put("sec-fetch-site", opts.secFetchSite, "same-origin");
  put(IDENTITY_HEADER, opts.identity, IDENTITY_VALUE);
  put("host", opts.host, TEST_HOST);
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const method = opts.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  const payload = opts.rawBody ?? JSON.stringify(body);
  const request = new Request(`http://${TEST_HOST}${path}`, {
    method,
    headers,
    ...(hasBody ? { body: payload } : {}),
  });
  const peerIp = opts.peerIp === undefined ? TRUSTED_PEER_IP : opts.peerIp;
  return { request, pathname: path, peerIp };
}

/** A controllable clock: `now()` for Date seams, `nowMs()` for epoch-ms seams. */
export interface FakeClock {
  /** Current instant as a fresh Date. */ now(): Date;
  /** Current instant in epoch ms. */ nowMs(): number;
  /** Move the clock forward by `ms`. */ advance(ms: number): void;
}

/** Build a {@link FakeClock} starting at `start` (a Date, ISO string or epoch ms). */
export function fakeClock(start: Date | string | number = "2026-09-28T12:00:00.000Z"): FakeClock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    nowMs: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A temp data dir with the write-path layout (04 §2.1 defaults). */
export interface TempDataDir {
  /** The temp root (PULSE_WEB_DATA_DIR). */ readonly root: string;
  /** `<root>/audit`. */ readonly auditDir: string;
  /** `<root>/audit/audit.jsonl` (not created; the writer opens it). */ readonly auditPath: string;
  /** `<root>/acks.json` (not created; a missing file loads as empty). */ readonly acksPath: string;
  /** `<root>/proposals`. */ readonly proposalsDir: string;
  /** chmod `path` read-only (0o500 for dirs, 0o400 for files). No effect as root. */
  makeReadOnly(path: string): Promise<void>;
  /** chmod `path` back to writable (0o700 for dirs, 0o600 for files). */
  makeWritable(path: string): Promise<void>;
  /** Restore permissions and remove the whole tree. */
  cleanup(): Promise<void>;
}

/** True when the process runs as root (chmod-based unwritable cases do not fail for root). */
export const IS_ROOT = process.getuid?.() === 0;

/** Create a {@link TempDataDir} under the OS temp dir. */
export async function tempDataDir(prefix = "pulse-mutations-"): Promise<TempDataDir> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const auditDir = join(root, "audit");
  const proposalsDir = join(root, "proposals");
  await mkdir(auditDir, { recursive: true });
  await mkdir(proposalsDir, { recursive: true });
  const touched = new Set<string>();
  const isDir = (p: string): boolean => p === root || p === auditDir || p === proposalsDir;
  return {
    root,
    auditDir,
    auditPath: join(auditDir, "audit.jsonl"),
    acksPath: join(root, "acks.json"),
    proposalsDir,
    async makeReadOnly(path: string) {
      touched.add(path);
      await chmod(path, isDir(path) ? 0o500 : 0o400);
    },
    async makeWritable(path: string) {
      await chmod(path, isDir(path) ? 0o700 : 0o600);
    },
    async cleanup() {
      for (const p of touched) await chmod(p, isDir(p) ? 0o700 : 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One scripted Alertmanager answer. */
export type FakeAmStep =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "malformed"; readonly status?: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport" };

/** One recorded upstream call. */
export interface FakeAmCall {
  /** Request URL. */ readonly url: string;
  /** HTTP method. */ readonly method: string;
  /** Request body text, or null. */ readonly body: string | null;
}

/** A scripted FetchLike plus the calls it received. */
export interface FakeAlertmanagerFetch {
  /** The FetchLike to inject (`createAlertmanagerWriteClient(url, { fetchImpl })`). */ readonly fetch: FetchLike;
  /** Calls in order (assert "0 upstream calls" with `calls.length`). */ readonly calls: FakeAmCall[];
}

/**
 * A scripted Alertmanager fetch. Each call consumes the next step; once the script is exhausted the last
 * step repeats (an empty script answers 200 `{}`). `timeout` never resolves until the caller's signal
 * aborts (the client's internal deadline); `transport` rejects immediately.
 */
export function fakeAlertmanagerFetch(script: readonly FakeAmStep[] = []): FakeAlertmanagerFetch {
  const calls: FakeAmCall[] = [];
  let index = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const step: FakeAmStep = script[Math.min(index, script.length - 1)] ?? { kind: "json", status: 200, body: {} };
    index += 1;
    switch (step.kind) {
      case "json":
        return Response.json(step.body, { status: step.status });
      case "status":
        return new Response(null, { status: step.status });
      case "malformed":
        return new Response("{not json", { status: step.status ?? 200, headers: { "content-type": "application/json" } });
      case "transport":
        throw new TypeError("fake transport failure");
      case "timeout":
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) return; // never settles without a signal
          if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
          else signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
    }
  };
  return { fetch, calls };
}

/** A ≥ 32-byte proposal secret canary (leak greps match only this exact text). */
export const TEST_PROPOSAL_SECRET = "bootstrap-secret-canary-7f3kq9-0123456789-ABCDEF";
/** The Alertmanager base URL the write runtime is configured with (only the fake fetch answers it). */
export const TEST_AM_URL = "http://alertmanager.test:9093";

/** The handler-visible slice of ServerContext a harness chooses (everything else is a null stub). */
export interface HarnessContext {
  /** Current cycle (acks read `alerts.value.alerts`; expire reads it for `silence-gone`). */ readonly cycle: CycleState | null;
  /** Estate bundle (proposals read `estate.model`). */ readonly estate: ServerContext["estate"];
}

/** Options for {@link writeRuntimeFor}. */
export interface WriteRuntimeOptions {
  /** Data dir (default: a fresh {@link tempDataDir}, removed by cleanup). */ readonly dir?: TempDataDir;
  /** Proposal secret text, or null to leave PULSE_PROPOSAL_SECRET unset (default {@link TEST_PROPOSAL_SECRET}). */
  readonly secret?: string | null;
  /** Scripted Alertmanager (default: an empty script answering 200 `{}`). */ readonly am?: FakeAlertmanagerFetch;
  /** Extra env (applied last; `undefined` deletes). */ readonly env?: Readonly<Record<string, string | undefined>>;
  /** Initial stub context (default: no cycle, no estate). */ readonly context?: Partial<HarnessContext>;
}

/** A built write runtime plus the stub ServerRuntime it is attached to. */
export interface WriteRuntimeHarness {
  /** The real write runtime from buildWriteRuntime. */ readonly write: WriteRuntime;
  /** The parsed proxy-header config it was built from. */ readonly config: ServerConfig;
  /** The data dir. */ readonly dir: TempDataDir;
  /** The fake Alertmanager (inspect `calls`). */ readonly am: FakeAlertmanagerFetch;
  /** The attached stub runtime (getContext → frozen ServerContext over the chosen cycle/estate). */ readonly runtime: ServerRuntime;
  /** Replace part of the stub context (later requests see it). */ setContext(next: Partial<HarnessContext>): void;
  /** Build the context a route would see for `identity`. */ contextFor(identity: Identity | null): ServerContext;
  /** Dispatch through the real dispatcher; throws if it answers null (unmatched). */ dispatch(ctx: MutationDispatchContext): Promise<Response>;
  /** Parsed lines of the JSONL audit file (empty when absent). */ auditEvents(): Promise<AuditEvent[]>;
  /** write.close(), belt-and-braces provider resets, and remove an owned data dir. */ cleanup(): Promise<void>;
}

/**
 * Compose the real proxy-header write runtime (buildWriteRuntime, 04 §8) over a temp data dir and a
 * scripted Alertmanager, and attach a stub ServerRuntime whose `getContext` returns a frozen
 * ServerContext with the chosen cycle and estate (10 §4). Installs the process-global providers:
 * always call `cleanup()` (or `write.close()`) in afterEach.
 */
export async function writeRuntimeFor(opts: WriteRuntimeOptions = {}): Promise<WriteRuntimeHarness> {
  const ownsDir = opts.dir === undefined;
  const dir = opts.dir ?? (await tempDataDir());
  const am = opts.am ?? fakeAlertmanagerFetch();
  const secret = opts.secret === undefined ? TEST_PROPOSAL_SECRET : opts.secret;
  const env: Record<string, string | undefined> = {
    PULSE_VM_URL: "http://vm.test:8428",
    PULSE_ALERTMANAGER_URL: TEST_AM_URL,
    PULSE_GATUS_URL: "http://gatus.test:8080",
    PULSE_VMALERT_URL: "http://vmalert.test:8880",
    PULSE_WEB_AUTH_MODE: "proxy-header",
    PULSE_WEB_AUTH_HEADER: IDENTITY_HEADER,
    PULSE_WEB_TRUSTED_PROXIES: TRUSTED_PROXY_CIDR,
    PULSE_WEB_DATA_DIR: dir.root,
    ...(secret !== null ? { PULSE_PROPOSAL_SECRET: secret } : {}),
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const config = loadServerConfig(env);
  const write = await buildWriteRuntime(config, { secret: loadProposalSecret(env), fetchImpl: am.fetch });

  let context: HarnessContext = { cycle: opts.context?.cycle ?? null, estate: opts.context?.estate ?? null };
  const contextFor = (identity: Identity | null): ServerContext =>
    Object.freeze({
      estate: context.estate,
      cycle: context.cycle,
      history: null,
      events: null,
      sources: null,
      config,
      identity,
      snapshot: null,
    }) as unknown as ServerContext;
  const runtime = {
    identityConfig: config.identity,
    getContext: contextFor,
  } as unknown as ServerRuntime;
  write.attachRuntime(runtime);

  return {
    write,
    config,
    dir,
    am,
    runtime,
    setContext(next) {
      context = { ...context, ...next };
    },
    contextFor,
    async dispatch(ctx) {
      const res = await write.dispatcher(ctx);
      if (res === null) throw new Error(`dispatcher answered null for ${ctx.pathname}`);
      return res;
    },
    async auditEvents() {
      const text = await readFile(dir.auditPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as AuditEvent);
    },
    async cleanup() {
      await write.close();
      resetWritePathProvider();
      setWritePathStatusProvider(null);
      resetProposalStoreProvider();
      if (ownsDir) await dir.cleanup();
    },
  };
}
