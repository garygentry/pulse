// series-identity-contract.test.ts — ties the history binder's host series identity to the
// VictoriaMetrics scrape config (issue #69). The estate model carries each scrape target as the
// renderer emits it into file_sd (pre-relabel); stored series carry the labels AFTER the
// `relabel_configs` in stack/compose/config/victoriametrics/scrape.yml run. This suite replays
// those relabel rules against (a) the binder's job table and (b) real rendered bundles, and checks
// the bound host PromQL selects exactly the resulting `job`/`instance` pairs. Editing either the
// scrape config or the binder alone makes it fail.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { render, type WebEstateModelV2 } from "@pulse/renderer";

import { bindCuratedQuery } from "../../src/queries/binding.js";
import {
  ENGINE_SCRAPE_JOBS,
  ESTATE_SCRAPE_INSTANCE_SOURCE,
  HOST_LIVENESS_JOB,
  NODE_EXPORTER_JOBS,
  scrapeSeriesIdentity,
  type ScrapeInstanceSource,
  type ScrapeSeriesIdentity,
} from "../../src/queries/series-identity.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRAPE_YML = resolve(REPO_ROOT, "stack/compose/config/victoriametrics/scrape.yml");
const AVAILABILITY_RULES = resolve(REPO_ROOT, "stack/compose/config/vmalert/rules/availability.yml");

// ---------------------------------------------------------------------------
// A minimal Prometheus relabel engine (action: replace only — anything else fails loudly)
// ---------------------------------------------------------------------------

interface RelabelRule {
  readonly source_labels?: readonly string[];
  readonly separator?: string;
  readonly regex?: string;
  readonly target_label?: string;
  readonly replacement?: string;
  readonly action?: string;
}
interface ScrapeJob {
  readonly job_name: string;
  readonly file_sd_configs?: ReadonlyArray<{ readonly files: readonly string[] }>;
  readonly relabel_configs?: readonly RelabelRule[];
}

const scrapeJobs: readonly ScrapeJob[] = (
  parseYaml(readFileSync(SCRAPE_YML, "utf8")) as { scrape_configs: ScrapeJob[] }
).scrape_configs;
const fileSdJobs = scrapeJobs.filter((job) => (job.file_sd_configs ?? []).length > 0);
const fileSdJobByName = new Map(fileSdJobs.map((job) => [job.job_name, job]));

/**
 * Go `regexp.Expand` semantics for a relabel replacement: `$$` is a literal `$`; `$name` takes the
 * longest run of letters, digits and underscores; `${name}` is explicit. An all-digit name is a
 * group number, anything else a named group; an unknown or out-of-range reference expands empty.
 */
function expand(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(?:(\$)|\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/g, (_, dollar, braced, bare) => {
    if (dollar !== undefined) return "$";
    const name: string = braced ?? bare;
    if (/^\d+$/.test(name)) return match[Number(name)] ?? "";
    return match.groups?.[name] ?? "";
  });
}

/** Apply a job's relabel rules to one discovered target, returning the final target labels. */
function relabel(job: ScrapeJob, address: string, groupLabels: Readonly<Record<string, string>>): Record<string, string> {
  const labels: Record<string, string> = { ...groupLabels, __address__: address, job: job.job_name };
  for (const rule of job.relabel_configs ?? []) {
    const action = rule.action ?? "replace";
    if (action !== "replace") {
      throw new Error(`${job.job_name}: relabel action "${action}" is not modelled; extend this test`);
    }
    const value = (rule.source_labels ?? []).map((name) => labels[name] ?? "").join(rule.separator ?? ";");
    // RE2 named groups (?P<name>…) are spelled (?<name>…) in JS; the match is fully anchored.
    const pattern = (rule.regex ?? "(.*)").replaceAll("(?P<", "(?<");
    const match = new RegExp(`^(?:${pattern})$`).exec(value);
    if (match === null || rule.target_label === undefined) continue;
    const replaced = expand(rule.replacement ?? "$1", match);
    if (replaced === "") delete labels[rule.target_label];
    else labels[rule.target_label] = replaced;
  }
  // Prometheus defaults `instance` to the final `__address__` when no rule set it.
  if (labels.instance === undefined) labels.instance = labels.__address__!;
  return labels;
}

// ---------------------------------------------------------------------------
// Rendered bundles: a synthetic estate covering every class + committed reference outputs
// ---------------------------------------------------------------------------

interface FileSdGroup {
  readonly targets: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}
interface Bundle {
  readonly name: string;
  readonly model: WebEstateModelV2;
  readonly fileSd: ReadonlyMap<string, readonly FileSdGroup[]>;
}

const PROV = { file: "estate.yaml", path: "", line: 1, col: 1 };

function syntheticBundle(): Bundle {
  const estate = {
    schemaMajor: 1,
    estate: { name: "contract", domains: ["example.com"], timezone: "UTC", deadmanHook: "https://deadman.example.com/ping", provenance: PROV },
    hosts: [
      { name: "web01", collectionClass: "managed-linux", addresses: ["10.0.0.4"], exporterPorts: [9100, 9256, 9400, 9500], cadvisor: true, heartbeat: true, deliveryForm: "compose", commandSignals: [], provenance: PROV },
      { name: "pve1", collectionClass: "hypervisor-api", addresses: ["10.0.0.5"], apiEndpoint: "https://pve1:8006", credential: { kind: "env", raw: "${PVE}", varName: "PVE" }, provenance: PROV },
      { name: "nas1", collectionClass: "nas-api", addresses: ["10.0.0.6"], apiEndpoint: "https://nas1", credential: { kind: "env", raw: "${NAS}", varName: "NAS" }, provenance: PROV },
      { name: "edge1", collectionClass: "probe-only", addresses: ["10.0.0.9"], probe: { kind: "icmp", target: "10.0.0.9" }, provenance: PROV },
    ],
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  } as unknown as Parameters<typeof render>[0];
  const result = render(estate);
  if (!result.ok) throw new Error(`synthetic render failed: ${JSON.stringify(result.findings)}`);
  const files = new Map(result.tree.map((f) => [f.path, f.contents]));
  const fileSd = new Map<string, readonly FileSdGroup[]>();
  for (const [path, contents] of files) {
    const m = /^scrape\/file_sd\/(.+)\.json$/.exec(path);
    if (m !== null) fileSd.set(m[1]!, JSON.parse(contents) as FileSdGroup[]);
  }
  return { name: "synthetic", model: JSON.parse(files.get("web-estate-model.json")!) as WebEstateModelV2, fileSd };
}

function committedBundle(rel: string): Bundle {
  const root = resolve(REPO_ROOT, rel);
  const dir = resolve(root, "scrape/file_sd");
  const fileSd = new Map<string, readonly FileSdGroup[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    fileSd.set(file.slice(0, -".json".length), JSON.parse(readFileSync(resolve(dir, file), "utf8")) as FileSdGroup[]);
  }
  return { name: rel, model: JSON.parse(readFileSync(resolve(root, "web-estate-model.json"), "utf8")) as WebEstateModelV2, fileSd };
}

const COMMITTED = [
  "examples/reference/rendered",
  "packages/renderer/tests/golden/multiclass.golden",
  "stack/tests/fixtures/rendered",
].filter((rel) => existsSync(resolve(REPO_ROOT, rel, "web-estate-model.json")));

const bundles: readonly Bundle[] = [syntheticBundle(), ...COMMITTED.map(committedBundle)];

/** Jobs the renderer may emit that no VM scrape job reads (deliberately unwired, scrape.yml §probe-only). */
const UNWIRED_JOBS = new Set(["probe-only"]);

/** The stored identity scrape.yml produces for one rendered target of `host`. */
function storedIdentity(bundle: Bundle, hostName: string, job: string, target: string): ScrapeSeriesIdentity {
  const scrapeJob = fileSdJobByName.get(job);
  if (scrapeJob === undefined) throw new Error(`${bundle.name}: no scrape.yml job ${job}`);
  const groups = (bundle.fileSd.get(job) ?? []).filter(
    (g) => g.labels.host === hostName && g.targets.includes(target),
  );
  expect(groups.length, `${bundle.name}: ${job} file_sd group for ${hostName} ${target}`).toBe(1);
  const labels = relabel(scrapeJob, target, groups[0]!.labels);
  return { job: labels.job!, instance: labels.instance! };
}

const key = (s: ScrapeSeriesIdentity): string => `${s.job}\u0000${s.instance}`;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe("scrape series identity contract (issue #69)", () => {
  test("the binder's job table matches every file_sd job's relabel rules in scrape.yml", () => {
    const derived: Record<string, ScrapeInstanceSource> = {};
    for (const job of fileSdJobs) {
      const instance = relabel(job, "ADDRESS:1", { host: "HOSTNAME", collection_class: "x" }).instance;
      if (instance === "HOSTNAME") derived[job.job_name] = "host";
      else if (instance === "ADDRESS:1") derived[job.job_name] = "address";
      else throw new Error(`${job.job_name}: instance derives from neither host nor address (${instance})`);
    }
    expect({ ...ESTATE_SCRAPE_INSTANCE_SOURCE }).toEqual(derived);
    // Every managed-host and NAS job honours the estate-wide instance == host contract (#22).
    expect(Object.entries(derived).filter(([, v]) => v === "address").map(([k]) => k)).toEqual(["hypervisor-api"]);
  });

  test("the relabel engine expands replacements the way Prometheus (Go regexp.Expand) does", () => {
    const m = /^(?:(?<h>[a-z]+):(\d+))$/.exec("node:9100")!;
    expect(expand("$1", m)).toBe("node");
    expect(expand("${1}x", m)).toBe("nodex");
    expect(expand("$1x", m)).toBe(""); // `1x` is one (unknown) name, as in Go
    expect(expand("$$1", m)).toBe("$1");
    expect(expand("${h}-$2", m)).toBe("node-9100");
    expect(expand("$h", m)).toBe("node");
  });

  test("engine scrape jobs are exactly scrape.yml's static (non-file_sd) jobs", () => {
    const staticJobs = scrapeJobs.filter((job) => (job.file_sd_configs ?? []).length === 0).map((job) => job.job_name);
    expect([...ENGINE_SCRAPE_JOBS].sort()).toEqual(staticJobs.sort());
  });

  test("host liveness jobs are wired file_sd jobs and managed-linux matches the HostDown rule", () => {
    for (const job of Object.values(HOST_LIVENESS_JOB)) expect(fileSdJobByName.has(job), job).toBe(true);
    const rules = parseYaml(readFileSync(AVAILABILITY_RULES, "utf8")) as {
      groups: Array<{ rules: Array<{ alert?: string; expr?: string }> }>;
    };
    const hostDown = rules.groups.flatMap((g) => g.rules).find((r) => r.alert === "HostDown");
    expect(hostDown?.expr).toContain(`up{job="${HOST_LIVENESS_JOB["managed-linux"]}"}`);
  });

  test("node_exporter jobs are exactly the wired jobs that scrape :9100", () => {
    for (const job of NODE_EXPORTER_JOBS) expect(fileSdJobByName.has(job), job).toBe(true);
    for (const bundle of bundles) {
      for (const host of bundle.model.hosts) {
        for (const t of host.scrapeTargets) {
          if (UNWIRED_JOBS.has(t.job)) continue;
          expect(t.instance.endsWith(":9100"), `${bundle.name} ${t.job} ${t.instance}`).toBe(NODE_EXPORTER_JOBS.has(t.job));
        }
      }
    }
  });

  test("bundles under test cover every wired file_sd job", () => {
    const covered = new Set(bundles.flatMap((b) => b.model.hosts.flatMap((h) => h.scrapeTargets.map((t) => t.job))));
    for (const job of fileSdJobs) expect(covered.has(job.job_name), `no bundle exercises ${job.job_name}`).toBe(true);
  });

  for (const bundle of bundles) {
    test(`${bundle.name}: every rendered scrape target maps to the identity scrape.yml stores`, () => {
      let checked = 0;
      for (const host of bundle.model.hosts) {
        for (const target of host.scrapeTargets) {
          for (const group of bundle.fileSd.get(target.job) ?? []) {
            // The renderer never pre-sets job/instance; scrape.yml owns them.
            expect(Object.keys(group.labels)).not.toContain("job");
            expect(Object.keys(group.labels)).not.toContain("instance");
          }
          if (UNWIRED_JOBS.has(target.job)) {
            expect(fileSdJobByName.has(target.job)).toBe(false);
            continue;
          }
          expect(scrapeSeriesIdentity(host.name, target)).toEqual(storedIdentity(bundle, host.name, target.job, target.instance));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    test(`${bundle.name}: host history queries select exactly the stored job/instance series`, () => {
      const HOST_QUERIES = [
        "estate.liveness",
        "host.cpu.utilization",
        "host.memory.utilization",
        "host.disk.utilization",
        "host.load.1m",
      ] as const;
      for (const host of bundle.model.hosts) {
        const wired = host.scrapeTargets.filter((t) => !UNWIRED_JOBS.has(t.job));
        if (wired.length === 0) continue;
        const stored = wired.map((t) => storedIdentity(bundle, host.name, t.job, t.instance));
        const mainJob = HOST_LIVENESS_JOB[host.collectionClass];
        expect(mainJob, `${bundle.name} ${host.name} has a liveness job`).toBeDefined();
        for (const queryId of HOST_QUERIES) {
          const picked = queryId === "estate.liveness"
            ? stored.filter((s) => s.job === mainJob)
            : stored.filter((s) => NODE_EXPORTER_JOBS.has(s.job));
          const r = bindCuratedQuery(queryId, { kind: "host", id: host.drilldownId }, null, bundle.model);
          if (picked.length === 0) {
            // e.g. hypervisor capacity: no node_exporter series, so the query is not applicable.
            expect(r.ok, `${bundle.name} ${host.name} ${queryId}`).toBe(false);
            continue;
          }
          expect(r.ok, `${bundle.name} ${host.name} ${queryId}`).toBe(true);
          if (!r.ok) continue;
          const expected = new Set(picked.map(key));
          const selected = new Set(
            [...r.query.promql.matchAll(/\bjob="((?:[^"\\]|\\.)*)",instance="((?:[^"\\]|\\.)*)"/g)].map((m) =>
              key({ job: m[1]!, instance: m[2]! }),
            ),
          );
          expect([...selected].sort(), `${bundle.name} ${host.name} ${queryId}`).toEqual([...expected].sort());
          // Every series selector pins both labels; nothing selects on the bare rendered address.
          expect(r.query.promql).not.toMatch(/\{instance=/);
        }
      }
    });
  }
});
