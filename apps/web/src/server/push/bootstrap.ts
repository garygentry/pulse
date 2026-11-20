// Push runtime bootstrap: turns the parsed push configuration into a running gateway (or an inert / misconfigured
// one), owns the capability and metrics providers, and tears everything down in a fixed order on close().

import { join } from "node:path";

import { PUSH_CAPABILITY, registerCapabilityProvider, unregisterCapabilityProvider } from "@pulse/web-data/contract";
import type { IdentityConfig } from "@pulse/web-data/identity";
import type { PushState } from "@pulse/web-data/wire";

import type { ExternalUrlState, ServerConfig } from "../config.js";
import { log } from "../log.js";
import type { ServerRuntime } from "../refresh.js";
import { APNS_ORIGINS, createApnsClient, type ApnsClient, type ApnsDeps } from "./apns/client.js";
import { createProviderTokenSigner } from "./apns/jwt.js";
import { currentBadge } from "./badge.js";
import type { PushConfigReason, PushConfigReasonKind, PushSurface } from "./config.js";
import { PUSH_ENV, PUSH_LIMITS, PUSH_PATHS } from "./constants.js";
import { NODE_PUSH_FS, probePushDataDir, type PushFs } from "./data-dir.js";
import { createDeliveryMonitor, createDeviceQueues, type DeviceQueues, type Timers } from "./dispatch/queue.js";
import { SYSTEM_CLOCK, SYSTEM_RANDOM, SYSTEM_TIMERS, type Clock, type RandomSource } from "./ids.js";
import { createIntake } from "./intake.js";
import { createNotifiedMemory, type NotifiedMemory } from "./memory.js";
import { installPushMetrics } from "./metrics.js";
import { createPairingService, type PairingService } from "./pairing.js";
import { pushErrorResponse } from "./refusal.js";
import { createDeviceStore, type RegistryStore } from "./registry/store.js";
import { createPushDispatcher } from "./routes.js";
import type { PushSecret } from "./secrets.js";
import { createSweep, type Sweep } from "./sweep.js";

/** The push handler the router consults for `/api/push/*`; resolves null for paths it does not own. */
export type PushDispatcher = (ctx: {
  /** The incoming request. */
  readonly request: Request;
  /** URL pathname of the request. */
  readonly pathname: string;
  /** Socket peer address; `null` when unknown. */
  readonly peerIp: string | null;
}) => Promise<Response | null>; // null: not a push path, the router falls through

/** A built push runtime in one of the three gateway states. */
export interface PushRuntime {
  /** Gateway state fixed at bootstrap. */
  readonly state: PushState;
  /** Handler for `/api/push/*`; resolves null for paths it does not own. */
  readonly dispatcher: PushDispatcher;
  /** Supplies the badge source; called once after createServerRuntime. */
  attachRuntime(runtime: ServerRuntime): void;
  /** Stop sweeps, abandon queues, close http2 sessions, flush soft fields, unregister the capability. */
  close(): Promise<void>;
}

/** Bootstrap dependencies; every field defaults to production. */
export interface PushBootstrapDeps {
  /** Time source; absent uses SYSTEM_CLOCK. */
  readonly clock?: Clock;
  /** Entropy source; absent uses SYSTEM_RANDOM. */
  readonly random?: RandomSource;
  /** Timer source; absent uses SYSTEM_TIMERS. */
  readonly timers?: Timers;
  /** APNs origin/CA overrides; absent uses APNS_ORIGINS and the system CA. */
  readonly apns?: Partial<Pick<ApnsDeps, "origins" | "ca">>;
  /** File seam; absent uses the real filesystem. */
  readonly fs?: PushFs;
}

/** Everything the push dispatcher needs, as assembled by bootstrap. */
export type PushServices = MisconfiguredPushServices | ConfiguredPushServices;

/** Misconfigured: only GET /api/push/status answers (200 {state:"misconfigured"…}); every other push route is 503. */
export interface MisconfiguredPushServices {
  /** Discriminant. */
  readonly state: "misconfigured";
  /** For the browser gate's read variant on GET /api/push/status in proxy-header mode. */
  readonly identity: IdentityConfig;
  /** Reported as PushStatusPayload.maxDevices. Always PUSH_LIMITS.defaultMaxDevices here (the parse may not have one). */
  readonly maxDevices: number;
}

/** Configured: the full route table. */
export interface ConfiguredPushServices {
  /** Discriminant. */
  readonly state: "configured";
  /** Browser gate (auth mode, trusted proxies). */
  readonly identity: IdentityConfig;
  /** Pairing-link base when usable. */
  readonly externalUrl: ExternalUrlState;
  /** Device cap. */
  readonly maxDevices: number;
  /** Webhook surface; "off" → 503 PUSH_UNAVAILABLE on POST /api/push/alertmanager. */
  readonly webhook: PushSurface;
  /** Operator surface; "off" → 503 PUSH_UNAVAILABLE on /api/push/admin/*. */
  readonly admin: PushSurface;
  /** Non-null iff webhook === "on". */
  readonly webhookSecret: PushSecret | null;
  /** Non-null iff admin === "on". */
  readonly operatorSecret: PushSecret | null;
  /** APNs topic (bundle id), for test sends. */
  readonly topic: string;
  /** The loaded registry (loadStatus "ok"). */
  readonly store: RegistryStore;
  /** Token issue / cancel / redeem. */
  readonly pairing: PairingService;
  /** Per-device notified memory. */
  readonly memory: NotifiedMemory;
  /** Per-device FIFOs. */
  readonly queues: DeviceQueues;
  /** HTTP/2 APNs client. */
  readonly apns: ApnsClient;
  /** Provider-token signer, shared by the queues and the operator test send. */
  readonly signer: ReturnType<typeof createProviderTokenSigner>;
  /** Delivery monitor (last success, auth-failure latch, log rate limit), shared by the queues and the test send. */
  readonly monitor: ReturnType<typeof createDeliveryMonitor>;
  /** Serial plan-then-enqueue scheduler. */
  readonly intake: ReturnType<typeof createIntake>;
  /** The ServerRuntime once attachRuntime ran, else null (badge omitted). */
  getRuntime(): ServerRuntime | null;
  /** Injected clock. */
  readonly clock: Clock;
  /** Injected entropy. */
  readonly random: RandomSource;
  /** Injected timers. */
  readonly timers: Timers;
}

/**
 * A runtime that does nothing. Pure: it touches no global (no metrics provider, no capability provider), creates no
 * timer, opens no file. Used for the disabled state and by the contract generator's stub.
 */
export function createDisabledPushRuntime(): PushRuntime {
  return Object.freeze({
    state: "disabled" as const,
    dispatcher: async (): Promise<Response | null> => null, // router falls through: 405 non-GET, 404 GET
    attachRuntime: (_runtime: ServerRuntime): void => {},
    close: async (): Promise<void> => {},
  });
}

// ---------------------------------------------------------------------------------------------------------------
// config_warning logging
// ---------------------------------------------------------------------------------------------------------------

/** Fixed, value-free text per reason. */
const REASON_TEXT: Readonly<Record<PushConfigReasonKind, string>> = Object.freeze({
  "missing": "is not set",
  "invalid": "is not valid",
  "unreadable": "cannot be read",
  "not-absolute": "must be an absolute path",
  "too-short": "must be at least 32 bytes",
  "data-dir-missing": "is not set; push needs a data directory",
  "data-dir-unwritable": "is not writable",
  "registry-corrupt": "could not be parsed; the file is preserved and push is disabled",
});

/** What the warning means for the operator, chosen by the variable. */
function consequence(envVar: string): string {
  if (envVar === PUSH_ENV.webhookSecret) return "the Alertmanager push webhook is off";
  if (envVar === PUSH_ENV.operatorSecret) return "remote operator commands (pulse push) are off";
  return "push is disabled (misconfigured)";
}

/** Log one reason once per buildPushRuntime call. `extra` carries only step/code for data-dir-unwritable. */
function warnOnce(
  seen: Set<string>,
  r: PushConfigReason,
  extra: { readonly step?: string; readonly code?: string | null } = {},
): void {
  const key = `${r.envVar}|${r.reason}`;
  if (seen.has(key)) return;
  seen.add(key);
  log({
    event: "config_warning",
    ok: false,
    envVar: r.envVar,
    reason: r.reason,
    ...extra,
    error: `${r.envVar} ${REASON_TEXT[r.reason]}: ${consequence(r.envVar)}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------------------------

/** Run one close step; a throw or rejection is swallowed so later steps always run. */
async function step(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // defensive: each component owns its own diagnostics
  }
}

/** The parts a (possibly partial) configured build owns, closed in the binding order. */
interface BuiltParts {
  sweep: Sweep | null;
  intake: ReturnType<typeof createIntake> | null;
  queues: DeviceQueues | null;
  apnsClient: ApnsClient | null;
  store: RegistryStore | null;
}

/** Close the built parts in order: sweep, intake, queues, APNs sessions, soft-field flush. */
async function closeParts(parts: BuiltParts): Promise<void> {
  await step(() => parts.sweep?.close()); // no more expiry runs
  await step(() => parts.intake?.close()); // cancel a pending planning tick
  await step(() => parts.queues?.close()); // cancel retry timers, abandon items uncounted
  await step(() => parts.apnsClient?.close()); // close both http2 sessions
  await step(() => parts.store?.flushSoft()); // persist pending seenAt / lastDelivery
}

/** Build an idempotent close(): every call returns the first call's promise. */
function onceClose(run: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    if (closing === null) closing = run();
    return closing;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Misconfigured runtime
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build a runtime whose only live route is GET /api/push/status. The single constructor for every misconfigured
 * outcome: parse, probe, corrupt registry and bootstrap defect. The reasons are logged by the caller.
 */
function buildMisconfigured(config: ServerConfig): PushRuntime {
  const dispatcher = createPushDispatcher({
    state: "misconfigured",
    identity: config.identity,
    maxDevices: PUSH_LIMITS.defaultMaxDevices,
  });
  let uninstallMetrics: (() => void) | null = null;
  try {
    registerCapabilityProvider(PUSH_CAPABILITY, () => false);
  } catch {
    // An unknown capability name is a programming fault; the handshake simply shows no push.
  }
  try {
    uninstallMetrics = installPushMetrics({
      state: "misconfigured",
      store: null,
      delivery: { lastSuccessAtMs: () => null },
    });
  } catch {
    uninstallMetrics = null;
  }
  log({ event: "push_started", ok: false, state: "misconfigured", webhook: "off", admin: "off", devices: 0 });
  const close = onceClose(async () => {
    await step(() => unregisterCapabilityProvider(PUSH_CAPABILITY));
    await step(() => uninstallMetrics?.());
  });
  return Object.freeze({
    state: "misconfigured" as const,
    dispatcher,
    attachRuntime: (_runtime: ServerRuntime): void => {},
    close,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// buildPushRuntime
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build the push runtime for the parsed configuration, in every auth mode. Never rejects: an unexpected exception at
 * any step is caught, logged as push_internal_error {route: "bootstrap"}, the parts already built are closed, and a
 * misconfigured runtime (no store) is returned.
 *
 * @param config - The server configuration; only `push`, `identity` and `externalUrl` are read.
 * @param deps - Test seams; every field defaults to production.
 */
export async function buildPushRuntime(config: ServerConfig, deps: PushBootstrapDeps = {}): Promise<PushRuntime> {
  // 1. Disabled: no log, no provider, no timer, no file access.
  if (config.push.state === "disabled") return createDisabledPushRuntime();

  const parts: BuiltParts = { sweep: null, intake: null, queues: null, apnsClient: null, store: null };
  try {
    return await buildActive(config, deps, parts);
  } catch {
    // The message is never logged: it might quote a value.
    await closeParts(parts);
    await step(() => unregisterCapabilityProvider(PUSH_CAPABILITY));
    log({ event: "push_internal_error", ok: false, route: "bootstrap" });
    try {
      return buildMisconfigured(config);
    } catch {
      return createDisabledPushRuntime();
    }
  }
}

/** Steps 2–18 for a misconfigured or configured parse. Records every built part in `parts` as it goes. */
async function buildActive(config: ServerConfig, deps: PushBootstrapDeps, parts: BuiltParts): Promise<PushRuntime> {
  const push = config.push;
  // 2. Defaults.
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const random = deps.random ?? SYSTEM_RANDOM;
  const timers = deps.timers ?? SYSTEM_TIMERS;
  const fs = deps.fs ?? NODE_PUSH_FS;
  const origins = deps.apns?.origins ?? APNS_ORIGINS;
  const ca = deps.apns?.ca;

  // 3. Parse warnings, deduplicated per call.
  const seen = new Set<string>();
  if (push.state === "misconfigured") {
    for (const r of push.reasons) warnOnce(seen, r);
    // 4. Parse-misconfigured: no data directory, so no probe.
    return buildMisconfigured(config);
  }
  if (push.state !== "configured") return createDisabledPushRuntime();
  for (const r of push.warnings) warnOnce(seen, r);

  // 5. Probe the data directory.
  const probe = await probePushDataDir(push.dataDir, fs);
  if (!probe.ok) {
    warnOnce(seen, { envVar: PUSH_ENV.dataDir, reason: "data-dir-unwritable" }, { step: probe.step, code: probe.code });
    return buildMisconfigured(config);
  }

  // 6. Load the store. A corrupt store has logged push_registry_corrupt, preserved the file and holds no timer.
  const store = await createDeviceStore(join(probe.pushDir, "devices.json"), {
    clock,
    timers,
    readFile: (path) => fs.readFile(path),
  });
  if (store.loadStatus === "corrupt") {
    warnOnce(seen, { envVar: "devices.json", reason: "registry-corrupt" });
    return buildMisconfigured(config);
  }
  parts.store = store;

  // No await from here to the end: a concurrent request never sees a half-built runtime.
  let runtime: ServerRuntime | null = null;
  const getRuntime = (): ServerRuntime | null => runtime;

  // 7. Memory.
  const memory = createNotifiedMemory(PUSH_LIMITS.memoryMaxPerDevice);
  // 8. Signer and APNs client (connects lazily on first send).
  const apns = push.apns;
  const signer = createProviderTokenSigner(apns.key, apns.keyId, apns.teamId, clock);
  const apnsClient = createApnsClient(apns, signer, { origins, ...(ca !== undefined ? { ca } : {}), clock, timers });
  parts.apnsClient = apnsClient;
  // 9. Delivery monitor.
  const monitor = createDeliveryMonitor({ clock });
  // 10–11. Queues. They subscribe to store.onRemoved themselves, dropping the device's FIFO, its notified memory
  // and its log limiter keys, so every removal cause clears them exactly once.
  const queues = createDeviceQueues({ apns: apnsClient, store, memory, signer, monitor, clock, timers, random, topic: apns.topic });
  parts.queues = queues;
  // 12. Pairing.
  const pairing = createPairingService({
    store,
    maxDevices: push.maxDevices,
    random,
    clock,
    externalUrl: config.externalUrl,
  });
  // 13. Intake; the badge is read at plan time from the attached runtime.
  const intake = createIntake({ store, memory, queues, badge: () => currentBadge(getRuntime()), clock, timers });
  parts.intake = intake;
  // 14. Sweep: one pass now, then one every sweepIntervalMs (the only interval bootstrap starts directly).
  const sweep = createSweep({ store, pairing, clock, timers });
  parts.sweep = sweep;

  // 15. Dispatcher, wrapped by the close guard.
  const services: ConfiguredPushServices = {
    state: "configured",
    identity: config.identity,
    externalUrl: config.externalUrl,
    maxDevices: push.maxDevices,
    webhook: push.webhook,
    admin: push.admin,
    webhookSecret: push.webhookSecret,
    operatorSecret: push.operatorSecret,
    topic: apns.topic,
    store,
    pairing,
    memory,
    queues,
    apns: apnsClient,
    signer,
    monitor,
    intake,
    getRuntime,
    clock,
    random,
    timers,
  };
  const inner = createPushDispatcher(Object.freeze(services));
  let closed = false;
  const dispatcher: PushDispatcher = async (ctx) =>
    closed && ctx.pathname.startsWith(PUSH_PATHS.prefix) ? pushErrorResponse("unavailable") : inner(ctx);

  // 16. Capability provider: present while the registry is loaded and its last write succeeded.
  const isPushAvailable = (): boolean => store.loadStatus === "ok" && !store.writeFailedSticky;
  registerCapabilityProvider(PUSH_CAPABILITY, isPushAvailable);

  // 17. Metrics provider.
  const uninstallMetrics = installPushMetrics({ state: "configured", store, delivery: monitor });

  // 18. Started.
  log({
    event: "push_started",
    ok: true,
    state: "configured",
    webhook: push.webhook,
    admin: push.admin,
    devices: store.list().length,
  });

  const close = onceClose(async () => {
    closed = true; // the dispatcher guard starts refusing
    await closeParts(parts);
    await step(() => unregisterCapabilityProvider(PUSH_CAPABILITY));
    await step(() => uninstallMetrics()); // clears only if this runtime's provider is current
  });

  return Object.freeze({
    state: "configured" as const,
    dispatcher,
    attachRuntime: (next: ServerRuntime): void => {
      runtime = next;
    },
    close,
  });
}
