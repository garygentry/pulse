// mutations-write-path.test.ts — createWritePath probes, precedence, markFailed overlay, recovery,
// edge logs and the sticky ack load status (04 §3), plus the shared/server WritePathReason pin (04 §6.1).
//
// Every case drives a fake WritePathFs (scripted per-path failures, call counting) and a captured log
// sink, so no real filesystem is touched.

import { describe, expect, test } from "bun:test";
import { constants as FS } from "node:fs";

import type { SecretStatus, WritePathConfig } from "../src/server/config.js";
import type { LogEvent } from "../src/server/log.js";
import {
  createWritePath,
  WRITE_PATH_REASONS,
  WRITE_PATH_STORES,
  type StoreStatus,
  type WritePathDeps,
  type WritePathFs,
  type WritePathReason as ServerReason,
  type WritePathStore,
} from "../src/server/mutations/write-path.js";
import type { WritePathReason as SharedReason } from "../src/shared/snapshot.js";

// ── type-level pin: shared/snapshot.ts WritePathReason ≡ server WRITE_PATH_REASONS ─────────────────
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const _sharedEqServer: Equal<SharedReason, (typeof WRITE_PATH_REASONS)[number]> = true;
const _serverEqConst: Equal<ServerReason, (typeof WRITE_PATH_REASONS)[number]> = true;
void _sharedEqServer;
void _serverEqConst;

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const DATA = "/data";
const AUDIT_DIR = "/data/audit";
const AUDIT = "/data/audit/audit.jsonl";
const ACKS = "/data/acks.json";
const PROPOSALS = "/data/proposals";

const FULL_CONFIG: WritePathConfig = {
  dataDir: DATA,
  auditPath: AUDIT,
  ackStorePath: ACKS,
  proposalsDir: PROPOSALS,
  secret: { present: true },
};
const SECRET_OK: SecretStatus = { present: true };

type FsOp = "mkdir" | "access-w" | "access-f" | "open";

/** Scripted fake fs: `fail` holds `op:path` keys that reject (errno-like text included, never logged). */
interface FakeFs extends WritePathFs {
  readonly fail: Set<string>;
  readonly calls: string[];
  /** Resolve each op only after `gate` settles (to hold a probe in flight). */
  gate: Promise<void> | null;
}

function fakeFs(fail: readonly string[] = []): FakeFs {
  const f: FakeFs = {
    fail: new Set(fail),
    calls: [],
    gate: null,
    async mkdir(path: string) {
      await check("mkdir", path);
    },
    async access(path: string, mode: number) {
      await check(mode === FS.F_OK ? "access-f" : "access-w", path);
    },
    async open(path: string) {
      await check("open", path);
      return { close: async () => undefined };
    },
  };
  async function check(op: FsOp, path: string): Promise<void> {
    f.calls.push(`${op}:${path}`);
    if (f.gate !== null) await f.gate;
    if (f.fail.has(`${op}:${path}`)) throw new Error(`EACCES: permission denied, ${op} '${path}'`);
  }
  return f;
}

function capture(): { events: LogEvent[]; sink: (e: LogEvent) => void } {
  const events: LogEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

function build(
  over: Partial<WritePathDeps> = {},
  config: WritePathConfig = FULL_CONFIG,
): { wp: ReturnType<typeof createWritePath>; fs: FakeFs; events: LogEvent[] } {
  const fs = (over.fs as FakeFs | undefined) ?? fakeFs();
  const { events, sink } = capture();
  const wp = createWritePath(config, {
    secret: SECRET_OK,
    alertmanagerConfigured: true,
    fs,
    log: sink,
    ...over,
  });
  return { wp, fs, events };
}

const ok = (): StoreStatus => ({ ok: true, reason: null });
const down = (reason: ServerReason): StoreStatus => ({ ok: false, reason });

// ── construction ────────────────────────────────────────────────────────────────────────────────
describe("createWritePath construction (REQ-CFG-02)", () => {
  test("performs no I/O and starts with filesystem slots `missing`, secret/alertmanager from deps", () => {
    const { wp, fs, events } = build();
    expect(fs.calls).toEqual([]);
    expect(events).toEqual([]);
    const s = wp.snapshot();
    expect(s.audit).toEqual(down("missing"));
    expect(s.acks).toEqual(down("missing"));
    expect(s.proposals).toEqual(down("missing"));
    expect(s.secret).toEqual(ok());
    expect(s.alertmanager).toEqual(ok());
  });

  test("a healthy full config probes all five stores ok", async () => {
    const { wp } = build();
    const s = await wp.probe();
    for (const store of WRITE_PATH_STORES) expect(s[store]).toEqual(ok());
    expect(wp.snapshot()).toBe(s);
  });
});

// ── 04 §3.2 table ───────────────────────────────────────────────────────────────────────────────
interface Row {
  readonly name: string;
  readonly config?: Partial<WritePathConfig>;
  readonly deps?: Partial<WritePathDeps>;
  readonly fail?: readonly string[];
  readonly store: WritePathStore;
  readonly reason: ServerReason;
}

const ROWS: readonly Row[] = [
  // audit
  { name: "audit: null path → not-configured", config: { auditPath: null }, store: "audit", reason: "not-configured" },
  { name: "audit: mkdir -p rejects → missing", fail: [`mkdir:${AUDIT_DIR}`], store: "audit", reason: "missing" },
  { name: "audit: dir not W_OK → unwritable", fail: [`access-w:${AUDIT_DIR}`], store: "audit", reason: "unwritable" },
  { name: "audit: open(\"a\") rejects → unwritable", fail: [`open:${AUDIT}`], store: "audit", reason: "unwritable" },
  // acks
  { name: "acks: null path → not-configured", config: { ackStorePath: null }, store: "acks", reason: "not-configured" },
  { name: "acks: mkdir -p rejects → missing", fail: [`mkdir:${DATA}`], store: "acks", reason: "missing" },
  { name: "acks: dir not W_OK → unwritable", fail: [`access-w:${DATA}`], store: "acks", reason: "unwritable" },
  { name: "acks: existing file not W_OK → unwritable", fail: [`access-w:${ACKS}`], store: "acks", reason: "unwritable" },
  {
    name: "acks: ackLoadStatus corrupt → corrupt",
    deps: { ackLoadStatus: () => down("corrupt") },
    store: "acks",
    reason: "corrupt",
  },
  {
    name: "acks: ackLoadStatus unwritable → unwritable",
    deps: { ackLoadStatus: () => down("unwritable") },
    store: "acks",
    reason: "unwritable",
  },
  {
    name: "acks: throwing ackLoadStatus getter → corrupt",
    deps: {
      ackLoadStatus: () => {
        throw new Error("boom");
      },
    },
    store: "acks",
    reason: "corrupt",
  },
  // proposals
  { name: "proposals: null dir → not-configured", config: { proposalsDir: null }, store: "proposals", reason: "not-configured" },
  { name: "proposals: mkdir -p rejects → missing", fail: [`mkdir:${PROPOSALS}`], store: "proposals", reason: "missing" },
  { name: "proposals: dir not W_OK → unwritable", fail: [`access-w:${PROPOSALS}`], store: "proposals", reason: "unwritable" },
  // secret
  {
    name: "secret: unset → secret-missing",
    deps: { secret: { present: false, reason: "secret-missing" } },
    store: "secret",
    reason: "secret-missing",
  },
  {
    name: "secret: < 32 bytes → secret-too-short",
    deps: { secret: { present: false, reason: "secret-too-short" } },
    store: "secret",
    reason: "secret-too-short",
  },
  // alertmanager
  {
    name: "alertmanager: no write client → not-configured",
    deps: { alertmanagerConfigured: false },
    store: "alertmanager",
    reason: "not-configured",
  },
  // within-store precedence (first failing step wins)
  {
    name: "precedence: audit missing outranks unwritable",
    fail: [`mkdir:${AUDIT_DIR}`, `access-w:${AUDIT_DIR}`, `open:${AUDIT}`],
    store: "audit",
    reason: "missing",
  },
  {
    name: "precedence: audit dir unwritable outranks open failure",
    fail: [`access-w:${AUDIT_DIR}`, `open:${AUDIT}`],
    store: "audit",
    reason: "unwritable",
  },
  {
    name: "precedence: acks unwritable outranks a corrupt load",
    fail: [`access-w:${DATA}`],
    deps: { ackLoadStatus: () => down("corrupt") },
    store: "acks",
    reason: "unwritable",
  },
  {
    name: "precedence: acks missing outranks unwritable and corrupt",
    fail: [`mkdir:${DATA}`, `access-w:${DATA}`],
    deps: { ackLoadStatus: () => down("corrupt") },
    store: "acks",
    reason: "missing",
  },
  {
    name: "precedence: proposals missing outranks unwritable",
    fail: [`mkdir:${PROPOSALS}`, `access-w:${PROPOSALS}`],
    store: "proposals",
    reason: "missing",
  },
];

describe("write-path probe table (04 §3.2; REQ-CFG-02, REQ-OBS-02)", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const fs = fakeFs(row.fail ?? []);
      const { wp } = build({ fs, ...row.deps }, { ...FULL_CONFIG, ...row.config });
      const s = await wp.probe();
      expect(s[row.store]).toEqual(down(row.reason));
      // Only the targeted store degrades.
      for (const other of WRITE_PATH_STORES) if (other !== row.store) expect(s[other]).toEqual(ok());
    });
  }

  test("a not-configured store performs no filesystem call for that store", async () => {
    const { wp, fs } = build({}, { ...FULL_CONFIG, auditPath: null, ackStorePath: null, proposalsDir: null });
    await wp.probe();
    expect(fs.calls).toEqual([]);
  });

  test("an absent acks file (F_OK rejects) is a healthy first run", async () => {
    const { wp, fs } = build({ fs: fakeFs([`access-f:${ACKS}`]) });
    const s = await wp.probe();
    expect(s.acks).toEqual(ok());
    expect(fs.calls).not.toContain(`access-w:${ACKS}`);
  });

  test("probe() never rejects even when every fs call throws synchronously", async () => {
    const throwing: WritePathFs = {
      mkdir: () => {
        throw new Error("sync");
      },
      access: () => {
        throw new Error("sync");
      },
      open: () => {
        throw new Error("sync");
      },
    };
    const { wp } = build({ fs: throwing as FakeFs });
    const s = await wp.probe();
    expect(s.audit).toEqual(down("missing"));
    expect(s.acks).toEqual(down("missing"));
    expect(s.proposals).toEqual(down("missing"));
  });
});

// ── markFailed + recovery ───────────────────────────────────────────────────────────────────────
describe("markFailed overlay and probe recovery (04 §3.3; REQ-AUTHZ-03, REQ-OBS-02)", () => {
  test("markFailed degrades immediately and emits exactly one write_path_degraded", async () => {
    const { wp, events } = build();
    await wp.probe();
    events.length = 0;
    wp.markFailed("audit", "write-failed");
    expect(wp.snapshot().audit).toEqual(down("write-failed"));
    expect(events).toEqual([{ event: "write_path_degraded", ok: false, store: "audit", reason: "write-failed" }]);
  });

  test("markFailed overlays only an ok slot: a probe-level reason outranks the mark", async () => {
    const { wp, events } = build({ fs: fakeFs([`access-w:${PROPOSALS}`]) });
    await wp.probe();
    events.length = 0;
    wp.markFailed("proposals", "write-failed");
    expect(wp.snapshot().proposals).toEqual(down("unwritable"));
    expect(events).toEqual([]);
  });

  test("a probe that started before a mark does not clear it; a later passing probe does", async () => {
    const fs = fakeFs();
    const { wp, events } = build({ fs });
    await wp.probe();
    events.length = 0;

    let release!: () => void;
    fs.gate = new Promise<void>((r) => {
      release = r;
    });
    const early = wp.probe(); // starts before the mark
    wp.markFailed("acks", "write-failed");
    release();
    fs.gate = null;
    const afterEarly = await early;
    expect(afterEarly.acks).toEqual(down("write-failed"));
    expect(events.filter((e) => e.event === "write_path_recovered")).toEqual([]);

    const later = await wp.probe(); // starts after the mark
    expect(later.acks).toEqual(ok());
    expect(events.filter((e) => e.event === "write_path_recovered")).toEqual([
      { event: "write_path_recovered", ok: true, store: "acks" },
    ]);
  });

  test("a mark on a store whose probe still fails is kept", async () => {
    const fs = fakeFs();
    const { wp } = build({ fs });
    await wp.probe();
    wp.markFailed("audit", "unwritable");
    fs.fail.add(`open:${AUDIT}`);
    expect((await wp.probe()).audit).toEqual(down("unwritable"));
    fs.fail.clear();
    expect((await wp.probe()).audit).toEqual(ok());
  });

  test("corrupt ackLoadStatus + passing fs keeps acks corrupt and logs no write_path_recovered", async () => {
    const { wp, events } = build({ ackLoadStatus: () => down("corrupt") });
    for (let i = 0; i < 3; i += 1) expect((await wp.probe()).acks).toEqual(down("corrupt"));
    wp.markFailed("acks", "write-failed");
    expect((await wp.probe()).acks).toEqual(down("corrupt"));
    expect(events.some((e) => e.event === "write_path_recovered")).toBe(false);
    // Only the baseline degraded line for acks; no repeats for an unchanged reason.
    expect(events.filter((e) => e.store === "acks")).toEqual([
      { event: "write_path_degraded", ok: false, store: "acks", reason: "corrupt" },
    ]);
  });

  test("absent ackLoadStatus means the load status is not consulted (UP)", async () => {
    const { wp } = build({});
    expect((await wp.probe()).acks).toEqual(ok());
  });

  test("the late-bound ackLoadStatus getter is re-read on every probe", async () => {
    let load: StoreStatus = ok();
    const { wp } = build({ ackLoadStatus: () => load });
    expect((await wp.probe()).acks).toEqual(ok());
    load = down("corrupt");
    expect((await wp.probe()).acks).toEqual(down("corrupt"));
  });
});

// ── single-flight, immutability ─────────────────────────────────────────────────────────────────
describe("probe single-flight and frozen snapshots (04 §3.4; REQ-AUTHZ-03)", () => {
  test("concurrent probe() calls share one probe", async () => {
    const { wp, fs } = build();
    const a = wp.probe();
    const b = wp.probe();
    expect(b).toBe(a);
    const [sa, sb] = await Promise.all([a, b]);
    expect(sa).toBe(sb);
    const perProbe = fs.calls.length;
    expect(perProbe).toBeGreaterThan(0);
    // A new probe after settlement runs again.
    await wp.probe();
    expect(fs.calls.length).toBe(perProbe * 2);
  });

  test("snapshots and every entry are frozen; a held snapshot never tears", async () => {
    const { wp } = build();
    const before = wp.snapshot();
    const s = await wp.probe();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(s)).toBe(true);
    for (const store of WRITE_PATH_STORES) {
      expect(Object.isFrozen(before[store])).toBe(true);
      expect(Object.isFrozen(s[store])).toBe(true);
    }
    wp.markFailed("audit", "write-failed");
    expect(s.audit).toEqual(ok());
    expect(wp.snapshot()).not.toBe(s);
  });
});

// ── edge logs ───────────────────────────────────────────────────────────────────────────────────
describe("write-path edge logs (04 §3.3, §7.2; REQ-OBS-02)", () => {
  test("baseline logs only degraded stores (no recovered lines at start-up)", async () => {
    const { wp, events } = build(
      { secret: { present: false, reason: "secret-missing" }, alertmanagerConfigured: false },
      { ...FULL_CONFIG, proposalsDir: null },
    );
    await wp.probe();
    expect(events).toEqual([
      { event: "write_path_degraded", ok: false, store: "proposals", reason: "not-configured" },
      { event: "write_path_degraded", ok: false, store: "secret", reason: "secret-missing" },
      { event: "write_path_degraded", ok: false, store: "alertmanager", reason: "not-configured" },
    ]);
  });

  test("a healthy baseline logs nothing", async () => {
    const { wp, events } = build();
    await wp.probe();
    expect(events).toEqual([]);
  });

  test("a reason change logs a new degraded line; an unchanged reason logs nothing", async () => {
    const fs = fakeFs([`open:${AUDIT}`]);
    const { wp, events } = build({ fs });
    await wp.probe();
    await wp.probe();
    fs.fail.clear();
    fs.fail.add(`mkdir:${AUDIT_DIR}`);
    await wp.probe();
    expect(events).toEqual([
      { event: "write_path_degraded", ok: false, store: "audit", reason: "unwritable" },
      { event: "write_path_degraded", ok: false, store: "audit", reason: "missing" },
    ]);
  });

  test("errno/error text is never logged", async () => {
    const { wp, events } = build({ fs: fakeFs([`mkdir:${AUDIT_DIR}`, `access-w:${PROPOSALS}`]) });
    await wp.probe();
    const text = JSON.stringify(events);
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("permission denied");
    expect(text).not.toContain(AUDIT_DIR);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["event", "ok", "reason", "store"]);
  });

  test("a throwing log sink is swallowed and health bookkeeping continues", async () => {
    let calls = 0;
    const wp = createWritePath(FULL_CONFIG, {
      secret: { present: false, reason: "secret-too-short" },
      alertmanagerConfigured: true,
      fs: fakeFs(),
      log: () => {
        calls += 1;
        throw new Error("sink down");
      },
    });
    const s = await wp.probe();
    expect(s.secret).toEqual(down("secret-too-short"));
    expect(() => wp.markFailed("audit", "write-failed")).not.toThrow();
    expect(wp.snapshot().audit).toEqual(down("write-failed"));
    expect(calls).toBe(2);
  });

  test("createWritePath never produces auth-mode-none", async () => {
    const { wp } = build(
      { secret: { present: false, reason: "secret-missing" }, alertmanagerConfigured: false },
      { dataDir: null, auditPath: null, ackStorePath: null, proposalsDir: null, secret: { present: false, reason: "secret-missing" } },
    );
    const s = await wp.probe();
    for (const store of WRITE_PATH_STORES) expect(s[store].reason).not.toBe("auth-mode-none");
  });
});
