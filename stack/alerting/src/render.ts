// stack/alerting/src/render.ts
// The transform harness (03 §2). Holds two things:
//   1. `buildAlertingConfig` — the PURE orchestrator. Fans out to the three sub-builders
//      (buildAlertmanagerConfig 007, buildDeepHealthRules + buildBackupRules 004), collects their
//      findings into one array, applies the whole-or-nothing rule (any `error` finding → all three
//      YAML strings are ""), and owns the single deterministic serialization of the AM config object.
//      No I/O, no clock, no randomness (determinism invariant 3).
//   2. `renderToDisk`/`main` — the thin I/O wrapper. Loads + validates the estate (aborting before
//      the transform on failure), parses the rendered routing + prober inputs (a parse failure is an
//      INVALID_ROUTE error, nothing written), runs the pure transform, and — only on the no-error
//      path — stages every output to `*.tmp` then `renameSync`s each into place (atomic per-file,
//      REQ-CONC-01). The last known-good rendered tree is preserved on any failure.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadAndValidate, type EstateModel, type Finding } from "@pulse/core";
import type { AmRoutingRendered, ProberConfigRendered } from "./transform/rendered.js";
import type { AlertingFinding } from "./transform/findings.js";
import { buildDeepHealthRules } from "./transform/deep-health-rules.js";
import { buildBackupRules } from "./transform/backup-rules.js";
import { buildAlertmanagerConfig } from "./transform/routing.js";

/** The complete input the pure transform consumes (00 §4). Every source is read-only. */
export interface TransformInput {
  /** The validated estate model (from `@pulse/core`'s `loadAndValidate`). */
  estate: EstateModel;
  /** The abstract routing tree — the single routing source of truth (REQ-ROUTE-06). */
  routing: AmRoutingRendered;
  /** The rendered prober config — source of deep-health/backup declarations. */
  prober: ProberConfigRendered;
}

/** The complete, deterministic output the pure transform produces (00 §4). */
export interface TransformOutput {
  /** Native Alertmanager config YAML, or "" on the whole-or-nothing abort (REQ-CONFIG-01). */
  alertmanagerConfig: string;
  /** Per-service functional deep-health rules YAML, or "" on abort. */
  deepHealthRules: string;
  /** Per-service backup-freshness rules YAML, or "" on abort. */
  backupRules: string;
  /** Every finding the sub-builders emitted (advisory + error). */
  findings: AlertingFinding[];
}

/**
 * Build the complete native Alertmanager config and the inventory-derived vmalert rule families for
 * one estate. Pure and deterministic (invariant 3): no I/O, no clock, no randomness.
 *
 * @param input - Validated estate model + rendered routing + rendered prober config (00 §4).
 * @returns A complete `TransformOutput`, OR — if any sub-builder emitted a `severity: "error"`
 *          finding — one whose three YAML fields are the empty string and whose `findings` carry the
 *          error(s). Never a partial artifact (whole-or-nothing — REQ-CONFIG-01).
 */
export function buildAlertingConfig(input: TransformInput): TransformOutput {
  const findings: AlertingFinding[] = [];

  // 007's scope — the native Alertmanager config as an `AmNativeConfig` object. Returns null when it
  // pushed an error-severity finding (whole-or-nothing).
  const amConfig = buildAlertmanagerConfig(
    { estate: input.estate, routing: input.routing },
    findings,
  );

  // 004's scope — the inventory-derived vmalert rule families.
  const deepHealthRules = buildDeepHealthRules(input.prober, findings); // §4
  const backupRules = buildBackupRules(input.prober, findings); // §5

  // Whole-or-nothing (REQ-CONFIG-01): a single error-severity finding blanks ALL outputs so the I/O
  // wrapper writes nothing and the last known-good rendered tree is retained.
  if (findings.some((f) => f.severity === "error")) {
    return { alertmanagerConfig: "", deepHealthRules: "", backupRules: "", findings };
  }

  // The orchestrator owns the single YAML serialization of the AM config — deterministic, fixed key
  // order (sortMapEntries), long lines unwrapped (04 §12). `amConfig` is non-null on the no-error path.
  const alertmanagerConfig = amConfig
    ? stringifyYaml(amConfig, { sortMapEntries: true, lineWidth: 0 })
    : "";
  return { alertmanagerConfig, deepHealthRules, backupRules, findings };
}

/** Options for the I/O wrapper (03 §2.3). */
export interface RenderOptions {
  /** Estate config directory passed to `@pulse/core` `loadAndValidate`. */
  estateDir: string;
  /** Root of the `rendered/` tree: holds `alertmanager/routing.yaml`, `prober/config.yaml`, and
   *  receives `alertmanager/alertmanager.yml`, `vmalert/rules/{deep-health,backup}.yml`. */
  renderedDir: string;
  /** When `false`, run the transform and report findings but write nothing (dry-run). Default `true`. */
  write?: boolean;
}

/** The result of an I/O render pass (03 §2.3). */
export interface RenderResult {
  /** `true` iff the estate loaded AND the transform produced no error-severity finding. */
  ok: boolean;
  /** `@pulse/core` estate-load findings (populated only when the estate itself failed to load). */
  estateFindings: Finding[];
  /** Transform findings (`AlertingFinding`, 00 §5). */
  findings: AlertingFinding[];
  /** Absolute paths written. Empty on failure or dry-run. Either ALL three are written or none. */
  written: string[];
}

/**
 * Read one prober config file if present. Returns `null` for an ABSENT file (ENOENT — a non-event,
 * e.g. no central probes, or a host with no per-host prober); a MALFORMED file (unreadable for any
 * other reason, or unparseable YAML) throws, which `renderToDisk` turns into an INVALID_ROUTE abort.
 */
function readProberFileIfPresent(path: string): ProberConfigRendered | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // absent → not an error
    throw e;
  }
  return parseYaml(raw) as ProberConfigRendered; // a parse error propagates → INVALID_ROUTE
}

/**
 * Gather every prober declaration the transform must see: the central `prober/config.yaml` (OPTIONAL)
 * plus each per-host `agent/<host>/prober/config.yaml` (issue #8). Host-local deep-health probes live
 * only in the per-host configs, and vmalert runs centrally, so their declared `alertExpression` can
 * become a rule ONLY here. Absent files are skipped (an all-host-local estate emits no central
 * config — that must not abort); a malformed file throws (→ INVALID_ROUTE). Hosts are read in sorted
 * order for determinism (the sub-builders sort their own output regardless).
 */
function readAllProberProbes(renderedDir: string): ProberConfigRendered["probes"] {
  const probes: ProberConfigRendered["probes"] = [];
  const central = readProberFileIfPresent(join(renderedDir, "prober", "config.yaml"));
  if (central?.probes) probes.push(...central.probes);

  let hosts: string[] = [];
  try {
    hosts = readdirSync(join(renderedDir, "agent"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No agent/ subtree → no per-host probers. (ENOENT/ENOTDIR are non-events here.)
  }
  for (const host of hosts) {
    const cfg = readProberFileIfPresent(join(renderedDir, "agent", host, "prober", "config.yaml"));
    if (cfg?.probes) probes.push(...cfg.probes);
  }
  return probes;
}

/** Read the rendered tree + estate, run the transform, and (whole-or-nothing) write the outputs. */
export function renderToDisk(opts: RenderOptions): RenderResult {
  // 1. Estate model. A failed load aborts BEFORE the transform — the rendered tree is untouched.
  const load = loadAndValidate(opts.estateDir);
  if (!load.ok) {
    return { ok: false, estateFindings: load.findings, findings: [], written: [] };
  }

  // 2. Rendered inputs. A read/parse failure is a hard abort (nothing is written) → INVALID_ROUTE.
  //    routing.yaml is REQUIRED. The prober declarations are gathered from the central
  //    prober/config.yaml (OPTIONAL — absent means no central probes) PLUS every per-host
  //    agent/<host>/prober/config.yaml (issue #8): host-local deep-health probes live only in the
  //    per-host configs, and vmalert is central, so the transform is the sole place their declared
  //    alertExpression can become a rule. A MALFORMED file (any of them) still aborts → INVALID_ROUTE.
  const routingPath = join(opts.renderedDir, "alertmanager", "routing.yaml");
  let routing: AmRoutingRendered;
  let prober: ProberConfigRendered;
  try {
    routing = parseYaml(readFileSync(routingPath, "utf8")) as AmRoutingRendered;
    prober = { probes: readAllProberProbes(opts.renderedDir) };
  } catch (err) {
    const errPath =
      err instanceof Error && "path" in err ? String((err as { path: unknown }).path) : routingPath;
    return {
      ok: false,
      estateFindings: [],
      findings: [
        {
          severity: "error",
          code: "INVALID_ROUTE",
          file: errPath,
          path: "(file)",
          message: `Could not read/parse a rendered input: ${(err as Error).message}`,
          fix: "Re-run the renderer; ensure rendered/alertmanager/routing.yaml and rendered/prober/config.yaml exist and are valid YAML.",
        },
      ],
      written: [],
    };
  }

  // 3. Pure transform.
  const out = buildAlertingConfig({ estate: load.model, routing, prober });
  if (out.findings.some((f) => f.severity === "error")) {
    return { ok: false, estateFindings: [], findings: out.findings, written: [] };
  }
  if (opts.write === false) {
    return { ok: true, estateFindings: [], findings: out.findings, written: [] };
  }

  // 4. Whole-or-nothing write: stage ALL temps first, then rename ALL. A crash between renames leaves
  //    each individual file either fully old or fully new — never truncated (REQ-CONC-01).
  const targets: Array<[string, string]> = [
    [join(opts.renderedDir, "alertmanager", "alertmanager.yml"), out.alertmanagerConfig],
    [join(opts.renderedDir, "vmalert", "rules", "deep-health.yml"), out.deepHealthRules],
    [join(opts.renderedDir, "vmalert", "rules", "backup.yml"), out.backupRules],
  ];
  const temps: Array<[string, string]> = [];
  for (const [path, content] of targets) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8"); // stage
    temps.push([tmp, path]);
  }
  const written: string[] = [];
  for (const [tmp, path] of temps) {
    renameSync(tmp, path); // atomic per-file replacement
    written.push(path);
  }
  return { ok: true, estateFindings: [], findings: out.findings, written };
}

/**
 * CLI entrypoint for the `alerting:render` root script (01 §3). Reads `estateDir`/`renderedDir` from
 * argv, runs `renderToDisk`, prints findings, and returns a non-zero exit code when `ok === false`.
 *
 * @param argv - Positional args: `<estateDir> <renderedDir>`.
 * @returns Process exit code (0 on success, 1 on any failure/usage error).
 */
export function main(argv: string[]): number {
  const [estateDir, renderedDir] = argv;
  if (!estateDir || !renderedDir) {
    console.error("usage: alerting:render <estateDir> <renderedDir>");
    return 1;
  }

  const result = renderToDisk({ estateDir, renderedDir });

  for (const f of result.estateFindings) {
    console.error(`[estate] ${f.severity} ${f.code} ${f.file}:${f.path} — ${f.message}`);
  }
  for (const f of result.findings) {
    const stream = f.severity === "error" ? console.error : console.log;
    stream(`[${f.severity}] ${f.code} ${f.file}:${f.path} — ${f.message}`);
  }

  if (result.ok) {
    for (const path of result.written) console.log(`wrote ${path}`);
    return 0;
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
