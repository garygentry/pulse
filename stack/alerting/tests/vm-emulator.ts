// stack/alerting/tests/vm-emulator.ts
// Support for the Docker-gated synthetic-check suites (issue #1): a throwaway VictoriaMetrics at
// the stack's exact pin, scripted Gatus histories rendered as `gatus` scrapes, and a replay of
// vmalert's evaluation loop.
//
// Why a real VictoriaMetrics: MetricsQL's increase() is not Prometheus's — it does not extrapolate
// and it counts a brand-new series' first sample — and the rule's threshold logic rides on it.
//
// The loop mirrors vmalert v1.102.1 as observed live: every evaluation runs the rule's instant
// query with `step=5m` (vmalert's `-datasource.queryStep` default, which is also how far back a raw
// selector finds a sample); while the result is non-empty it remote-writes the ALERTS sample
// (alert labels + alertname/alertstate/alertgroup + the estate external label) at the evaluation
// time, and on resolve it remote-writes the Prometheus staleness marker. A failed evaluation (VM
// restart / query timeout) keeps the in-memory state and writes nothing; a vmalert outage writes
// nothing and comes back with NO state (so no staleness marker is ever written for an alert that
// was firing when it went down).
import { VM_IMAGE, run } from "./harness.js";

/** One Gatus check result at `at` seconds (fractional allowed) into the simulation. */
export interface Check {
  at: number;
  ok: boolean;
}

/** A scripted Gatus history for one endpoint. */
export interface History {
  group: string;
  name: string;
  checks: Check[];
  /** Gatus not running (no scrapes, no checks) over each `[from, to)`. */
  down?: Array<[number, number]>;
  /** Gatus (re)start instants: every counter restarts from zero. */
  resets?: number[];
  /** Offset of the 30s scrape grid, in seconds (default 20). */
  scrapePhase?: number;
}

/** The `gatus` job's scrape interval (scrape.yml global). */
export const SCRAPE_INTERVAL = 30;

/** `count` checks every `cadence` seconds from `from`, each `ok(i)`. */
export function checks(from: number, count: number, cadence: number, ok: (i: number) => boolean): Check[] {
  return Array.from({ length: count }, (_, i) => ({ at: from + i * cadence, ok: ok(i) }));
}

/** Prometheus text-format lines for every scrape of one history up to `end`, at absolute base `t0`. */
export function scrapeLines(h: History, t0: number, end: number): string[] {
  const lines: string[] = [];
  const isDown = (t: number): boolean => (h.down ?? []).some(([a, b]) => t >= a && t < b);
  for (let t = h.scrapePhase ?? 20; t <= end; t += SCRAPE_INTERVAL) {
    if (isDown(t)) continue;
    const since = Math.max(-1, ...(h.resets ?? []).filter((r) => r <= t));
    for (const ok of [true, false]) {
      const n = h.checks.filter((c) => c.ok === ok && c.at > since && c.at <= t).length;
      if (n === 0) continue; // Gatus registers a labelled counter only on its first increment
      lines.push(
        `gatus_results_total{group="${h.group}",key="k-${h.group}",name="${h.name}",success="${ok}",type="HTTP"} ${n} ${Math.round((t0 + t) * 1000)}`,
      );
    }
  }
  return lines;
}

// ── Prometheus remote-write encoding (what vmalert sends), so ALERTS can carry staleness markers ──

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function field(tag: number, payload: number[]): number[] {
  return [tag, ...varint(payload.length), ...payload];
}

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/** One remote-write sample: label set, value (`null` = Prometheus staleness marker), ms timestamp. */
export interface RwSample {
  labels: Record<string, string>;
  value: number | null;
  tsMs: number;
}

/** Encode a prometheus.WriteRequest (timeseries=1 {labels=1 {name=1,value=2}, samples=2 {value=1
 *  double, timestamp=2 int64}}). A `null` value is the staleness NaN 0x7ff0000000000002. */
function writeRequest(samples: RwSample[]): number[] {
  const body: number[] = [];
  for (const s of samples) {
    const labels = Object.entries(s.labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([k, v]) => field(0x0a, [...field(0x0a, utf8(k)), ...field(0x12, utf8(v))]));
    const dv = new DataView(new ArrayBuffer(8));
    if (s.value === null) {
      dv.setUint32(0, 0x00000002, true);
      dv.setUint32(4, 0x7ff00000, true);
    } else {
      dv.setFloat64(0, s.value, true);
    }
    const sample = [0x09, ...new Uint8Array(dv.buffer), 0x10, ...varint(s.tsMs)];
    body.push(...field(0x0a, [...labels, ...field(0x12, sample)]));
  }
  return body;
}

/** Snappy block format with a single literal element (valid, uncompressed). */
function snappyLiteral(data: number[]): Uint8Array<ArrayBuffer> {
  const n = data.length;
  const len = n - 1;
  const tag =
    len < 60
      ? [len << 2]
      : len < 1 << 8
        ? [60 << 2, len]
        : len < 1 << 16
          ? [61 << 2, len & 0xff, len >> 8]
          : [62 << 2, len & 0xff, (len >> 8) & 0xff, len >> 16];
  return new Uint8Array([...varint(n), ...tag, ...data]);
}

/** A throwaway VictoriaMetrics container. */
export class Vm {
  private constructor(
    readonly container: string,
    readonly base: string,
  ) {}

  static async start(): Promise<Vm> {
    const started = run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::8428", VM_IMAGE]);
    if (started.exitCode !== 0) throw new Error(`docker run ${VM_IMAGE}: ${started.stderr}`);
    const container = started.stdout.trim();
    const port = run(["docker", "port", container, "8428/tcp"]).stdout.trim().split("\n")[0]!;
    const vm = new Vm(container, `http://${port}`);
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${vm.base}/health`)).ok) return vm;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("VictoriaMetrics did not become healthy");
  }

  stop(): void {
    run(["docker", "rm", "-f", this.container]);
  }

  async import(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const res = await fetch(`${this.base}/api/v1/import/prometheus`, { method: "POST", body: lines.join("\n") });
    if (res.status !== 204) throw new Error(`import: ${res.status} ${await res.text()}`);
    await fetch(`${this.base}/internal/force_flush`);
  }

  async remoteWrite(samples: RwSample[]): Promise<void> {
    if (samples.length === 0) return;
    const res = await fetch(`${this.base}/api/v1/write`, {
      method: "POST",
      headers: {
        "Content-Encoding": "snappy",
        "Content-Type": "application/x-protobuf",
        "X-Prometheus-Remote-Write-Version": "0.1.0",
      },
      body: snappyLiteral(writeRequest(samples)),
    });
    if (res.status !== 204) throw new Error(`remote write: ${res.status} ${await res.text()}`);
    await fetch(`${this.base}/internal/force_flush`);
  }

  /** Number of series an instant query returns at absolute time `at` (vmalert's `step=5m`). */
  async queryCount(expr: string, at: number): Promise<number> {
    const url = `${this.base}/api/v1/query?nocache=1&step=5m&time=${at}&query=${encodeURIComponent(expr)}`;
    const body = (await (await fetch(url)).json()) as {
      status: string;
      data?: { result: unknown[] };
      error?: string;
    };
    if (body.status !== "success") throw new Error(`query failed: ${body.error ?? ""}\n${expr}`);
    return body.data!.result.length;
  }
}

/** One rule instance the loop evaluates. */
export interface LoopRule {
  id: string;
  expr: string;
  /** The ALERTS label set vmalert would write for this alert (incl. `__name__`). */
  alertLabels: Record<string, string>;
  /** Evaluations (seconds) that fail outright: state kept, nothing written. */
  failedEvals?: number[];
  /** vmalert down over each `[from, to)`: nothing evaluated or written; state lost on return. */
  vmalertDown?: Array<[number, number]>;
}

/**
 * Replay vmalert's loop over `[interval, end]` every `interval` seconds and return, per rule id,
 * the evaluation times (seconds into the simulation) at which the rule fired. With `writeAlerts`
 * false nothing is written back (enough when only the FIRE term matters).
 */
export async function evalLoop(
  vm: Vm,
  t0: number,
  rules: LoopRule[],
  opts: { interval: number; end: number; writeAlerts?: boolean },
): Promise<Record<string, number[]>> {
  const firing: Record<string, number[]> = {};
  const active: Record<string, boolean> = {};
  for (const r of rules) firing[r.id] = [];
  for (let t = opts.interval; t <= opts.end; t += opts.interval) {
    const writes: RwSample[] = [];
    await Promise.all(
      rules.map(async (r) => {
        if ((r.vmalertDown ?? []).some(([a, b]) => t >= a && t < b)) {
          active[r.id] = false; // the restarted vmalert remembers nothing
          return;
        }
        if ((r.failedEvals ?? []).includes(t)) return;
        const tsMs = Math.round((t0 + t) * 1000);
        if ((await vm.queryCount(r.expr, t0 + t)) > 0) {
          firing[r.id]!.push(t);
          active[r.id] = true;
          writes.push({ labels: r.alertLabels, value: 1, tsMs });
        } else if (active[r.id]) {
          active[r.id] = false;
          writes.push({ labels: r.alertLabels, value: null, tsMs }); // staleness marker on resolve
        }
      }),
    );
    if (opts.writeAlerts !== false) await vm.remoteWrite(writes);
  }
  return firing;
}

/** The ALERTS label set vmalert v1.102.1 writes for a GatusCheckFailed alert. */
export function gatusAlertLabels(name: string, group: string, estate = "vm-fixture"): Record<string, string> {
  return {
    __name__: "ALERTS",
    alertname: "GatusCheckFailed",
    alertstate: "firing",
    alertgroup: "synthetic-checks",
    endpoint: name,
    estate,
    group,
    name,
    severity: "critical",
    source: "gatus",
  };
}

/** A past, hour-aligned base so every sample is historical (no latency offset in play). */
export function historicalBase(): number {
  return Math.floor(Date.now() / 1000 / 3600) * 3600 - 3 * 3600;
}
