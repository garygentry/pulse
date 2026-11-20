// Device registry store: loads `<dataDir>/push/devices.json`, serves O(1) synchronous reads, and persists every
// change through one serialised write chain (persist, then publish). Soft fields (seenAt, lastDelivery) are
// coalesced into at most one write per flush interval, and removals are logged, counted and published here only.

import { readFile as nodeReadFile } from "node:fs/promises";
import { canonicalJson } from "@pulse/web-data/cycle";
import type { LastDelivery } from "@pulse/web-data/wire";

import { log } from "../../log.js";
import {
  writeFileAtomic,
  type AtomicWriteOptions,
  type AtomicWriteResult,
} from "../../mutations/stores/atomic-file.js";
import { recordPushPairingEvent, type PushPairingEvent } from "../../routes/metrics.js";
import { PUSH_LIMITS } from "../constants.js";
import type { Timers } from "../dispatch/queue.js";
import type { Clock } from "../ids.js";
import { PushInvariantError } from "../refusal.js";
import { devicesFileSchema, type DeviceRecord, type DeviceRemovalReason, type DevicesFile } from "./schema.js";

/** Outcome of loading `devices.json`. */
export type StoreLoadStatus = "ok" | "corrupt";

/** A mutation step: returns the next device array, or an abort value that leaves state untouched. */
export type StoreStep<A> = (devices: readonly DeviceRecord[]) =>
  | {
      /** Persist and publish `devices`. */
      readonly kind: "commit";
      /** The complete next device array. */
      readonly devices: readonly DeviceRecord[];
      /** Value handed back to the caller. */
      readonly result: A;
    }
  | {
      /** Leave state untouched. */
      readonly kind: "abort";
      /** Value handed back to the caller. */
      readonly result: A;
    };

/** Result of {@link DeviceStore.mutate}. */
export type StoreMutateResult<A> =
  | {
      /** The step ran and, on commit, the write succeeded. */
      readonly ok: true;
      /** The step's result value. */
      readonly result: A;
    }
  | {
      /** The commit's write failed; in-memory state is unchanged. */
      readonly ok: false;
      /** The failure kind. */
      readonly error: "write-failed";
    };

/** The registry as seen by routes, the planner, the queues and the sweep. */
export interface DeviceStore {
  /** Outcome of loading `devices.json`; `corrupt` makes push misconfigured. */
  readonly loadStatus: StoreLoadStatus;
  /** True after a failed write until the next successful one. */
  readonly writeFailedSticky: boolean;
  /** Snapshot of every device, in registry order. */
  list(): readonly DeviceRecord[];
  /** Device by id; `undefined` when unknown. */
  get(id: string): DeviceRecord | undefined;
  /** O(1) lookup by hex credential hash; callers still confirm with digestEquals. */
  byCredentialHash(hash: string): DeviceRecord | undefined;
  /**
   * Serialised, persist-then-publish mutation. A commit that removes devices must pass `removalReason` (it drives
   * onRemoved, logs and counters); without one it rejects with PushInvariantError.
   */
  mutate<A>(step: StoreStep<A>, removalReason?: DeviceRemovalReason): Promise<StoreMutateResult<A>>;
  /** Record a soft-field change (seenAt, lastDelivery) for the next coalesced flush. */
  touchSoft(id: string, patch: SoftPatch): void;
  /** Flush pending soft fields now (used by close()). */
  flushSoft(): Promise<void>;
  /** Removal listener; the queues use it to drop a removed device's FIFO. Returns an idempotent unsubscribe. */
  onRemoved(listener: (id: string, reason: DeviceRemovalReason) => void): () => void;
}

/**
 * The concrete store. It widens DeviceStore.mutate's documentation with the removal reason, so that removals are
 * logged, counted and published to onRemoved listeners with the right reason.
 */
export interface RegistryStore extends DeviceStore {
  /**
   * Serialised, persist-then-publish mutation.
   * @param step - receives the current array (committed state with pending soft fields applied)
   * @param removalReason - required if a committed step removes any device
   */
  mutate<A>(step: StoreStep<A>, removalReason?: DeviceRemovalReason): Promise<StoreMutateResult<A>>;
}

/** Refuse to parse a devices.json larger than this (100 devices is about 40 KB). Larger → corrupt. */
export const DEVICES_FILE_MAX_BYTES = 1_048_576;

/** Dependencies of the device store; every field has a production default except clock and timers. */
export interface DeviceStoreDeps {
  /** Time source shared with the store's callers (soft-field instants are stamped by the caller). */
  readonly clock: Clock;
  /** Schedules the coalesced soft-field flush. */
  readonly timers: Timers;
  /** Reads the file. ENOENT must reject with an error whose `code` is "ENOENT". Default: node:fs/promises. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  /** Default: writeFileAtomic. Tests inject failures here. */
  readonly writeFile?: (path: string, bytes: Uint8Array, options: AtomicWriteOptions) => Promise<AtomicWriteResult>;
}

/** A pending soft update. Later touches overwrite earlier ones field by field. */
export type SoftPatch = { readonly seenAt?: string; readonly lastDelivery?: LastDelivery };

/** Pairing-event counter per removal reason; `self` and `superseded` are logged only. */
const REMOVAL_EVENT: Readonly<Record<DeviceRemovalReason, PushPairingEvent | null>> = Object.freeze({
  revoked: "revoked",
  expired: "expired",
  "dead-token": "removed_dead",
  self: null,
  superseded: null,
});

const STORE_FILE_MODE = 0o600;

type LoadResult = { readonly status: "ok"; readonly devices: readonly DeviceRecord[] } | { readonly status: "corrupt" };

async function defaultReadFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await nodeReadFile(path));
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** Freeze one record and its nested objects (records are never mutated in place). */
function freezeRecord(record: DeviceRecord): DeviceRecord {
  if (Object.isFrozen(record)) return record;
  Object.freeze(record.preferences);
  if (record.lastDelivery !== null) Object.freeze(record.lastDelivery);
  return Object.freeze(record);
}

function freezeDevices(devices: readonly DeviceRecord[]): readonly DeviceRecord[] {
  return Object.freeze(devices.map(freezeRecord));
}

async function loadDevices(path: string, read: (path: string) => Promise<Uint8Array>): Promise<LoadResult | null> {
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    return { status: "corrupt" };
  }
  if (bytes.byteLength > DEVICES_FILE_MAX_BYTES) return { status: "corrupt" };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { status: "corrupt" };
  }
  const parsed = devicesFileSchema.safeParse(raw);
  if (!parsed.success) return { status: "corrupt" };
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const device of parsed.data.devices) {
    if (ids.has(device.id) || hashes.has(device.credentialHash)) return { status: "corrupt" };
    ids.add(device.id);
    hashes.add(device.credentialHash);
  }
  return { status: "ok", devices: parsed.data.devices };
}

/** Apply soft patches to records (copy on write; untouched records are kept by identity). */
function applySoft(devices: readonly DeviceRecord[], patches: ReadonlyMap<string, SoftPatch>): readonly DeviceRecord[] {
  if (patches.size === 0) return devices;
  return freezeDevices(
    devices.map((device) => {
      const patch = patches.get(device.id);
      return patch === undefined ? device : { ...device, ...patch };
    }),
  );
}

/**
 * Load `<dataDir>/push/devices.json` and return the store. Never rejects for a file or content problem.
 *
 * @param path - absolute path, `join(dataDir, "push", "devices.json")`; its directory exists
 * @param deps - see DeviceStoreDeps
 */
export async function createDeviceStore(path: string, deps: DeviceStoreDeps): Promise<RegistryStore> {
  const writeFile = deps.writeFile ?? writeFileAtomic;
  const loaded = (await loadDevices(path, deps.readFile ?? defaultReadFile)) ?? { status: "ok", devices: [] };
  const loadStatus: StoreLoadStatus = loaded.status;
  if (loaded.status === "corrupt") log({ event: "push_registry_corrupt", ok: false, path: "devices.json" });

  /** What is on disk. */
  let committed: readonly DeviceRecord[] = loaded.status === "ok" ? freezeDevices(loaded.devices) : Object.freeze([]);
  /** Soft fields not yet persisted. */
  let pending = new Map<string, SoftPatch>();
  /** Soft patches taken by the step currently persisting; still shown by reads until it settles. */
  let inflight: ReadonlyMap<string, SoftPatch> = new Map();
  let view: readonly DeviceRecord[] = committed;
  let byId: ReadonlyMap<string, DeviceRecord> = new Map();
  let byHash: ReadonlyMap<string, DeviceRecord> = new Map();
  let chain: Promise<unknown> = Promise.resolve();
  let sticky = false;
  let flushTimer: unknown = null;
  const listeners: Array<{ readonly fn: (id: string, reason: DeviceRemovalReason) => void }> = [];

  function rebuild(): void {
    view = applySoft(applySoft(committed, inflight), pending);
    byId = new Map(view.map((d) => [d.id, d]));
    byHash = new Map(view.map((d) => [d.credentialHash, d]));
  }
  rebuild();

  function serialize<T>(step: () => Promise<T>): Promise<T> {
    const next = chain.then(step, step);
    chain = next.catch(() => undefined);
    return next;
  }

  /** Take every pending patch for a persisting step. */
  function take(): Map<string, SoftPatch> {
    const taken = pending;
    pending = new Map();
    inflight = taken;
    return taken;
  }

  /** Return taken patches after an abort or failure; a newer touch wins field by field. */
  function mergeBack(taken: ReadonlyMap<string, SoftPatch>): void {
    for (const [id, patch] of taken) pending.set(id, { ...patch, ...pending.get(id) });
    inflight = new Map();
    rebuild();
  }

  function noteWriteFailure(w: Extract<AtomicWriteResult, { ok: false }>): void {
    log({ event: "push_registry_write_failed", ok: false, step: w.step, code: w.code });
    if (!sticky) {
      sticky = true;
      log({ event: "push_registry_degraded", ok: false });
    }
  }

  /** Persist `devices`; on success make them the committed state. Returns false on a write failure. */
  async function persist(devices: readonly DeviceRecord[], taken: ReadonlyMap<string, SoftPatch>): Promise<boolean> {
    const file: DevicesFile = { formatVersion: 1, devices };
    let w: AtomicWriteResult;
    try {
      w = await writeFile(path, canonicalJson(file), { mode: STORE_FILE_MODE });
    } catch (err) {
      mergeBack(taken);
      throw err;
    }
    if (!w.ok) {
      mergeBack(taken);
      noteWriteFailure(w);
      return false;
    }
    committed = freezeDevices(devices);
    inflight = new Map();
    const present = new Set(committed.map((d) => d.id));
    for (const id of pending.keys()) if (!present.has(id)) pending.delete(id);
    rebuild();
    if (sticky) {
      sticky = false;
      log({ event: "push_registry_recovered", ok: true });
    }
    return true;
  }

  function publishRemovals(removed: readonly string[], reason: DeviceRemovalReason): void {
    const event = REMOVAL_EVENT[reason];
    const current = listeners.slice();
    for (const deviceId of removed) {
      log({ event: "push_device_removed", ok: true, deviceId, reason });
      if (event !== null) recordPushPairingEvent(event);
      for (const listener of current) {
        try {
          listener.fn(deviceId, reason);
        } catch {
          log({ event: "push_internal_error", ok: false, route: "registry.onRemoved" });
        }
      }
    }
  }

  async function run<A>(step: StoreStep<A>, removalReason: DeviceRemovalReason | undefined): Promise<StoreMutateResult<A>> {
    const taken = take();
    const base = applySoft(committed, taken);
    let outcome: ReturnType<StoreStep<A>>;
    try {
      outcome = step(base);
    } catch (err) {
      mergeBack(taken);
      throw err;
    }
    if (outcome.kind === "abort") {
      mergeBack(taken);
      return { ok: true, result: outcome.result };
    }
    const nextIds = new Set(outcome.devices.map((d) => d.id));
    const removed = base.filter((d) => !nextIds.has(d.id)).map((d) => d.id);
    if (removed.length > 0 && removalReason === undefined) {
      mergeBack(taken);
      throw new PushInvariantError("removal without reason");
    }
    if (!(await persist(outcome.devices, taken))) return { ok: false, error: "write-failed" };
    if (removed.length > 0 && removalReason !== undefined) publishRemovals(removed, removalReason);
    return { ok: true, result: outcome.result };
  }

  async function flushSoft(): Promise<void> {
    if (flushTimer !== null) {
      deps.timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (loadStatus === "corrupt") return;
    await serialize(async () => {
      if (pending.size === 0) return;
      const taken = take();
      await persist(applySoft(committed, taken), taken);
    }).catch(() => undefined);
  }

  const store: RegistryStore = {
    get loadStatus() {
      return loadStatus;
    },
    get writeFailedSticky() {
      return sticky;
    },
    list: () => view,
    get: (id) => byId.get(id),
    byCredentialHash: (hash) => byHash.get(hash),
    mutate<A>(step: StoreStep<A>, removalReason?: DeviceRemovalReason): Promise<StoreMutateResult<A>> {
      if (loadStatus === "corrupt") return Promise.resolve({ ok: false, error: "write-failed" });
      return serialize(async () => run(step, removalReason));
    },
    touchSoft(id, patch) {
      if (loadStatus === "corrupt" || !byId.has(id)) return;
      pending.set(id, { ...pending.get(id), ...patch });
      rebuild();
      if (flushTimer === null) {
        flushTimer = deps.timers.setTimeout(() => {
          flushTimer = null;
          void flushSoft();
        }, PUSH_LIMITS.softFlushMs);
      }
    },
    flushSoft,
    onRemoved(fn) {
      const entry = { fn };
      listeners.push(entry);
      return () => {
        const index = listeners.indexOf(entry);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  return store;
}
