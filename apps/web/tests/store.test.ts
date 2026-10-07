// apps/web/tests/store.test.ts — the AppStore (item 005 / REQ-STORE-01/02/04/07, REQ-PERF-04).
//
// Covers: signal isolation (updating one signal never re-runs a subscriber of another),
// theme/density defaults with a throwing storage, the `?kiosk=1` density force, and
// `selectHost` re-fire selectivity under wholesale `store.snapshot` replacement.

import { describe, expect, test } from "bun:test";
import { effect } from "@preact/signals-core";

import {
  createAppStore,
  createHostSelectors,
  selectHost,
} from "../src/client/store/index.js";
import {
  createPreferenceStorage,
  DEFAULT_DENSITY,
  DEFAULT_THEME,
  PREF_KEYS,
  readDensity,
  readTheme,
  type PreferenceStorage,
} from "../src/client/store/preferences.js";
import { hostStatus, overviewSnapshot } from "./factories.js";

describe("createAppStore — defaults and shape", () => {
  test("exposes all eleven signals at the documented defaults", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    expect(store.snapshot.value).toBeNull();
    expect(store.alerts.value).toBeNull();
    expect(store.engine.value).toBeNull();
    expect(store.estate.value).toBeNull();
    expect(store.timeline.value).toBeNull();
    const initialView = { phase: "initial", identity: null, failure: null } as const;
    expect(store.connection.value).toEqual({
      phase: "initial",
      transport: "poll",
      lastGoodAt: null,
      failingSince: null,
      seq: 0,
      observation: null,
      views: {
        overview: initialView,
        alerts: initialView,
        estate: initialView,
        engine: initialView,
        timeline: initialView,
      },
    });
    expect(store.route.value).toEqual({ path: "/", view: "", params: {}, query: {} });
    expect(store.theme.value).toBe(DEFAULT_THEME);
    expect(store.density.value).toBe(DEFAULT_DENSITY);
    expect(store.selection.value).toBeNull();
    expect(store.session.value).toBeNull();
  });
});

describe("signal isolation (REQ-STORE-02)", () => {
  test("writing snapshot does not re-run a route subscriber (and vice versa)", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });

    let snapshotRuns = 0;
    let routeRuns = 0;
    const disposeSnap = effect(() => {
      void store.snapshot.value;
      snapshotRuns += 1;
    });
    const disposeRoute = effect(() => {
      void store.route.value;
      routeRuns += 1;
    });
    expect(snapshotRuns).toBe(1);
    expect(routeRuns).toBe(1);

    store.snapshot.value = overviewSnapshot();
    expect(snapshotRuns).toBe(2);
    expect(routeRuns).toBe(1);

    store.route.value = { path: "/alerts", view: "alerts", params: {}, query: {} };
    expect(snapshotRuns).toBe(2);
    expect(routeRuns).toBe(2);

    disposeSnap();
    disposeRoute();
  });

  test("writing selection does not fire a subscriber on connection", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });

    let selectionRuns = 0;
    let connectionRuns = 0;
    const disposeSel = effect(() => {
      void store.selection.value;
      selectionRuns += 1;
    });
    const disposeConn = effect(() => {
      void store.connection.value;
      connectionRuns += 1;
    });
    expect(selectionRuns).toBe(1);
    expect(connectionRuns).toBe(1);

    store.selection.value = { kind: "host", host: "web01" };
    expect(selectionRuns).toBe(2);
    expect(connectionRuns).toBe(1);

    disposeSel();
    disposeConn();
  });
});

describe("preference persistence + defaults (REQ-STORE-04)", () => {
  test("createPreferenceStorage returns null when no window is available", () => {
    // `undefined` falls back to `globalThis.window`. Another test file in the same process can leave a
    // DOM window behind, so hide it for this call and restore it afterwards (order-independent).
    const g = globalThis as { window?: unknown };
    const saved = Object.getOwnPropertyDescriptor(g, "window");
    if (saved !== undefined) delete g.window;
    try {
      expect(createPreferenceStorage(undefined)).toBeNull();
    } finally {
      if (saved !== undefined) Object.defineProperty(g, "window", saved);
    }
  });

  test("readTheme / readDensity return defaults for missing, malformed, or unknown values", () => {
    const empty: PreferenceStorage = { get: () => null, set: () => {} };
    expect(readTheme(empty)).toBe(DEFAULT_THEME);
    expect(readDensity(empty)).toBe(DEFAULT_DENSITY);

    const unknown: PreferenceStorage = { get: () => "neon", set: () => {} };
    expect(readTheme(unknown)).toBe(DEFAULT_THEME);
    expect(readDensity(unknown)).toBe(DEFAULT_DENSITY);

    const wrongCase: PreferenceStorage = { get: () => "Dark", set: () => {} };
    expect(readTheme(wrongCase)).toBe(DEFAULT_THEME);

    // Null-storage path.
    expect(readTheme(null)).toBe(DEFAULT_THEME);
    expect(readDensity(null)).toBe(DEFAULT_DENSITY);
  });

  test("a get that throws is treated as missing (returns the default)", () => {
    const angry: PreferenceStorage = {
      get: () => {
        throw new Error("boom");
      },
      set: () => {},
    };
    expect(readTheme(angry)).toBe(DEFAULT_THEME);
    expect(readDensity(angry)).toBe(DEFAULT_DENSITY);
  });

  test("a set that throws disables further writes for this store, and the signals keep updating", () => {
    let writes = 0;
    const hostile: PreferenceStorage = {
      get: () => null,
      set: () => {
        writes += 1;
        throw new Error("QuotaExceededError");
      },
    };
    const store = createAppStore({ storage: hostile, initialQuery: {} });

    // The theme effect fires immediately on creation and throws; density's persist call then sees
    // writesDisabled=true and never reaches storage.set — so exactly ONE write attempt was made.
    const seedWrites = writes;
    expect(seedWrites).toBe(1);

    store.theme.value = "dark";
    store.density.value = "wallboard";
    expect(writes).toBe(seedWrites);
    // The in-memory signals still update — the store keeps working even when storage is hostile.
    expect(store.theme.value).toBe("dark");
    expect(store.density.value).toBe("wallboard");
  });

  test("a recording storage receives seed writes AND subsequent changes", () => {
    const bag = new Map<string, string>();
    const storage: PreferenceStorage = {
      get: (k) => bag.get(k) ?? null,
      set: (k, v) => {
        bag.set(k, v);
      },
    };
    const store = createAppStore({ storage, initialQuery: {} });
    expect(bag.get(PREF_KEYS.theme)).toBe(DEFAULT_THEME);
    expect(bag.get(PREF_KEYS.density)).toBe(DEFAULT_DENSITY);

    store.theme.value = "dark";
    store.density.value = "wallboard";
    expect(bag.get(PREF_KEYS.theme)).toBe("dark");
    expect(bag.get(PREF_KEYS.density)).toBe("wallboard");
  });
});

describe("?kiosk=1 forces wallboard and disables density write-back (REQ-STORE-04)", () => {
  test("density starts at wallboard, theme uses stored/default", () => {
    const store = createAppStore({ storage: null, initialQuery: { kiosk: "1" } });
    expect(store.density.value).toBe("wallboard");
    expect(store.theme.value).toBe(DEFAULT_THEME);
  });

  test("under kiosk, density writes never reach storage — only theme does", () => {
    const bag = new Map<string, string>();
    const storage: PreferenceStorage = {
      get: (k) => bag.get(k) ?? null,
      set: (k, v) => {
        bag.set(k, v);
      },
    };
    const store = createAppStore({ storage, initialQuery: { kiosk: "1" } });
    // Only the theme effect was installed.
    expect(bag.has(PREF_KEYS.theme)).toBe(true);
    expect(bag.has(PREF_KEYS.density)).toBe(false);

    store.density.value = "desk";
    expect(bag.has(PREF_KEYS.density)).toBe(false);

    store.theme.value = "dark";
    expect(bag.get(PREF_KEYS.theme)).toBe("dark");
  });

  test("kiosk detection matches only the exact string \"1\"", () => {
    const noKiosk = createAppStore({ storage: null, initialQuery: { kiosk: "0" } });
    expect(noKiosk.density.value).toBe(DEFAULT_DENSITY);
    const notKiosk = createAppStore({ storage: null, initialQuery: { kiosk: "true" } });
    expect(notKiosk.density.value).toBe(DEFAULT_DENSITY);
  });
});

describe("selectHost — per-host re-fire selectivity (REQ-PERF-04, REQ-SCALE-01)", () => {
  test("returns the same signal object on repeated calls", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const a = selectHost(store, "web01");
    const b = selectHost(store, "web01");
    expect(a).toBe(b);
  });

  test("changing only one host's content re-fires only that host's selector", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    // Seed with two hosts.
    const h1 = hostStatus({ name: "web01" });
    const h2 = hostStatus({ name: "web02" });
    store.snapshot.value = overviewSnapshot({ hosts: [h1, h2] });

    let web01Runs = 0;
    let web02Runs = 0;
    const disp1 = effect(() => {
      void selectHost(store, "web01").value;
      web01Runs += 1;
    });
    const disp2 = effect(() => {
      void selectHost(store, "web02").value;
      web02Runs += 1;
    });
    expect(web01Runs).toBe(1);
    expect(web02Runs).toBe(1);

    // Publish a new snapshot object where only web01 has changed content.
    const h1Changed = hostStatus({ name: "web01", status: "critical", rollup: "critical" });
    store.snapshot.value = overviewSnapshot({ hosts: [h1Changed, hostStatus({ name: "web02" })] });

    expect(web01Runs).toBe(2);
    expect(web02Runs).toBe(1);

    // Re-publish an identical-content snapshot — neither selector re-fires.
    store.snapshot.value = overviewSnapshot({
      hosts: [
        hostStatus({ name: "web01", status: "critical", rollup: "critical" }),
        hostStatus({ name: "web02" }),
      ],
    });
    expect(web01Runs).toBe(2);
    expect(web02Runs).toBe(1);

    disp1();
    disp2();
  });

  test("a host absent from the snapshot yields a null signal value", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.snapshot.value = overviewSnapshot({ hosts: [hostStatus({ name: "web01" })] });
    const sig = selectHost(store, "does-not-exist");
    expect(sig.value).toBeNull();
  });

  test("reading selectHost during render does not subscribe the caller to store.snapshot", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    // Fresh selectors, isolated from the process-global WeakMap so we can dispose deterministically.
    const selectors = createHostSelectors(store);
    let renders = 0;
    const disp = effect(() => {
      // First render creates a NEW host entry; the effect must not subscribe to `store.snapshot`.
      void selectors.get("brand-new-host").value;
      renders += 1;
    });
    expect(renders).toBe(1);

    // Writing snapshot must not re-run the effect (the render read did not subscribe to snapshot).
    store.snapshot.value = overviewSnapshot({ hosts: [hostStatus({ name: "brand-new-host" })] });
    // The selectors' internal effect DOES react to the snapshot and publishes on the cell — that
    // legitimately re-fires the render effect once.
    expect(renders).toBe(2);

    // Writing snapshot to identical content does NOT re-fire.
    store.snapshot.value = overviewSnapshot({ hosts: [hostStatus({ name: "brand-new-host" })] });
    expect(renders).toBe(2);

    disp();
    selectors.dispose();
  });
});
