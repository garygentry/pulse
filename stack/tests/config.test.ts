/**
 * stack-core Tier-1 hermetic test suite (06-testing-strategy.md §4, §8).
 *
 * DOCKER-FREE. Every assertion here runs under plain `bun test` with **no Docker daemon**:
 *   - `docker compose config --format json` is a static parse + schema validation + env
 *     interpolation of the compose file. It does NOT contact the daemon, pull images, or
 *     start containers (06 §2). It needs only the Docker CLI (compose v2) on PATH.
 *   - The remaining checks are pure text scans of committed files.
 *
 * PRECONDITION (deliberate, 06 §2 / item 007): this tier requires the Docker CLI to be
 * present, but NOT a running daemon. Unlike the Tier-2 smoke suite (item 008), it does NOT
 * self-skip on a missing CLI — a CLI-less env must surface as a legible RED failure via
 * `composeConfig()` throwing, never a false green. A hermetic guard that silently skips is
 * worse than useless.
 *
 * Types/constants/helpers come from ./harness (the single non-test support module, 00 §9).
 */

/// <reference path="./bun-test.d.ts" />

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  composeNetworkName,
  createSmokeProjectName,
  DEFAULT_PROFILE_SERVICES,
  ENGINE_APIS,
  EXPECTED_RENDER_FORMAT_VERSION,
  FIXTURE_ENV,
  FIXTURE_RENDERED_DIR,
  PROFILE,
  RENDERED_MOUNTS,
  REPO_ROOT,
  run,
  smokeComposeArgs,
} from "./harness.js";
import type { ComposeConfig, ComposeService, RenderedManifest } from "./harness.js";

/* ===========================================================================================
 * Parse helpers — a STATIC compose parse (no daemon; 06 §2)
 * ========================================================================================= */

/**
 * Parse-validate the merged tree WITHOUT touching the daemon (default profile only).
 * The successful parse IS the YAML/schema lint: a malformed tree, an unknown key, a
 * `depends_on` on an undeclared service, etc. all make Compose exit non-zero, which this
 * turns into a thrown, legible failure (06 §4.1/§4.2). It never self-skips (see file header).
 */
function composeConfig(): ComposeConfig {
  const res = run(
    ["docker", "compose", "-f", COMPOSE_FILE, "config", "--format", "json"],
    FIXTURE_ENV,
  );
  if (res.exitCode !== 0) {
    throw new Error(
      "docker compose config failed (malformed tree, or Docker CLI absent — this hermetic " +
        `tier deliberately does not self-skip; a CLI-less env must fail RED):\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout) as ComposeConfig;
}

/**
 * Same static parse but with ALL gating profiles active, so the profile-gated service bodies
 * (`web`/`prober`) are materialized and their `profiles:` keys are assertable (they are
 * omitted from the default-profile output). Still no daemon.
 */
function composeConfigAllProfiles(): ComposeConfig {
  const res = run(["docker", "compose", "-f", COMPOSE_FILE, "config", "--format", "json"], {
    ...FIXTURE_ENV,
    COMPOSE_PROFILES: `${PROFILE.web},${PROFILE.deepHealth}`,
  });
  if (res.exitCode !== 0) {
    throw new Error(`docker compose config (all profiles) failed:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout) as ComposeConfig;
}

/**
 * Every committed, stack-core-OWNED file (the SHIPPED tree): `stack/compose/**` +
 * `stack/gatus/**`. EXCLUDES `stack/tests/fixtures/**` (test-only fictional data, §3/V-007)
 * and any real `.env` (git-ignored, 01 §4). The two roots never contain `tests/`, so the
 * fixture is out-of-scope by construction; the `tests/` filter is belt-and-suspenders.
 */
function shippedTreeFiles(): string[] {
  const roots = [join(REPO_ROOT, "stack", "compose"), join(REPO_ROOT, "stack", "gatus")];
  const out: string[] = [];
  for (const root of roots) {
    for (const ent of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const abs = join(ent.parentPath, ent.name);
      if (relative(REPO_ROOT, abs).includes(`tests${"/"}`)) continue; // never scan fixtures
      if (abs.endsWith(`${"/"}.env`)) continue; // never scan a developer .env
      out.push(abs);
    }
  }
  return out;
}

/** Concatenated text of the whole shipped tree — used by the engine-apis presence scan. */
function shippedTreeText(): string {
  return shippedTreeFiles()
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/* ===========================================================================================
 * §4.1 — Project identity & parse validity (REQ-COMPOSE-01/02)
 * ========================================================================================= */

test("the tree parses and names the project `pulse` (REQ-COMPOSE-01/02)", () => {
  const cfg = composeConfig(); // throws if the YAML is malformed — the parse IS the lint (§4.2)
  expect(cfg.name).toBe(COMPOSE_PROJECT); // "pulse"
  // Every default-profile service (the six always-on + pve-exporter) is declared.
  for (const svc of DEFAULT_PROFILE_SERVICES) {
    expect(cfg.services[svc], `default-profile service ${svc} is not defined`).toBeDefined();
  }
});

test("Docker smoke projects override `pulse` with unique test-only identities (issue #24)", () => {
  const first = createSmokeProjectName("config");
  const second = createSmokeProjectName("config");
  expect(/^pulse-test-config-\d+-[0-9a-f-]{36}$/.test(first)).toBe(true);
  expect(second).not.toBe(first);
  expect(composeNetworkName(first)).toBe(`${first}_pulse`);
  let refusedProduction = false;
  try {
    smokeComposeArgs(COMPOSE_PROJECT as typeof first, COMPOSE_FILE, "up");
  } catch {
    refusedProduction = true;
  }
  expect(refusedProduction).toBe(true);

  // Static Compose parse: `-p` must scope the project and every named resource without a daemon.
  const overridden = run(
    smokeComposeArgs(first, COMPOSE_FILE, "config", "--format", "json"),
    FIXTURE_ENV,
  );
  expect(overridden.exitCode, overridden.stderr).toBe(0);
  const parsed = JSON.parse(overridden.stdout) as ComposeConfig;
  expect(parsed.name).toBe(first);
  expect((parsed.networks.pulse as { name: string }).name).toBe(composeNetworkName(first));
  expect((parsed.volumes["grafana-data"] as { name: string }).name).toBe(
    `${first}_grafana-data`,
  );
  expect((parsed.volumes["victoria-metrics-data"] as { name: string }).name).toBe(
    `${first}_victoria-metrics-data`,
  );

  // Shared consumers must use the guarded command builder; the intentionally local dashboard
  // wrapper must still pass its immutable ephemeral project explicitly.
  const sharedConsumers = [
    "stack/tests/bringup.smoke.test.ts",
    "apps/web/tests/smoke.test.ts",
    "tests/deploy-toolkit/bootstrap.smoke.test.ts",
  ];
  for (const relativePath of sharedConsumers) {
    const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    expect(source, `${relativePath} must use the guarded Compose command builder`).toContain(
      "smokeComposeArgs(",
    );
    expect(source, `${relativePath} must not probe the production network`).not.toContain(
      '"pulse_pulse"',
    );
  }
  const dashboardSource = readFileSync(
    join(REPO_ROOT, "stack/grafana/tests/provisioning.smoke.test.ts"),
    "utf8",
  );
  expect(dashboardSource).toContain('"compose", "-p", TEST_PROJECT,');
  expect(dashboardSource).not.toContain('"pulse_pulse"');
});

test("managed-host scrape jobs are unique and preserve instance == host (issue #22)", () => {
  const path = join(REPO_ROOT, "stack/compose/config/victoriametrics/scrape.yml");
  const config = parseYaml(readFileSync(path, "utf8")) as {
    scrape_configs: Array<{
      job_name: string;
      file_sd_configs?: Array<{ files: string[] }>;
      relabel_configs?: Array<{ source_labels?: string[]; target_label?: string }>;
    }>;
  };
  const names = config.scrape_configs.map((job) => job.job_name);
  expect(new Set(names).size, "scrape job names must be unique").toBe(names.length);

  const managedFiles: Record<string, string> = {
    "managed-linux": "/rendered/scrape/file_sd/managed-linux.json",
    cadvisor: "/rendered/scrape/file_sd/cadvisor.json",
    "process-exporter": "/rendered/scrape/file_sd/process-exporter.json",
    "managed-linux-heartbeat": "/rendered/scrape/file_sd/managed-linux-heartbeat.json",
    "managed-linux-prober": "/rendered/scrape/file_sd/managed-linux-prober.json",
    "managed-linux-command-exporter": "/rendered/scrape/file_sd/managed-linux-command-exporter.json",
    "managed-linux-exporters": "/rendered/scrape/file_sd/managed-linux-exporters.json",
  };
  for (const [name, expectedFile] of Object.entries(managedFiles)) {
    const job = config.scrape_configs.find((candidate) => candidate.job_name === name);
    expect(job, `missing scrape job ${name}`).toBeDefined();
    expect(job?.file_sd_configs?.flatMap((entry) => entry.files)).toEqual([expectedFile]);
    const preservesInstance = job?.relabel_configs?.some(
      (relabel) =>
        relabel.target_label === "instance" &&
        relabel.source_labels?.length === 1 &&
        relabel.source_labels[0] === "host",
    );
    expect(preservesInstance, `${name} must relabel host to instance`).toBe(true);
  }
});

test("shipped gatus config enables /metrics so the gatus scrape job & AncillaryDown work (issue #31)", () => {
  // Gatus serves /metrics ONLY when top-level `metrics: true` is set in its merged config dir.
  // The static, stack-owned `00-alerting.yaml` (stack/gatus/alerting-provider.yaml) is where the
  // estate-agnostic toggle lives (the rendered `10-endpoints.yaml` is renderer-owned, endpoints
  // only). Without it, `up{job="gatus"}` is permanently 0 and AncillaryDown false-fires (#31).
  const gatusConfig = parseYaml(
    readFileSync(join(REPO_ROOT, "stack/gatus/alerting-provider.yaml"), "utf8"),
  ) as { metrics?: unknown };
  expect(gatusConfig.metrics, "gatus config must set top-level `metrics: true` (#31)").toBe(true);

  // Consistency: the toggle exists precisely because scrape.yml scrapes gatus for /metrics and
  // engine.yml's AncillaryDown rule alerts on its `up` series — both (under stack/compose/config/)
  // must reference `gatus`.
  const scrape = parseYaml(
    readFileSync(join(REPO_ROOT, "stack/compose/config/victoriametrics/scrape.yml"), "utf8"),
  ) as { scrape_configs: Array<{ job_name: string }> };
  expect(
    scrape.scrape_configs.some((job) => job.job_name === "gatus"),
    "scrape.yml must carry the gatus job the metrics toggle feeds",
  ).toBe(true);

  const engineRules = readFileSync(
    join(REPO_ROOT, "stack/compose/config/vmalert/rules/engine.yml"),
    "utf8",
  );
  // Bounded window (the rule's own few lines) so this can't match `gatus` bleeding in from an
  // unrelated later rule — the AncillaryDown `expr:` sits within a handful of lines of its `alert:`.
  expect(
    /alert:\s*AncillaryDown(?:[^\n]*\n){0,4}?\s*expr:[^\n]*up\{job=~"[^"]*gatus[^"]*"\}/.test(
      engineRules,
    ),
    "engine.yml AncillaryDown must alert on the gatus `up` series the toggle keeps green",
  ).toBe(true);
});

/* ===========================================================================================
 * §4.3 — Mount-path match + engine-apis addresses (REQ-MOUNT-02, REQ-API-01/02)
 * ========================================================================================= */

test("every RENDERED_MOUNTS containerPath is a :ro bind on its consumer (REQ-MOUNT-02)", () => {
  const cfg = composeConfig();
  for (const mount of RENDERED_MOUNTS) {
    const svc = cfg.services[mount.consumer];
    if (!svc) continue; // `prober` is profile-gated → absent from default config; asserted in §4.7
    // `config --format json` renders each volume as an object {type,source,target,read_only,…};
    // stringify so the containerPath (target) and the read-only flag are both matchable.
    const binds = (svc.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    const hit = binds.find((b) => b.includes(mount.containerPath));
    expect(hit, `${mount.consumer} has no bind at ${mount.containerPath}`).toBeDefined();
    // The rendered bind is READ-ONLY (short `:ro` form or the object `"read_only":true` form).
    const readOnly = binds.some(
      (b) => b.includes(mount.containerPath) && (/:ro\b/.test(b) || b.includes('"read_only":true')),
    );
    expect(readOnly, `${mount.consumer}:${mount.containerPath} is not mounted :ro`).toBe(true);
  }
});

test("every engine-apis address is wired in-stack (REQ-API-01/02)", () => {
  // Enumerated set = ENGINE_APIS (00 §2). An address `svc:port` is "wired" when EITHER the
  // literal `svc:port` appears anywhere in the shipped tree (e.g. a scrape self-job, a
  // datasource url, a depends-on URL), OR the service `svc` is defined and binds `:port` in
  // its own body (command/healthcheck/expose). This is honest: it proves the addressable
  // service exists on the pulse network at the contracted port, not merely that a substring
  // happens to occur. (Not an open-ended guard — a fixed enumerated set of 5 addresses.)
  const cfg = composeConfig();
  const tree = shippedTreeText();
  for (const [svc, address] of Object.entries(ENGINE_APIS)) {
    const service = cfg.services[svc];
    expect(service, `engine-apis service ${svc} is not defined`).toBeDefined();
    const port = address.slice(address.lastIndexOf(":") + 1);
    const wired =
      tree.includes(address) || (service ? JSON.stringify(service).includes(`:${port}`) : false);
    expect(wired, `engine-apis address ${address} is not wired anywhere`).toBe(true);
  }
});

/* ===========================================================================================
 * §4.4 — Guard A: no `:latest` / digest; every image tag-pinned (REQ-COMPOSE-04)
 *
 * ENUMERATED PROTECTION SET: every `services.*.image` in the merged (default-profile) compose
 *   config carries an explicit tag after its final path segment; that tag is not `latest`; the
 *   reference contains no `@sha256:` digest pin.
 * EXPLICIT NON-GOALS: does NOT assert the tag is the newest available; does NOT pull or verify
 *   the image exists; does NOT check digest reproducibility (OQ-TAG deliberately chose tags
 *   over digests); does NOT validate non-image fields. Build-only services (`web`, 00 §1) are
 *   exempt — they have no image to pin. New checks are added to this enumerated set
 *   deliberately, never by broadening to an open-ended "use the newest tag" objective.
 * ========================================================================================= */

test("Guard A — every image is pinned to an explicit tag, never :latest/digest (REQ-COMPOSE-04)", () => {
  const cfg = composeConfig();
  for (const [name, svc] of Object.entries(cfg.services)) {
    if (svc.build && !svc.image) continue; // the `web` slot builds; no image to pin (00 §1)
    const image = svc.image;
    expect(image, `${name} has no image`).toBeDefined();
    if (!image) continue;
    // Tag lives after the final path segment: `repo/name:TAG` (a `:` in an earlier segment,
    // e.g. a registry `host:port/…`, must not be mistaken for the tag separator).
    const lastSegment = image.slice(image.lastIndexOf("/") + 1);
    const tag = lastSegment.split(":")[1];
    expect(tag, `${name} image is untagged: ${image}`).toBeDefined();
    expect(tag, `${name} image uses the forbidden :latest tag`).not.toBe("latest");
    expect(image, `${name} image is digest-pinned (@sha256:)`).not.toContain("@sha256:");
  }
});

/* ===========================================================================================
 * §4.5 — Guard B: no credential literal in the shipped tree (REQ-SEC-01)
 *
 * ENUMERATED PROTECTION SET: files under `stack/compose/**` + `stack/gatus/**` contain none of
 *   the enumerated literal-secret shapes in SECRET_LITERAL_PATTERNS (slack/gitlab/aws token
 *   prefixes, PEM private-key headers, JWTs, and bare `password|api_key|secret|token|api_url|
 *   bearer` assignments that are NOT `${VAR}` refs); and PVE_TOKEN is only ever
 *   `${VAR}`-referenced, never literal-assigned.
 * EXPLICIT NON-GOALS: does NOT scan `stack/tests/fixtures/**` (test-only fictional data,
 *   V-007) nor a developer's `.env` (git-ignored, 01 §4); does NOT assert credential VALUES
 *   are valid; does NOT attempt to detect every conceivable secret encoding — only the
 *   enumerated shapes. New secret shapes are added to the set deliberately, never by
 *   broadening to an open-ended "no secrets" objective.
 * ========================================================================================= */

const SECRET_LITERAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "slack-bot-token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "gitlab-pat", re: /glpat-[0-9A-Za-z_-]{16,}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "pem-private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: "bare-credential-assignment",
    // key: value  where value is NOT a ${VAR} ref, not empty, not quote-only/bool/number.
    re: /\b(?:password|passwd|api_key|apikey|secret|token|api_url|bearer)\s*[:=]\s*(?!\$\{)[^\s"'#][^\s#]{5,}/i,
  },
];

test("Guard B — no enumerated credential literal appears in the shipped tree (REQ-SEC-01)", () => {
  for (const file of shippedTreeFiles()) {
    const text = readFileSync(file, "utf8");
    for (const { name, re } of SECRET_LITERAL_PATTERNS) {
      const hit = re.exec(text);
      expect(hit, `${name} literal in ${relative(REPO_ROOT, file)}: ${hit?.[0]}`).toBeNull();
    }
  }
});

test("Guard B — PVE_TOKEN is only ${VAR}-referenced, never literal-assigned (REQ-SEC-01)", () => {
  // The only credential syntax stack-core ships is compose env-substitution (00 §5). Wherever
  // an exporter token is referenced in the compose file it is `${VAR}`, never an inline value.
  // (nas-api ships no exporter/credential now — issue #4 — so PVE_TOKEN is the only token here.)
  const raw = readFileSync(COMPOSE_FILE, "utf8");
  for (const varName of ["PVE_TOKEN"]) {
    // Match an assignment whose value is a real (non-`${VAR}`) token. The trailing value class
    // is required so the whitespace `\s*` cannot backtrack to zero and let the lookahead pass
    // trivially — a `${VAR}` ref (the shipped form) therefore never matches, a literal does.
    const inline = new RegExp(`${varName}\\s*[:=]\\s*(?!"?\\$\\{)[^\\s"'#][^\\s#]*`).exec(raw);
    expect(inline, `${varName} is assigned a literal in the compose file`).toBeNull();
  }
});

/* ===========================================================================================
 * §4.6 — Healthcheck presence per default-profile service (REQ-COMPOSE-03)
 * ========================================================================================= */

test("every default-profile service declares a healthcheck with test + retries (REQ-COMPOSE-03)", () => {
  const cfg = composeConfig();
  // `gatus` is exempt: its pinned image carries only the /gatus binary (no shell/wget/curl and no
  // one-shot health subcommand), so no in-container healthcheck command can run. Its readiness is
  // asserted out-of-band by the Tier-2 smoke's in-stack HTTP probe (bringup.smoke.test.ts §5.4).
  const HEALTHCHECK_EXEMPT = new Set(["gatus"]);
  for (const svc of DEFAULT_PROFILE_SERVICES) {
    if (HEALTHCHECK_EXEMPT.has(svc)) {
      expect(cfg.services[svc]?.healthcheck, `${svc} is healthcheck-exempt and must declare none`).toBe(undefined);
      continue;
    }
    const hc = cfg.services[svc]?.healthcheck;
    expect(hc, `${svc} has no healthcheck — cannot tell ready from broken`).toBeDefined();
    // A bounded budget (test + retries) lets `up --wait` distinguish "hung" from "healthy" (00 §7).
    expect(hc).toHaveProperty("test");
    expect(hc).toHaveProperty("retries");
  }
});

/* ===========================================================================================
 * §4.7 — Profile gating (REQ-WEB-02, REQ-EXP-01, OQ-A6)
 * ========================================================================================= */

test("default profile == DEFAULT_PROFILE_SERVICES; web/deep-health are gated", () => {
  // `--services` under NO active profile lists exactly the default-profile set (sorted).
  const listed = run(["docker", "compose", "-f", COMPOSE_FILE, "config", "--services"], FIXTURE_ENV)
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  expect(listed).toEqual([...DEFAULT_PROFILE_SERVICES].sort());

  // Each gated service declares its gating profile (00 §3). Parsed with all profiles active so
  // the gated bodies are materialized (they are omitted from the default-profile output).
  const gatedCfg = composeConfigAllProfiles();
  const gated: [string, string][] = [
    ["web", PROFILE.web],
    ["prober", PROFILE.deepHealth],
  ];
  for (const [svc, profile] of gated) {
    const s: ComposeService | undefined = gatedCfg.services[svc];
    expect(s, `${svc} is not defined under its active profile`).toBeDefined();
    expect(s?.profiles ?? [], `${svc} does not declare profile ${profile}`).toContain(profile);
  }
});

/* ===========================================================================================
 * §3.1 — Fixture integrity (REQ-REPRO-01, CON-03)
 * ========================================================================================= */

describe("seeded fixture integrity (REQ-REPRO-01, CON-03)", () => {
  test("carries the expected rendered formatVersion and every listed file exists", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(FIXTURE_RENDERED_DIR, ".rendered-manifest.json"), "utf8"),
    ) as RenderedManifest;
    expect(manifest.formatVersion).toBe(EXPECTED_RENDER_FORMAT_VERSION); // 2
    for (const rel of manifest.files) {
      expect(existsSync(resolve(FIXTURE_RENDERED_DIR, rel)), `fixture missing ${rel}`).toBe(true);
    }
  });
});
