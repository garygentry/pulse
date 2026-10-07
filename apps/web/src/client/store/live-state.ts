// apps/web/src/client/store/live-state.ts — the unified auto/SSE/poll live-state machine
// (08-events-live-state-and-freshness-migration.md §§7–9).
//
// ONE state machine owns every timer, controller, stream, and callback. It supports three
// transports behind a single seam:
//   - `poll`: never opens an EventSource; serialized conditional GET of the active view every
//     `POLL_INTERVAL_MS`, using the active-view response as the control channel.
//   - `sse`: opens `/api/events`, treats each valid tick as the control channel, and falls back to
//     polling immediately on stream failure while retrying the stream at 10/20/40/60 s.
//   - `auto`: behaves as `sse` when an EventSource factory is available, else as `poll`.
//
// The control-tick cursor (`controlGeneration`/`controlSeq`) is kept separate from the highest
// observation accepted from HTTP (`observation`). Only a current SSE tick establishes the generation
// while SSE is authoritative; a generation mismatch from an ordinary view GET triggers a serialized
// stream reconnect rather than switching generation directly. Every fetch captures the epoch,
// generation, and an incremented per-view token, and its result is accepted only if all three still
// match — so a stale callback, a superseded request, a generation reset, or `stop()` can never
// resurrect old state. Polling, the SSE control channel, the dev build-id check, and ViewHost share
// the single once-only `reloadOnce` guard.

import { batch } from "@preact/signals-core";

import {
  validateLiveTick,
  validateOverviewSnapshotV2,
  type CycleObservation,
  type ViewDeliveryFailure,
  type ViewDeliveryState,
  type ViewId,
} from "@pulse/web-data/wire";
import type {
  AlertsPayload,
  EnginePayload,
  EstatePayload,
  TimelinePayload,
} from "@pulse/web-data/wire";

import { POLL_INTERVAL_MS, POLL_STALE_MS, REFRESH_INTERVAL_MS } from "../../shared/constants.js";
import type { OverviewSnapshotV2 } from "@pulse/web-data/wire";
import { apiFetch, fetchDevBuildId, type ApiFetchOptions, type ApiFetchResult } from "../api/client.js";
import type { AppStore } from "./index.js";
import type { ConnectionPhase, ConnectionState, Transport } from "./types.js";

/** The five current-cycle routes, keyed by `ViewId` (08 §8). */
const VIEW_PATH: Readonly<Record<ViewId, string>> = {
  overview: "/api/overview",
  alerts: "/api/alerts",
  estate: "/api/estate",
  engine: "/api/engine",
  timeline: "/api/timeline",
};

/** The five `ViewId`s in nav order. Local literal (kept out of the view registry to avoid pulling
 *  React view modules into the store graph); `satisfies` pins it to the closed union. */
const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const satisfies readonly ViewId[];

/** Per-store refresh seam consumed by views without exposing fetch details. */
const VIEW_REFRESHERS = new WeakMap<AppStore, (view: ViewId) => void>();

/** Ask the active live-state machine to refresh one view. A store not yet started is a no-op. */
export function refetchView(store: AppStore, view: ViewId): void {
  VIEW_REFRESHERS.get(store)?.(view);
}

/** The SSE endpoint. */
const EVENTS_PATH = "/api/events" as const;

/** Deterministic reconnect backoff after an SSE failure: 10, 20, 40, then 60 s and stays at 60; no
 *  jitter (§7). A valid tick resets the index to 0. */
const RECONNECT_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000, 60_000];

/** Dev-only fast build-id check; a null shell build id disables the loop. */
export interface DevBuildCheck {
  /** The shell's build id, or `null` in manifest-fallback mode. */
  buildId: string | null;
  /** Poll cadence; default `DEV_BUILD_CHECK_INTERVAL_MS`. */
  intervalMs?: number;
}

/** A minimal EventSource-shaped stream (the browser `EventSource` satisfies it structurally). Only
 *  the `tick`/`error` events and `close()` are used. */
export interface LiveEventSource {
  /** Register a listener for the named SSE event (`tick`) or the transport `error` event. */
  addEventListener(type: "tick" | "error", listener: (event: LiveMessageEvent) => void): void;
  /** Close the stream and release the connection. */
  close(): void;
}

/** The subset of a `MessageEvent` the tick handler reads. */
export interface LiveMessageEvent {
  /** The event `data:` payload (the canonical `LiveTick` JSON) for a `tick`; absent for `error`. */
  readonly data?: string;
}

/** Factory that opens a stream to the given URL. Injected in tests; defaults to the global
 *  `EventSource` when one exists, else `null` (which forces polling in `auto`/`sse`). */
export type EventSourceFactory = (url: string) => LiveEventSource;

/** The read-only next-kiosk-view seam (§8). Returns the upcoming rotation view and how soon the
 *  rotation is due, or `null` when rotation is inactive. This machine reads it but never drives
 *  rotation UX. */
export interface NextKioskView {
  /** The view the rotation will switch to next. */
  readonly view: ViewId;
  /** Milliseconds until that switch is due. */
  readonly dueWithinMs: number;
}

/** Options for `startLiveState`. `transport` selects the base behavior; every other field is an
 *  injectable seam (fetch, timers, clock, EventSource, view/kiosk read-outs) so the machine is fully
 *  deterministic under fake timers. */
export interface LiveStateOptions {
  /** Base transport: `auto` (SSE when available else poll), `sse`, or `poll`. */
  transport: "auto" | "sse" | "poll";
  /** Injectable fetch (tests, dev proxying). Default: global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Poll cadence for the active-view conditional GET; default `POLL_INTERVAL_MS`. */
  intervalMs?: number;
  /** Failure/stall window before `phase: "stale"`; default `POLL_STALE_MS`. */
  staleMs?: number;
  /** Raw reload; wrapped internally with a single-fire guard. Default `() => location.reload()`. */
  reload?: () => void;
  /** Dev build-id check, or null/absent to disable it. */
  devBuildCheck?: DevBuildCheck | null;
  /** EventSource factory for `sse`/`auto`. Default: global `EventSource` when present, else null. */
  eventSourceFactory?: EventSourceFactory | null;
  /** Injectable timer set. Default: global `setTimeout`. */
  setTimer?: typeof setTimeout;
  /** Injectable timer clear. Default: global `clearTimeout`. */
  clearTimer?: typeof clearTimeout;
  /** Injectable clock for freshness math. Default: `Date.now`. */
  now?: () => number;
  /** Read the currently active view, or null when no cycle view is active. Default: `store.route`. */
  activeView?: () => ViewId | null;
  /** Read the upcoming kiosk rotation, or null when inactive. Default: `() => null`. */
  nextKioskView?: () => NextKioskView | null;
}

/** Handle returned by `startLiveState`. */
export interface LiveStateHandle {
  /** Stop every loop/stream, abort in-flight fetches, clear all timers and callbacks. Idempotent. */
  stop(): void;
  /** Shared once-only reload for the control channels, the dev check, and ViewHost. */
  reloadOnce(): void;
  /** Publish or clear the shell-owned imminent kiosk view; views never call this seam. */
  setNextKioskView(next: NextKioskView | null): void;
  /** Clear any recorded failure and issue an unconditional request for one view. */
  refetch(view: ViewId): void;
}

/** Dev-only build-id poll cadence: 1 s poll + publication latency stays inside REQ-DEV-05's 2 s. */
export const DEV_BUILD_CHECK_INTERVAL_MS = 1_000 as const;

export function startLiveState(store: AppStore, opts: LiveStateOptions): LiveStateHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? POLL_STALE_MS;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const now = opts.now ?? Date.now;
  let publishedNextKioskView: { readonly view: ViewId; readonly dueAt: number } | null = null;
  const nextKioskView = opts.nextKioskView ?? ((): NextKioskView | null =>
    publishedNextKioskView === null
      ? null
      : { view: publishedNextKioskView.view, dueWithinMs: Math.max(0, publishedNextKioskView.dueAt - now()) });
  const devCheck = opts.devBuildCheck ?? null;

  const esFactory: EventSourceFactory | null =
    opts.eventSourceFactory !== undefined
      ? opts.eventSourceFactory
      : typeof EventSource !== "undefined"
        ? (url): LiveEventSource => new EventSource(url) as unknown as LiveEventSource
        : null;
  // `poll` never opens a stream; `sse`/`auto` use SSE only when a factory exists.
  const useSse = opts.transport !== "poll" && esFactory !== null;

  const resolveActiveView =
    opts.activeView ??
    ((): ViewId | null => {
      const view = store.route.peek().view;
      return (VIEW_IDS as readonly string[]).includes(view) ? (view as ViewId) : null;
    });

  // ── Machine state (§7) ────────────────────────────────────────────────────────────────────────
  let epoch = 0; // bumped on generation reset, SSE takeover, reconnect, and stop — invalidates fetches
  let stopped = false;
  let reloaded = false;

  let controlGeneration: string | null = null; // the control-tick cursor generation
  let controlSeq = 0; // the control-tick cursor sequence (advances only on control observations)

  let observation: CycleObservation | null = null; // highest accepted observation (tick or HTTP)
  let lastObservationAdvanceAt: number | null = null; // when observation.seq last increased
  let lastGoodAt: number | null = null;
  let failingSince: number | null = null;
  let localSeq = 0; // count of accepted NEW view payloads (mirrors the old ConnectionState.seq)

  let initialAppVersion: string | null = null; // one-time app-version reload guard (§8.3)
  let bootstrappedOverview = false; // initial overview fetch for estate identity/timezone (§8.6)

  const requestTokens: Record<ViewId, number> = { overview: 0, alerts: 0, estate: 0, engine: 0, timeline: 0 };
  const etags: Record<ViewId, string | null> = { overview: null, alerts: null, estate: null, engine: null, timeline: null };
  const accepted: Record<ViewId, string | null> = { overview: null, alerts: null, estate: null, engine: null, timeline: null };
  const desired: Record<ViewId, string | null> = { overview: null, alerts: null, estate: null, engine: null, timeline: null };
  const failures: Record<ViewId, ViewDeliveryFailure | null> = {
    overview: null,
    alerts: null,
    estate: null,
    engine: null,
    timeline: null,
  };

  const controllers = new Set<AbortController>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let devTimer: ReturnType<typeof setTimeout> | null = null;

  let es: LiveEventSource | null = null;
  let sseAuthoritative = false; // true once a valid tick has been accepted on the open stream
  let reconnectIdx = 0; // index into RECONNECT_DELAYS_MS

  const rawReload: () => void = opts.reload ?? ((): void => location.reload());

  /** Single-fire reload wrapper shared by the app-version guard, the dev build-id loop, and
   *  ViewHost's chunk-mismatch escalation (REQ-CONC-03, CON-08). Later calls are silent no-ops. */
  const reloadOnce = (): void => {
    if (reloaded) return;
    reloaded = true;
    clearAllTimers();
    rawReload();
  };

  function clearAllTimers(): void {
    if (pollTimer !== null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    if (devTimer !== null) {
      clearTimer(devTimer);
      devTimer = null;
    }
  }

  function abortControllers(): void {
    for (const c of controllers) c.abort();
    controllers.clear();
  }

  // ── Connection publication ──────────────────────────────────────────────────────────────────
  function currentTransport(): Transport {
    return sseAuthoritative ? "sse" : "poll";
  }

  function isStale(): boolean {
    const t = now();
    if (failingSince !== null && t - failingSince > staleMs) return true;
    if (lastObservationAdvanceAt !== null && t - lastObservationAdvanceAt > staleMs) return true;
    return false;
  }

  function computePhase(): ConnectionPhase {
    if (observation === null && lastGoodAt === null) return "initial";
    if (isStale()) return "stale";
    if (observation === null) return "initial";
    return "live";
  }

  function computeViews(): Record<ViewId, ViewDeliveryState> {
    const stale = isStale();
    const out = {} as Record<ViewId, ViewDeliveryState>;
    for (const v of VIEW_IDS) {
      const acc = accepted[v];
      if (acc === null) {
        out[v] = { phase: "initial", identity: null, failure: failures[v] };
        continue;
      }
      const matches = desired[v] === null || desired[v] === acc;
      out[v] = {
        phase: matches && !stale ? "current" : "stale",
        identity: acc as ViewDeliveryState["identity"],
        failure: failures[v],
      };
    }
    return out;
  }

  function publishConnection(): void {
    const prev = store.connection.peek();
    const next: ConnectionState = {
      phase: computePhase(),
      transport: currentTransport(),
      lastGoodAt,
      failingSince,
      seq: localSeq,
      observation,
      views: computeViews(),
    };
    if (!connectionEquals(prev, next)) store.connection.value = next;
  }

  // ── Observation acceptance (§8) ───────────────────────────────────────────────────────────────
  function acceptObservationValue(obs: CycleObservation): void {
    const advanced =
      observation === null || obs.generation !== observation.generation || obs.seq > observation.seq;
    if (advanced) {
      observation = obs;
      lastObservationAdvanceAt = now();
    }
  }

  /** Handle an observation arriving on the CURRENT CONTROL channel (a valid SSE tick, or a poll
   *  active-view response). Applies the §8 generation/sequence rules; `tickIdentities` is the
   *  five-view desired map for an SSE tick, or null for a poll response. Returns `true` when a new
   *  generation was accepted (a reset), so the caller can force-revalidate active/kiosk views. */
  function onControlObservation(obs: CycleObservation, tickIdentities: Readonly<Record<ViewId, string>> | null): boolean {
    if (controlGeneration !== obs.generation) {
      onGenerationReset(obs, tickIdentities);
      return true;
    }
    if (obs.seq <= controlSeq) return false; // duplicate/late control tick — ignore (§8.1)
    controlSeq = obs.seq;
    acceptObservationValue(obs);
    if (tickIdentities !== null) applyDesired(tickIdentities);
    return false;
  }

  /** A new generation on the control channel (§8.2). Resets the cursor/ETags, invalidates
   *  prior-generation fetch tokens, retains payloads only as stale context, and runs the app-version
   *  guard. The caller drives the subsequent force-revalidation (the poll loop, or the tick handler). */
  function onGenerationReset(obs: CycleObservation, tickIdentities: Readonly<Record<ViewId, string>> | null): void {
    epoch += 1; // invalidate every in-flight prior-generation fetch token
    abortControllers();
    controlGeneration = obs.generation;
    controlSeq = obs.seq;
    observation = obs;
    lastObservationAdvanceAt = now();
    for (const v of VIEW_IDS) {
      etags[v] = null; // reset response ordering / conditional validators for the new generation
      desired[v] = null; // payloads retained only as stale context until revalidated
    }
    if (tickIdentities !== null) applyDesired(tickIdentities);
    runVersionGuard(obs.appVersion);
  }

  /** Set the desired identity map from an SSE tick; views whose accepted identity no longer matches
   *  become stale (§8.4). */
  function applyDesired(identities: Readonly<Record<ViewId, string>>): void {
    for (const v of VIEW_IDS) desired[v] = identities[v];
  }

  /** The one-time app-version guard (§8.3): a different version reloads once; a same-version restart
   *  (new generation, same version) does not reload. */
  function runVersionGuard(appVersion: string): void {
    if (initialAppVersion === null) {
      initialAppVersion = appVersion;
      return;
    }
    if (appVersion !== initialAppVersion) reloadOnce();
  }

  function markContact(): void {
    lastGoodAt = now();
    failingSince = null;
  }

  function onTransportFailure(): void {
    if (failingSince === null) failingSince = now();
    publishConnection();
  }

  // ── View fetching (§8) ────────────────────────────────────────────────────────────────────────
  /** Whether view `v` needs a (re)fetch: never delivered, or its accepted identity no longer matches
   *  the desired identity from the latest tick. Hash strings are compared for equality only. */
  function needsFetch(v: ViewId): boolean {
    if (accepted[v] === null) return true;
    return desired[v] !== null && desired[v] !== accepted[v];
  }

  /** The set of views to (re)fetch now: the bootstrap overview (once), the active view, and the next
   *  kiosk view only when its rotation is due within one core cycle (§8.5/§8.6). */
  function fetchTargets(): ViewId[] {
    const out: ViewId[] = [];
    if (!bootstrappedOverview) out.push("overview");
    const active = resolveActiveView();
    if (active !== null && !out.includes(active)) out.push(active);
    const kiosk = nextKioskView();
    if (kiosk !== null && kiosk.dueWithinMs <= REFRESH_INTERVAL_MS && !out.includes(kiosk.view)) {
      out.push(kiosk.view);
    }
    return out;
  }

  function refetchViews(force: boolean): void {
    for (const v of fetchTargets()) {
      if (force || needsFetch(v)) void fetchView(v);
    }
  }

  async function fetchView(view: ViewId): Promise<void> {
    if (stopped || reloaded) return;
    const myEpoch = epoch;
    const myToken = (requestTokens[view] += 1);
    const controller = new AbortController();
    controllers.add(controller);
    const etag = etags[view];
    const options: ApiFetchOptions = {
      signal: controller.signal,
      ...(etag !== null ? { etag } : {}),
    };
    let result: ApiFetchResult<unknown>;
    try {
      result = await apiFetch<unknown>(VIEW_PATH[view], options, fetchImpl);
    } finally {
      controllers.delete(controller);
    }
    // Reject a superseded callback: stop(), an epoch bump (generation reset / takeover / reconnect),
    // or a newer request for this same view (token supersession).
    if (stopped || reloaded || myEpoch !== epoch || myToken !== requestTokens[view]) return;
    onViewResult(view, result);
  }

  function onViewResult(view: ViewId, result: ApiFetchResult<unknown>): void {
    if (result.status === "error") {
      failures[view] = {
        code: result.error.code,
        status: result.httpStatus,
        message: result.error.message,
      };
      onTransportFailure();
      return;
    }
    failures[view] = null;
    const obs = result.observation;
    // While SSE is authoritative, a view GET must NOT switch generation: a mismatch triggers a
    // serialized stream reconnect/resync instead (§7).
    if (sseAuthoritative && obs !== null && controlGeneration !== null && obs.generation !== controlGeneration) {
      reconnectStream();
      return;
    }

    const polling = !sseAuthoritative; // during polling the active-view GET is the control channel

    if (result.status === "not-modified") {
      markContact();
      if (view === "overview") bootstrappedOverview = true;
      if (obs !== null) {
        if (polling) onControlObservation(obs, null);
        else acceptObservationValue(obs);
      }
      publishConnection(); // 304 updates observation/connection but not the payload signal (§8)
      return;
    }

    let payload = result.value;
    if (view === "overview") {
      const validated = validateOverviewSnapshotV2(payload);
      if (!validated.ok) {
        // Preserve a prior accepted body but make its delivery stale immediately. A malformed first
        // body leaves the signal and delivery in their initial states; no partial value is committed.
        desired.overview = result.identity;
        onTransportFailure();
        return;
      }
      payload = validated.value;
    }

    // 200: reject a response older than the latest accepted observation when its identity differs
    // from the desired one (§8), then refetch — never accept stale data.
    if (
      obs !== null &&
      observation !== null &&
      obs.generation === observation.generation &&
      obs.seq < observation.seq &&
      result.identity !== desired[view]
    ) {
      void fetchView(view);
      return;
    }

    markContact();
    if (view === "overview") bootstrappedOverview = true;
    if (obs !== null) {
      if (polling) onControlObservation(obs, null);
      else acceptObservationValue(obs);
    }

    const id = result.identity;
    const isNewIdentity = accepted[view] !== id;
    etags[view] = result.etag;
    accepted[view] = id;
    desired[view] = id; // the view we just fetched is current at this identity until a tick advances it

    batch(() => {
      writeViewPayload(store, view, payload);
      if (isNewIdentity) localSeq += 1;
      publishConnection();
    });
  }

  // ── SSE control channel (§7) ──────────────────────────────────────────────────────────────────
  function openStream(): void {
    if (stopped || reloaded || esFactory === null) return;
    const source = esFactory(EVENTS_PATH);
    es = source;
    source.addEventListener("tick", onStreamTick);
    source.addEventListener("error", onStreamError);
  }

  function onStreamTick(event: LiveMessageEvent): void {
    if (stopped || reloaded || es === null) return;
    const data = event.data;
    if (data === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      onStreamProtocolFailure();
      return;
    }
    const tick = validateLiveTick(parsed);
    if (tick === null) {
      onStreamProtocolFailure(); // malformed tick is a protocol failure (§11): never partially accept
      return;
    }
    // The first valid tick takes authority: bump epoch (invalidate any in-flight poll fetches), abort
    // the pending poll, stop polling, and reset the reconnect backoff — before the stream becomes
    // authoritative (§9).
    if (!sseAuthoritative) {
      epoch += 1;
      abortControllers();
      if (pollTimer !== null) {
        clearTimer(pollTimer);
        pollTimer = null;
      }
      sseAuthoritative = true;
    }
    reconnectIdx = 0; // a valid tick resets the backoff to 10 s (§7)
    const reset = onControlObservation(tick.observation, tick.identities);
    if (stopped || reloaded) return;
    markContact();
    publishConnection();
    refetchViews(reset); // a generation reset force-revalidates active/kiosk even if identities match
  }

  function onStreamError(): void {
    if (stopped || reloaded) return;
    onStreamFailure();
  }

  function onStreamProtocolFailure(): void {
    onStreamFailure();
  }

  /** Close the authoritative stream, begin polling immediately, and schedule a backed-off reconnect
   *  (§7/§11). Retains the last-good payloads as stale context. */
  function onStreamFailure(): void {
    closeStream();
    sseAuthoritative = false;
    onTransportFailure();
    startPollingNow();
    scheduleReconnect();
  }

  /** A generation mismatch seen on an ordinary view GET while SSE controls: serialized stream
   *  reconnect/resync (§7). Reconnect is immediate (this is a resync, not a backoff failure). */
  function reconnectStream(): void {
    closeStream();
    sseAuthoritative = false;
    epoch += 1;
    abortControllers();
    openStream();
  }

  function scheduleReconnect(): void {
    if (stopped || reloaded || esFactory === null) return;
    if (reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectIdx, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
    reconnectIdx += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (stopped || reloaded) return;
      openStream();
    }, delay);
  }

  function closeStream(): void {
    if (es !== null) {
      es.close();
      es = null;
    }
  }

  // ── Poll control channel (§9) ─────────────────────────────────────────────────────────────────
  function startPollingNow(): void {
    if (stopped || reloaded || sseAuthoritative) return;
    if (pollTimer !== null) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      void pollCycle();
    }, 0);
  }

  function schedulePoll(): void {
    if (stopped || reloaded || sseAuthoritative) return;
    if (pollTimer !== null) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      void pollCycle();
    }, intervalMs);
  }

  async function pollCycle(): Promise<void> {
    if (stopped || reloaded || sseAuthoritative) return;
    const targets = fetchTargets();
    if (targets.length === 0) targets.push("overview"); // keep overview as the fallback control
    for (const v of targets) {
      if (stopped || reloaded || sseAuthoritative) break;
      await fetchView(v); // serialized: one active-view response at a time (§7/§9)
    }
    if (stopped || reloaded || sseAuthoritative) return;
    publishConnection(); // re-evaluate stall/stale purely from elapsed time
    schedulePoll();
  }

  // ── Dev build-id check (unchanged; shares reloadOnce) ─────────────────────────────────────────
  function scheduleDevCheck(): void {
    const tick = async (): Promise<void> => {
      devTimer = null;
      if (stopped || reloaded) return;
      const remoteId = await fetchDevBuildId(fetchImpl);
      if (stopped || reloaded) return;
      if (remoteId !== null && remoteId !== devCheck?.buildId) {
        reloadOnce();
        return;
      }
      devTimer = setTimer(() => {
        void tick();
      }, devCheck?.intervalMs ?? DEV_BUILD_CHECK_INTERVAL_MS);
    };
    devTimer = setTimer(() => {
      void tick();
    }, devCheck?.intervalMs ?? DEV_BUILD_CHECK_INTERVAL_MS);
  }

  // ── Route-change fetches ──────────────────────────────────────────────────────────────────────
  // `Signal.subscribe` fires once synchronously on registration; skip that call (the initial fetch
  // is driven by the poll/stream start below) and act only on real navigations afterwards.
  let routeInit = true;
  const unsubscribeRoute = store.route.subscribe(() => {
    if (routeInit || stopped || reloaded) return;
    const active = resolveActiveView();
    if (active !== null && needsFetch(active)) void fetchView(active);
  });
  routeInit = false;

  /** Explicit user retry: clear the visible failure and supersede any in-flight request. */
  const refetch = (view: ViewId): void => {
    if (stopped || reloaded) return;
    failures[view] = null;
    publishConnection();
    void fetchView(view);
  };

  // ── Start ─────────────────────────────────────────────────────────────────────────────────────
  VIEW_REFRESHERS.set(store, refetch);
  if (useSse) openStream();
  else startPollingNow();
  if (devCheck !== null && devCheck.buildId !== null) scheduleDevCheck();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      epoch += 1; // supersede every in-flight callback (§7)
      unsubscribeRoute();
      closeStream();
      abortControllers();
      clearAllTimers();
      VIEW_REFRESHERS.delete(store);
    },
    reloadOnce,
    setNextKioskView(next): void {
      publishedNextKioskView = next === null
        ? null
        : { view: next.view, dueAt: now() + Math.max(0, next.dueWithinMs) };
    },
    refetch,
  };
}

/** Route one accepted view payload to its store signal. Every slot keeps its existing signal
 *  identity; overview reaches this helper only after runtime validation. */
function writeViewPayload(store: AppStore, view: ViewId, value: unknown): void {
  switch (view) {
    case "overview":
      store.snapshot.value = value as OverviewSnapshotV2;
      break;
    case "alerts":
      store.alerts.value = value as AlertsPayload;
      break;
    case "estate":
      store.estate.value = value as EstatePayload;
      break;
    case "engine":
      store.engine.value = value as EnginePayload;
      break;
    case "timeline":
      store.timeline.value = value as TimelinePayload;
      break;
  }
}

/** Field-wise comparison (including observation reference and per-view delivery) so a repeated
 *  identical connection state does not re-render subscribers. */
function connectionEquals(a: ConnectionState, b: ConnectionState): boolean {
  if (
    a.phase !== b.phase ||
    a.transport !== b.transport ||
    a.lastGoodAt !== b.lastGoodAt ||
    a.failingSince !== b.failingSince ||
    a.seq !== b.seq ||
    a.observation !== b.observation
  ) {
    return false;
  }
  for (const v of VIEW_IDS) {
    const av = a.views[v];
    const bv = b.views[v];
    if (
      av.phase !== bv.phase ||
      av.identity !== bv.identity ||
      av.failure?.status !== bv.failure?.status ||
      av.failure?.message !== bv.failure?.message
    ) return false;
  }
  return true;
}
