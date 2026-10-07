// apps/web/src/server/mutations/bootstrap.ts — the proxy-header write-runtime composition.
//
// The SINGLE construction site for every write object (Alertmanager write client, WritePath, audit
// writer, ack store, proposal store, idempotency store, registry, dispatcher), and the single place that
// installs the session/health, metrics-gauge and proposal-store providers. `server/index.ts` calls
// `buildWriteRuntime` exactly once, inside its `if (config.identity.mode === "proxy-header") {` branch;
// auth mode `none` never reaches this module (REQ-SEAM-02). A failing store never aborts start-up — it
// degrades only the capabilities that depend on it (REQ-CFG-02).

import {
  createAlertmanagerWriteClient,
  type AlertmanagerWriteClient,
  type FetchLike,
  type SourceResult,
} from "@pulse/web-data/sources";
import { createJsonlAuditWriter, type AuditAppendResult, type AuditWriter } from "@pulse/web-data/audit";
import type { AckFoldRecord } from "@pulse/web-data/cycle";
import type { MutationDispatcher } from "../router.js";
import type { RuntimeDeps, ServerRuntime } from "../refresh.js";
import type { SecretProvider, ServerConfig } from "../config.js";
import type { ProposalListBody } from "../../shared/mutations.js";
import { setWritePathStatusProvider } from "../routes/metrics.js";
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "./constants.js";
import { createMutations } from "./definitions.js";
import { createMutationDispatcher } from "./dispatcher.js";
import { createIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { createMutationRegistry, MutationRegistrationError } from "./registry.js";
import { setWritePathProvider } from "./session-provider.js";
import { createAckStore, type AckStore } from "./stores/ack-store.js";
import {
  createProposalStore,
  resetProposalStoreProvider,
  setProposalStoreProvider,
  type ProposalStore,
} from "./stores/proposal-store.js";
import { createWritePath, type StoreStatus, type WritePath } from "./write-path.js";

/** Inputs besides config. */
export interface BuildWriteRuntimeDeps {
  /** From loadProposalSecret(process.env). */
  readonly secret: SecretProvider;
  /** Network seam for the Alertmanager write client (tests / dev-loop e2e). */
  readonly fetchImpl?: FetchLike;
}

/** Everything the proxy-header composition root needs (built only in proxy-header mode). */
export interface WriteRuntime {
  /** Passed as createFetchHandler's 3rd argument. */
  readonly dispatcher: MutationDispatcher;
  /** Spread into createServerRuntime's deps: the ack store and the slow-cycle hook. */
  readonly runtimeDeps: Pick<RuntimeDeps, "ackStore" | "onSlowCycle">;
  /** Live health (tests, diagnostics). */
  readonly writePath: WritePath;
  /** Bind the ServerRuntime once it exists; the dispatcher builds each handler's ServerContext from it. */
  attachRuntime(runtime: ServerRuntime): void;
  /** Uninstall ALL providers (session, metrics, proposal store) and close the audit writer. Idempotent; never rejects. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Stubs for unconfigured or failed stores — keep the registry shape constant; the capability gate refuses
// (`write-path-degraded`) before any handler could reach one.
// ---------------------------------------------------------------------------------------------

const INERT_AUDIT_RESULT: AuditAppendResult = Object.freeze({
  ok: false,
  error: Object.freeze({ kind: "open", message: "audit path not configured" }),
});

/** Audit writer used when the audit path is unset or the writer cannot be constructed. */
const INERT_AUDIT: AuditWriter = Object.freeze({
  append: async (): Promise<AuditAppendResult> => INERT_AUDIT_RESULT,
  close: async (): Promise<AuditAppendResult> => INERT_AUDIT_RESULT,
});

/** Ack store with a sticky failed load (→ `ack` capability false); writes refuse, reconcile clears nothing. */
function disabledAckStore(reason: "not-configured" | "unwritable"): AckStore {
  const loadStatus: StoreStatus = Object.freeze({ ok: false, reason });
  const empty: ReadonlyMap<string, AckFoldRecord> = new Map<string, AckFoldRecord>();
  return Object.freeze({
    loadStatus,
    set: async () => ({ ok: false, error: "write-failed" }) as const,
    remove: async () => ({ ok: false, error: "write-failed" }) as const,
    reconcile: async (): Promise<number> => 0,
    foldView: () => empty,
    get: () => undefined,
  });
}

const DISABLED_PROPOSALS: ProposalListBody = Object.freeze({
  enabled: false,
  proposals: Object.freeze([]),
  invalidCount: 0,
});

/** Proposal store used when the dir is unset or construction threw; never installed as the route provider. */
function disabledProposalStore(writePath: WritePath): ProposalStore {
  return Object.freeze({
    async write() {
      writePath.markFailed("proposals", "write-failed");
      return { ok: false, error: "write-failed" } as const;
    },
    listFor: async (): Promise<ProposalListBody> => DISABLED_PROPOSALS,
  });
}

const DISABLED_WRITE_RESULT: SourceResult<never> = Object.freeze({
  ok: false,
  error: Object.freeze({ kind: "disabled", message: "alertmanager write client not configured", status: null }),
});

/** Write client used when createAlertmanagerWriteClient threw (bad URL → alertmanager not-configured). */
const DISABLED_WRITE_CLIENT: AlertmanagerWriteClient = Object.freeze({
  createSilence: async () => DISABLED_WRITE_RESULT,
  expireSilence: async () => DISABLED_WRITE_RESULT,
});

/** Run a synchronous factory; a throw yields the fallback (start-up never aborts on a store, CFG-02). */
function tryOr<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The RuntimeDeps.onSlowCycle hook (proxy-header only). Re-probes the write path (recovery of
 * `write-failed` marks and filesystem slots; the acks load status stays sticky for the process lifetime) and
 * sweeps expired idempotency entries. NEVER rejects: `probe()` is total and the sweep is guarded, so the
 * refresh cycle's error handling around this hook is purely defensive.
 */
function createSlowCycleHook(writePath: WritePath, idempotency: IdempotencyStore): () => Promise<void> {
  return async (): Promise<void> => {
    await writePath.probe();
    try {
      idempotency.sweep();
    } catch {
      /* sweep is total; defensive */
    }
  };
}

/** Proxy-header composition (REQ-SEAM-02, REQ-CFG-02). Never rejects for a store failure. */
export async function buildWriteRuntime(config: ServerConfig, deps: BuildWriteRuntimeDeps): Promise<WriteRuntime> {
  if (config.identity.mode !== "proxy-header") {
    // Programming fault: index.ts only calls this in the proxy-header branch (REQ-SEAM-02).
    throw new MutationRegistrationError("auth-mode", null, "buildWriteRuntime requires auth mode proxy-header");
  }
  const wp = config.writePath;

  // 1. Alertmanager write client (no I/O). A SourceConfigError (bad URL) → slot not-configured.
  let writeClient: AlertmanagerWriteClient | null = null;
  try {
    writeClient = createAlertmanagerWriteClient(
      config.alertmanagerUrl,
      deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {},
    );
  } catch {
    writeClient = null;
  }

  // 2. WritePath (no I/O); the ack slot reads AckStore.loadStatus on every probe (sticky once failed).
  let ackStore: AckStore | null = null;
  const writePath = createWritePath(wp, {
    secret: deps.secret.status,
    alertmanagerConfigured: writeClient !== null,
    ackLoadStatus: () => ackStore?.loadStatus ?? { ok: true, reason: null }, // unbound → fs checks decide
  });

  // 3. Start-up probe #1: mkdir -p the derived dirs INCLUDING the audit parent (createJsonlAuditWriter
  //    does not mkdir), W_OK checks, open-for-append of the audit file.
  await writePath.probe();

  // 4. Audit writer (lazy-open; config guarantees an absolute path). Null path / throw → inert writer.
  const auditPath = wp.auditPath;
  const audit: AuditWriter =
    auditPath === null ? INERT_AUDIT : tryOr(() => createJsonlAuditWriter({ absolutePath: auditPath }), INERT_AUDIT);

  // 5. Ack store. Never aborts start-up: a rejection → disabled stub (loadStatus unwritable).
  const ackStorePath = wp.ackStorePath;
  const acks: AckStore =
    ackStorePath === null
      ? disabledAckStore("not-configured")
      : await createAckStore(ackStorePath, { writePath }).catch(() => disabledAckStore("unwritable"));
  ackStore = acks;

  // 6. Proposal store. Null dir / throw → no real store (the route then serves { enabled:false }).
  const proposalsDir = wp.proposalsDir;
  const realProposals: ProposalStore | null =
    proposalsDir === null
      ? null
      : tryOr<ProposalStore | null>(() => createProposalStore(proposalsDir, deps.secret, { writePath }), null);
  const proposals: ProposalStore = realProposals ?? disabledProposalStore(writePath);

  // 7. Start-up probe #2: the ack store's load status (e.g. `corrupt`) is now part of the snapshot.
  await writePath.probe();

  // 8. Idempotency store.
  const idempotency = createIdempotencyStore({ ttlMs: IDEMPOTENCY_TTL_MS, maxEntries: IDEMPOTENCY_MAX_ENTRIES });

  // 9. Registry + the five mutation definitions. Registration errors are programming faults → propagate.
  const registry = createMutationRegistry(config.identity.mode);
  for (const def of createMutations({
    writeClient: writeClient ?? DISABLED_WRITE_CLIENT,
    ackStore: acks,
    proposalStore: proposals,
    now: () => new Date(),
  })) {
    registry.register(def);
  }

  // 10. Dispatcher.
  let runtime: ServerRuntime | null = null;
  const dispatcher = createMutationDispatcher({
    registry,
    audit,
    idempotency,
    writePath,
    identityConfig: config.identity,
    getRuntime: () => runtime,
  });

  // 11. Providers (read by /api/session, /healthz, /metrics, GET /api/proposals).
  setWritePathProvider(() => writePath.snapshot());
  setWritePathStatusProvider(() => writePath.snapshot());
  if (realProposals !== null) setProposalStoreProvider(realProposals); // proposals; absent → route { enabled:false }

  let closed = false;
  return {
    dispatcher,
    writePath,
    runtimeDeps: { ackStore: acks, onSlowCycle: createSlowCycleHook(writePath, idempotency) },
    attachRuntime(r: ServerRuntime): void {
      runtime = r;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      setWritePathProvider(null);
      setWritePathStatusProvider(null);
      resetProposalStoreProvider();
      await audit.close().catch(() => undefined); // AuditWriter.close resolves a result; defensive
    },
  };
}
