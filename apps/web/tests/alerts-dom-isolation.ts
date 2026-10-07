// apps/web/tests/alerts-dom-isolation.ts — restore `globalThis` after an alerts DOM test file.
//
// `registerHappyDom` (tests/happy-dom.ts) copies the window's props onto `globalThis` and
// `unregisterHappyDom` only closes the window — `window`/`document`/`console`/`process`/… stay
// behind. `bun test` runs files in directory (readdir) order, so a DOM file that happens to land
// before a non-DOM suite (store.test.ts expects `globalThis.window` undefined) breaks it. Calling
// `isolateDomGlobals()` at a test file's top level snapshots every own `globalThis` property before
// the file's `describeDom` registers happy-dom and restores the snapshot once the file finishes.
// (Outer hooks wrap inner ones: this beforeAll runs first, this afterAll runs last.)
//
// Globals leaked by an earlier file can be accessors bound to a closed happy-dom window whose
// getter throws (e.g. `innerWidth`). Every value read is therefore guarded: a throwing getter is
// snapshotted by descriptor alone and restored by descriptor.

import { afterAll, beforeAll } from "bun:test";

type ValueRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export interface GlobalSnapshotEntry {
  readonly desc: PropertyDescriptor;
  readonly read: ValueRead;
}

export type GlobalSnapshot = ReadonlyMap<string, GlobalSnapshotEntry>;

// The TRUE global object. happy-dom's window has an own `globalThis` property that
// `registerHappyDom` copies onto the global, after which the bare `globalThis` identifier resolves
// to a happy-dom window — snapshotting/restoring through it would touch that window, not the
// global. A sloppy-mode `Function` body's `this` is always the real global object.
export const realGlobal = Function("return this")() as Record<string, unknown>;

function readGlobal(key: string): ValueRead {
  try {
    return { ok: true, value: realGlobal[key] };
  } catch {
    return { ok: false };
  }
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return a.get === b.get && a.set === b.set && a.value === b.value;
}

/** Snapshot every own `globalThis` property; never throws on a throwing getter. */
export function snapshotGlobals(): GlobalSnapshot {
  const snapshot = new Map<string, GlobalSnapshotEntry>();
  for (const key of Object.getOwnPropertyNames(realGlobal)) {
    const desc = Object.getOwnPropertyDescriptor(realGlobal, key);
    if (desc !== undefined) snapshot.set(key, { desc, read: readGlobal(key) });
  }
  return snapshot;
}

/** Restore `globalThis` to `snapshot`; never throws (non-configurable globals are left as-is). */
export function restoreGlobals(snapshot: GlobalSnapshot): void {
  for (const key of Object.getOwnPropertyNames(realGlobal)) {
    const original = snapshot.get(key);
    try {
      if (original === undefined) {
        delete realGlobal[key];
        continue;
      }
      const current = readGlobal(key);
      if (!original.read.ok || !current.ok) {
        // A getter threw on either side, so the value can't be compared — restore by descriptor
        // when the descriptor itself was swapped.
        const desc = Object.getOwnPropertyDescriptor(realGlobal, key);
        if (desc === undefined || !sameDescriptor(desc, original.desc)) {
          Object.defineProperty(realGlobal, key, original.desc);
        }
      } else if (current.value !== original.read.value) {
        // Accessor globals (e.g. `process`) may keep their descriptor while a setter swapped the
        // value, so restore by value as well as by descriptor.
        Object.defineProperty(realGlobal, key, original.desc);
        const restored = readGlobal(key);
        if (!restored.ok || restored.value !== original.read.value) realGlobal[key] = original.read.value;
      }
    } catch {
      /* non-configurable global — leave it */
    }
  }
}

export function isolateDomGlobals(): void {
  let snapshot: GlobalSnapshot | null = null;
  beforeAll(() => {
    snapshot = snapshotGlobals();
  });
  afterAll(() => {
    if (snapshot === null) return;
    restoreGlobals(snapshot);
    snapshot = null;
  });
}
