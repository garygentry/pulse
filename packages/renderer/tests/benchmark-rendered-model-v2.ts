/** benchmark-rendered-model-v2.ts — the authoritative deterministic envelope benchmark
 *  (00-core-definitions.md §10, 07-format-transition-and-benchmark.md §5, 08 §9).
 *
 *  Run from the repository root:
 *
 *      bun run benchmark:rendered-model-v2
 *
 *  This is the ONLY authoritative performance gate. It is authoritative solely on GitHub-hosted
 *  `ubuntu-latest` under Bun 1.3.9 with the network disabled; a pass from any other runtime or
 *  platform is diagnostic, never authoritative. Larger estates than 100 hosts / 300 services may
 *  run but carry no performance guarantee (07 §5.4).
 *
 *  Protocol (07 §5.3, not weakenable):
 *    1. fail hard unless `Bun.version === "1.3.9"`;
 *    2. build the deterministic fixture and assert every untimed shape invariant before timing;
 *    3. one discarded generation warm-up into a fresh temp root;
 *    4. five generation samples — each times projection + all three web artifacts + serialization +
 *       materialization into its own fresh temp root; the render median must be strictly < 2000 ms;
 *    5. one discarded full bundle-load warm-up from a freshly materialized root;
 *    6. five load samples — each materializes a fresh root before the timer, then times disk read +
 *       parse + exhaustive/cross-artifact validation; the load median must be strictly < 250 ms;
 *    7. report runtime, counts, thresholds, both raw five-sample arrays, and both medians;
 *    8. every temp root is cleaned in `finally`; any setup/render/load/I-O/cleanup failure aborts
 *       non-zero and contributes NO numeric sample.
 *
 *  It performs no install, network, random, clock-derived fixture, filesystem enumeration, or
 *  live-engine work. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materialize, renderOnly } from "../src/index.js";
// The bundle loader is the @pulse/web trust boundary; the benchmark times its exhaustive
// disk-read/parse/validation exactly as the running server would (08 §3 seam). Imported by
// relative path because @pulse/web publishes no package entry point.
import { loadEstateBundle } from "../../../apps/web/src/server/estate/load.js";

import {
  BENCHMARK_HOST_COUNT,
  BENCHMARK_SERVICE_COUNT,
  LOAD_MEDIAN_LIMIT_MS,
  MEASURED_SAMPLE_COUNT,
  RENDER_MEDIAN_LIMIT_MS,
  buildRenderedModelV2BenchmarkFixture,
} from "./fixtures/rendered-model-v2-benchmark.js";
import type { RenderedModelV2BenchmarkFixture } from "./fixtures/rendered-model-v2-benchmark.js";

/** The authoritative runtime version; a different version is not authoritative (07 §5.2). */
const AUTHORITATIVE_BUN_VERSION = "1.3.9";

/** A five-sample series of finite non-negative durations in milliseconds. */
type FiveSamples = readonly [number, number, number, number, number];

/** The reported benchmark result (00 §10). */
export interface BenchmarkSummary {
  /** Median of five measured generation runs after one warm-up. */
  renderMedianMs: number;
  /** Median of five measured full-bundle loads after one warm-up. */
  loadMedianMs: number;
  /** Runtime string, expected to identify Bun 1.3.9 in the authoritative environment. */
  runtime: string;
  /** Verified fixture cardinalities. */
  counts: { hosts: 100; services: 300 };
  /** Raw generation samples in draw order (diagnostic on CI failure). */
  renderSamplesMs: FiveSamples;
  /** Raw load samples in draw order (diagnostic on CI failure). */
  loadSamplesMs: FiveSamples;
}

// ── Measurement helpers ─────────────────────────────────────────────────────────────────────────

/** Return the middle value of exactly five finite non-negative samples. */
function medianFive(samples: FiveSamples): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[2]!;
}

/** Time one synchronous or asynchronous operation with the monotonic performance clock. */
async function measure(operation: () => void | Promise<void>): Promise<number> {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

/** Assert a series has exactly five finite non-negative samples, else abort (never fabricate). */
function toFiveSamples(samples: readonly number[], label: string): FiveSamples {
  if (samples.length !== MEASURED_SAMPLE_COUNT) {
    throw new Error(`expected ${MEASURED_SAMPLE_COUNT} ${label} samples, got ${samples.length}`);
  }
  for (const s of samples) {
    if (!Number.isFinite(s) || s < 0) throw new Error(`invalid ${label} sample: ${String(s)}`);
  }
  return samples as unknown as FiveSamples;
}

// ── Temp-root harness ─────────────────────────────────────────────────────────────────────────

/** Create a fresh temporary rendered root. */
function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "pulse-rmv2-bench-"));
}

/** Remove a temporary root; a cleanup failure fails the whole check (07 §5.3). */
function cleanupRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Render the fixture's three web artifacts + manifest and materialize them into `root`. A fatal
 *  projection aborts with its safe findings and contributes no sample. */
function generateInto(fixture: RenderedModelV2BenchmarkFixture, root: string): void {
  const result = renderOnly(fixture.model, ["web"], { findings: fixture.findings });
  if (!result.ok) {
    const detail = result.findings
      .map((f) => `[${f.severity}] ${f.code} ${f.path}: ${f.message}`)
      .join("; ");
    throw new Error(`fatal web projection during generation: ${detail}`);
  }
  materialize(result.tree, root);
}

// ── Timed series ────────────────────────────────────────────────────────────────────────────────

/** Time one generation sample: projection + serialization + materialization into a fresh root. */
async function generationSample(fixture: RenderedModelV2BenchmarkFixture): Promise<number> {
  const root = freshRoot();
  try {
    return await measure(() => generateInto(fixture, root));
  } finally {
    cleanupRoot(root);
  }
}

/** Time one load sample: materialize a fresh root before the timer, then time the complete
 *  disk read + parse + exhaustive/cross-artifact validation. */
async function loadSample(fixture: RenderedModelV2BenchmarkFixture): Promise<number> {
  const root = freshRoot();
  try {
    generateInto(fixture, root);
    const modelPath = join(root, "web-estate-model.json");
    let result: Awaited<ReturnType<typeof loadEstateBundle>> | undefined;
    const duration = await measure(async () => {
      result = await loadEstateBundle(modelPath);
    });
    if (!result || !result.ok) {
      const e = result?.ok === false ? result.error : undefined;
      const detail = e
        ? `${e.kind}/${e.artifact} field=${String(e.field)} version=${String(e.foundVersion)}`
        : "no result";
      throw new Error(`bundle load failed during load sample: ${detail}`);
    }
    return duration;
  } finally {
    cleanupRoot(root);
  }
}

// ── Fixture shape proof (untimed, 07 §5.1) ────────────────────────────────────────────────────

/** Assert every untimed fixture invariant; a failure is a setup failure and aborts before any
 *  duration is measured (07 §5.1, never a slow sample). */
function assertFixtureShape(fixture: RenderedModelV2BenchmarkFixture): void {
  const { model, findings } = fixture;
  const hosts = model.hosts;
  const services = model.services;

  const managed = hosts.filter((h) => h.collectionClass === "managed-linux");
  const signals = managed.flatMap((h) => h.commandSignals);
  const scalars = signals.filter((s) => s.output === "scalar");
  const nas = hosts.filter((h) => h.collectionClass === "nas-api");
  const probes = hosts.filter((h) => h.collectionClass === "probe-only");
  const deep = services.flatMap((s) => (s.deepHealth ? [s.deepHealth] : []));
  const backups = services.flatMap((s) => (s.backupFreshness ? [s.backupFreshness] : []));
  const alerts = services.flatMap((s) => s.alerts ?? []);
  const creds = [
    ...model.channels.map((c) => c.credential),
    ...signals.flatMap((s) => (s.credential ? [s.credential] : [])),
  ];

  const hostClasses = new Set(hosts.map((h) => h.collectionClass));
  const channelKinds = new Set(model.channels.map((c) => c.kind));

  const checks: Array<[string, boolean]> = [
    [`exactly ${BENCHMARK_HOST_COUNT} hosts`, hosts.length === BENCHMARK_HOST_COUNT],
    ["all host names distinct", new Set(hosts.map((h) => h.name)).size === hosts.length],
    [`exactly ${BENCHMARK_SERVICE_COUNT} services`, services.length === BENCHMARK_SERVICE_COUNT],
    ["all service names distinct", new Set(services.map((s) => s.name)).size === services.length],
    [
      "all five collection classes present",
      (["managed-linux", "hypervisor-api", "nas-api", "probe-only", "excluded"] as const).every(
        (c) => hostClasses.has(c),
      ),
    ],
    ["managed-linux compose delivery", managed.some((h) => h.deliveryForm === "compose")],
    ["managed-linux systemd delivery", managed.some((h) => h.deliveryForm === "systemd")],
    ["cadvisor true", managed.some((h) => h.cadvisor)],
    ["cadvisor false", managed.some((h) => !h.cadvisor)],
    ["heartbeat true", managed.some((h) => h.heartbeat)],
    ["heartbeat false", managed.some((h) => !h.heartbeat)],
    ["multiple exporter ports", managed.some((h) => h.exporterPorts.length > 1)],
    ["scalar command signal", scalars.length > 0],
    ["exposition command signal", signals.some((s) => s.output === "exposition")],
    ["scalar signal carries metric and upMetric", scalars.some((s) => !!s.metric && !!s.upMetric)],
    ["scalar signal with labels", scalars.some((s) => s.labels !== undefined)],
    ["scalar signal without labels", scalars.some((s) => s.labels === undefined)],
    ["command signal credential present", signals.some((s) => s.credential !== undefined)],
    ["command signal credential null", signals.some((s) => s.credential === undefined)],
    ["host expectedChurn true", hosts.some((h) => h.expectedChurn === true)],
    ["host expectedChurn false", hosts.some((h) => h.expectedChurn === false)],
    ["scrape interval present", hosts.some((h) => h.scrapeIntervalClass !== undefined)],
    ["scrape interval absent", hosts.some((h) => h.scrapeIntervalClass === undefined)],
    [
      "hypervisor credential",
      hosts.some((h) => h.collectionClass === "hypervisor-api" && h.credential !== undefined),
    ],
    ["nas endpoint+credential branch", nas.some((h) => h.apiEndpoint != null && h.credential != null)],
    ["nas both-null branch", nas.some((h) => h.apiEndpoint == null && h.credential == null)],
    ["probe expect present", probes.some((h) => h.probe.expect !== undefined)],
    ["probe expect null", probes.some((h) => h.probe.expect === undefined)],
    ["excluded host present", hosts.some((h) => h.collectionClass === "excluded")],
    ["service managed true", services.some((s) => s.managed)],
    ["service managed false", services.some((s) => !s.managed)],
    ["service ingress present", services.some((s) => s.ingressUrl !== undefined)],
    ["service ingress omitted", services.some((s) => s.ingressUrl === undefined)],
    ["service suppression present", services.some((s) => s.suppressed !== undefined)],
    ["service suppression null", services.some((s) => s.suppressed === undefined)],
    ["deep-health detail present", deep.length > 0],
    ["deep-health absent", services.some((s) => s.deepHealth === undefined)],
    ["deep-health hostLocal true", deep.some((d) => d.hostLocal === true)],
    ["deep-health hostLocal false", deep.some((d) => d.hostLocal === false)],
    ["deep-health credential present", deep.some((d) => d.credential !== undefined)],
    ["deep-health credential null", deep.some((d) => d.credential === undefined)],
    ["deep-health multi-key response mapping", deep.some((d) => Object.keys(d.responseMapping).length > 1)],
    ["backup absent", services.some((s) => s.backupFreshness === undefined)],
    ["backup present", backups.length > 0],
    ["backup command present", backups.some((b) => b.command !== undefined)],
    ["backup command absent", backups.some((b) => b.command === undefined)],
    ["backup declared interval", backups.some((b) => b.interval !== undefined)],
    ["backup default interval", backups.some((b) => b.interval === undefined)],
    [
      "endpoint alert with every optional key declared",
      alerts.some(
        (a) =>
          a.enabled !== undefined &&
          a.failureThreshold !== undefined &&
          a.successThreshold !== undefined &&
          a.description !== undefined &&
          a.sendOnResolved !== undefined,
      ),
    ],
    [
      "endpoint alert with every optional key omitted",
      alerts.some(
        (a) =>
          a.enabled === undefined &&
          a.failureThreshold === undefined &&
          a.successThreshold === undefined &&
          a.description === undefined &&
          a.sendOnResolved === undefined,
      ),
    ],
    [
      "all five channel kinds present",
      (["chat", "email", "push", "telegram", "webhook"] as const).every((k) => channelKinds.has(k)),
    ],
    ["channel options present", model.channels.some((c) => c.options !== undefined)],
    ["channel options null", model.channels.some((c) => c.options === undefined)],
    ["env credential reference", creds.some((c) => c.kind === "env")],
    ["op credential reference", creds.some((c) => c.kind === "op")],
    ["routing override present", model.routingOverrides.length > 0],
    ["standalone suppression present", model.suppressions.length > 0],
    ["finding severity error", findings.some((f) => f.severity === "error")],
    ["finding severity warning", findings.some((f) => f.severity === "warning")],
    ["finding severity info", findings.some((f) => f.severity === "info")],
  ];

  for (const [label, ok] of checks) {
    if (!ok) throw new Error(`benchmark fixture invariant failed: ${label}`);
  }
}

// ── Benchmark orchestration ─────────────────────────────────────────────────────────────────────

/** Execute fixture checks, warm-ups, five render samples, and five load samples (07 §5.3). */
async function runBenchmark(): Promise<BenchmarkSummary> {
  const fixture = buildRenderedModelV2BenchmarkFixture();
  assertFixtureShape(fixture);

  // Generation series: one discarded warm-up, then five measured samples.
  await generationSample(fixture);
  const renderRaw: number[] = [];
  for (let i = 0; i < MEASURED_SAMPLE_COUNT; i++) renderRaw.push(await generationSample(fixture));

  // Load series: one discarded warm-up, then five measured samples.
  await loadSample(fixture);
  const loadRaw: number[] = [];
  for (let i = 0; i < MEASURED_SAMPLE_COUNT; i++) loadRaw.push(await loadSample(fixture));

  const renderSamplesMs = toFiveSamples(renderRaw, "render");
  const loadSamplesMs = toFiveSamples(loadRaw, "load");

  return {
    renderMedianMs: medianFive(renderSamplesMs),
    loadMedianMs: medianFive(loadSamplesMs),
    runtime: `Bun ${Bun.version}`,
    counts: { hosts: BENCHMARK_HOST_COUNT, services: BENCHMARK_SERVICE_COUNT },
    renderSamplesMs,
    loadSamplesMs,
  };
}

/** Format one sample array at stable precision. */
function fmt(samples: FiveSamples): string {
  return `[${samples.map((s) => s.toFixed(3)).join(", ")}]`;
}

async function main(): Promise<void> {
  if (Bun.version !== AUTHORITATIVE_BUN_VERSION) {
    throw new Error(
      `authoritative benchmark requires Bun ${AUTHORITATIVE_BUN_VERSION}, but this runtime is Bun ${Bun.version}. ` +
        `Re-run under Bun ${AUTHORITATIVE_BUN_VERSION} on ubuntu-latest with the network disabled; ` +
        `results from any other runtime are not authoritative.`,
    );
  }

  const summary = await runBenchmark();

  console.log("rendered-model-v2 envelope benchmark");
  console.log(`  runtime:          ${summary.runtime}`);
  console.log(`  hosts:            ${summary.counts.hosts}`);
  console.log(`  services:         ${summary.counts.services}`);
  console.log(`  samples/series:   ${MEASURED_SAMPLE_COUNT} (after 1 warm-up)`);
  console.log(`  render threshold: < ${RENDER_MEDIAN_LIMIT_MS} ms`);
  console.log(`  load threshold:   < ${LOAD_MEDIAN_LIMIT_MS} ms`);
  console.log(`  render samples:   ${fmt(summary.renderSamplesMs)} ms`);
  console.log(`  render median:    ${summary.renderMedianMs.toFixed(3)} ms`);
  console.log(`  load samples:     ${fmt(summary.loadSamplesMs)} ms`);
  console.log(`  load median:      ${summary.loadMedianMs.toFixed(3)} ms`);

  // Both threshold comparisons run even if the first is exceeded; equality fails (07 §5.4).
  const failures: string[] = [];
  if (summary.renderMedianMs >= RENDER_MEDIAN_LIMIT_MS) {
    failures.push(
      `render median ${summary.renderMedianMs.toFixed(3)} ms is not below ${RENDER_MEDIAN_LIMIT_MS} ms`,
    );
  }
  if (summary.loadMedianMs >= LOAD_MEDIAN_LIMIT_MS) {
    failures.push(
      `load median ${summary.loadMedianMs.toFixed(3)} ms is not below ${LOAD_MEDIAN_LIMIT_MS} ms`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`benchmark threshold(s) exceeded: ${failures.join("; ")}`);
  }

  console.log("  result:           PASS");
}

main().catch((err: unknown) => {
  console.error(`benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
