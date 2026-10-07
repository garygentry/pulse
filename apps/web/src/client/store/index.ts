// apps/web/src/client/store/index.ts — the AppStore (REQ-STORE-01/02/04/07).
//
// A plain object of independently subscribable signals — one signal per slot, created eagerly at
// construction. Cycle payload slots use their concrete browser-safe wire types behind stable signal
// identities.

import { batch, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals-core";
import type {
  AlertsPayload,
  EnginePayload,
  EstatePayload,
  TimelinePayload,
  OverviewSnapshotV2,
  ViewDeliveryState,
  ViewId,
} from "@pulse/web-data/wire";

import type { HostStatus } from "../../shared/snapshot.js";
import {
  createPreferenceStorage,
  PREF_KEYS,
  readDensity,
  readTheme,
  type PreferenceStorage,
} from "./preferences.js";
import type {
  ConnectionState,
  Density,
  RouteState,
  SelectedTarget,
  SessionState,
  Theme,
} from "./types.js";

/**
 * The single application store: a plain object of independently subscribable signals. `readonly`
 * is on the properties (the shape never changes); the signals themselves are writable
 * (`store.selection.value = t` is the write path). No class, no method layer.
 */
export interface AppStore {
  readonly snapshot: Signal<OverviewSnapshotV2 | null>;
  readonly alerts: Signal<AlertsPayload | null>;
  readonly engine: Signal<EnginePayload | null>;
  readonly estate: Signal<EstatePayload | null>;
  readonly timeline: Signal<TimelinePayload | null>;
  readonly connection: Signal<ConnectionState>;
  readonly route: Signal<RouteState>;
  readonly theme: Signal<Theme>;
  readonly density: Signal<Density>;
  readonly selection: Signal<SelectedTarget | null>;
  readonly session: Signal<SessionState | null>;
}

/** Construction options. */
export interface AppStoreOptions {
  /** Preference storage; `null` disables persistence entirely. Default: the guarded localStorage
   *  wrapper (`createPreferenceStorage()`), which itself may be `null`. */
  storage?: PreferenceStorage | null;
  /** The initial URL query (kiosk detection). Default: parsed `location.search` when a `window`
   *  exists, else `{}`. */
  initialQuery?: Readonly<Record<string, string>>;
}

/** Per-host derived signals — `HostSelectors` publishes only when a host's content actually
 *  changed, so a cell subscribed via `selectHost` does not re-render on identity churn from a
 *  wholesale `store.snapshot` replacement (REQ-PERF-04). */
export interface HostSelectors {
  /** The signal for `name`; stable across calls. `null` when the host is absent from the current
   *  snapshot (or before the first one). Read `.value` inside render to subscribe. */
  get(name: string): ReadonlySignal<HostStatus | null>;
  /** Stop tracking `store.snapshot` (test teardown). */
  dispose(): void;
}

interface HostCell {
  readonly sig: Signal<HostStatus | null>;
  key: string;
}

/** Sentinel `key` for "this host is not in the snapshot" — never a JSON value. */
const ABSENT = "\0absent" as const;

/** The initial per-view delivery state: absent, with no accepted identity or failure. */
const INITIAL_VIEW_DELIVERY: ViewDeliveryState = { phase: "initial", identity: null, failure: null };

/** Build the initial `views` map for every current-cycle view. */
function initialViews(): Record<ViewId, ViewDeliveryState> {
  return {
    overview: INITIAL_VIEW_DELIVERY,
    alerts: INITIAL_VIEW_DELIVERY,
    estate: INITIAL_VIEW_DELIVERY,
    engine: INITIAL_VIEW_DELIVERY,
    timeline: INITIAL_VIEW_DELIVERY,
  };
}

/** Parse `location.search` into a flat record (last value wins). Returns `{}` in a non-DOM
 *  process, so `createAppStore()` is safe before happy-dom is registered. */
function readLocationQuery(): Readonly<Record<string, string>> {
  const win = (globalThis as { window?: Window }).window;
  if (win === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(win.location.search)) out[key] = value;
  return out;
}

/** Build a store at the documented defaults. */
export function createAppStore(opts: AppStoreOptions = {}): AppStore {
  const storage: PreferenceStorage | null =
    opts.storage === undefined ? createPreferenceStorage() : opts.storage;
  const initialQuery = opts.initialQuery ?? readLocationQuery();
  const kiosk = initialQuery["kiosk"] === "1";

  const store: AppStore = {
    snapshot: signal<OverviewSnapshotV2 | null>(null),
    alerts: signal<AlertsPayload | null>(null),
    engine: signal<EnginePayload | null>(null),
    estate: signal<EstatePayload | null>(null),
    timeline: signal<TimelinePayload | null>(null),
    connection: signal<ConnectionState>({
      phase: "initial",
      transport: "poll",
      lastGoodAt: null,
      failingSince: null,
      seq: 0,
      observation: null,
      views: initialViews(),
    }),
    route: signal<RouteState>({ path: "/", view: "", params: {}, query: {} }),
    theme: signal<Theme>(readTheme(storage)),
    density: signal<Density>(kiosk ? "wallboard" : readDensity(storage)),
    selection: signal<SelectedTarget | null>(null),
    session: signal<SessionState | null>(null),
  };

  installPreferenceWriteback(store, storage, kiosk);
  return store;
}

/** Persist theme (and, outside kiosk, density) on every change. A `set` that throws disables
 *  further writes for this store — the store keeps working in memory. */
function installPreferenceWriteback(
  store: AppStore,
  storage: PreferenceStorage | null,
  kiosk: boolean,
): void {
  if (storage === null) return;
  let writesDisabled = false;
  const persist = (key: string, value: string): void => {
    if (writesDisabled) return;
    try {
      storage.set(key, value);
    } catch {
      writesDisabled = true;
    }
  };
  effect(() => {
    persist(PREF_KEYS.theme, store.theme.value);
  });
  if (!kiosk) {
    effect(() => {
      persist(PREF_KEYS.density, store.density.value);
    });
  }
}

/**
 * Per-host slices of `store.snapshot`, published only when a host's content actually changed
 * (REQ-PERF-04). ONE effect per store, O(hosts) per poll — not one effect per host.
 */
export function createHostSelectors(store: AppStore): HostSelectors {
  const cells = new Map<string, HostCell>();
  /** Content fingerprint. Every host object comes from `JSON.parse` of the server response, so
   *  key order is stable across polls. */
  const fingerprint = (host: HostStatus): string => JSON.stringify(host);

  const dispose = effect(() => {
    const hosts = store.snapshot.value?.hosts ?? [];
    batch(() => {
      const seen = new Set<string>();
      for (const host of hosts) {
        seen.add(host.name);
        const key = fingerprint(host);
        const cell = cells.get(host.name);
        if (cell === undefined) {
          cells.set(host.name, { sig: signal<HostStatus | null>(host), key });
        } else if (cell.key !== key) {
          cell.key = key;
          cell.sig.value = host;
        }
      }
      for (const [name, cell] of cells) {
        if (!seen.has(name) && cell.sig.peek() !== null) {
          cell.key = ABSENT;
          cell.sig.value = null;
        }
      }
    });
  });

  return {
    get(name: string): ReadonlySignal<HostStatus | null> {
      let cell = cells.get(name);
      if (cell === undefined) {
        const host = store.snapshot.peek()?.hosts.find((h) => h.name === name) ?? null;
        cell = {
          sig: signal<HostStatus | null>(host),
          key: host === null ? ABSENT : fingerprint(host),
        };
        cells.set(name, cell);
      }
      return cell.sig;
    },
    dispose,
  };
}

const SELECTORS = new WeakMap<AppStore, HostSelectors>();

/**
 * Memoised per (store, name): `selectHost(store, "harbor-web-01")` returns the same signal on
 * every call, so a component may call it during render (REQ-PERF-04, REQ-SCALE-01).
 */
export function selectHost(store: AppStore, name: string): ReadonlySignal<HostStatus | null> {
  let selectors = SELECTORS.get(store);
  if (selectors === undefined) {
    selectors = createHostSelectors(store);
    SELECTORS.set(store, selectors);
  }
  return selectors.get(name);
}
