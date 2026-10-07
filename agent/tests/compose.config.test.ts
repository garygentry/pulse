/**
 * host-agent Tier-1 hermetic structural suite (06-testing-strategy.md §4, §2).
 *
 * DAEMON-FREE. Every assertion runs under plain `bun test` with **no Docker daemon**:
 *   - `docker compose config --format json` is a static parse + env interpolation of the
 *     per-host bundle fragment. It does NOT contact the daemon, pull images, or start any
 *     container (06 §2). It needs only the Docker CLI (compose v2) on PATH.
 *   - The systemd + scrape checks are pure text scans of committed files.
 *
 * PRECONDITION (deliberate, 06 §2): this tier requires the Docker CLI, but NOT a running
 * daemon. Unlike the Tier-2 smoke suite, it does **not** self-skip on a missing CLI — a
 * CLI-less env must surface as a legible RED failure via `parseCompose()` throwing, never a
 * false green (§2: "a missing Docker CLI surfaces as RED, never a false green").
 *
 * Scope: STRUCTURAL only. No container is started here (bring-up is the Tier-2 smoke's job).
 * Constants/types/helpers come from ./harness (the single non-test support module, 06 §1).
 */

/// <reference path="./bun-test.d.ts" />

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CADVISOR_PORT,
  COMMAND_EXPORTER_PORT,
  CONTRACT_VERSION,
  HEARTBEAT_PORT,
  NODE_EXPORTER_PORT,
  PINNED,
  PROBER_PORT,
} from "../contract/constants.js";
import {
  CADVISOR_PROFILE,
  HEARTBEAT_PROFILE,
  COMMAND_EXPORTER_IMAGE,
  COMMAND_EXPORTER_PROFILE,
  COMPOSE_FRAGMENT,
  DEEP_HEALTH_PROFILE,
  FRAGMENT_ENV,
  HEARTBEAT_IMAGE,
  PROBER_IMAGE,
  run,
  STACK_COMPOSE_FILE,
  STACK_ENV,
  STACK_SCRAPE_FILE,
  SYSTEMD_DIR,
  SYSTEMD_UNITS,
  NON_PROBER_SYSTEMD_UNITS,
} from "./harness.js";
import type { ComposeConfig, ComposeService } from "./harness.js";

/* ===========================================================================================
 * Static-parse helpers — a daemon-free `docker compose config` (06 §2)
 * ========================================================================================= */

/**
 * Parse-validate a compose file WITHOUT touching the daemon. The successful parse IS the
 * YAML/schema lint; a malformed tree makes Compose exit non-zero, which this turns into a
 * thrown, legible failure. It NEVER self-skips — a missing Docker CLI is a thrown RED, exactly
 * as §2 requires (contrast the Tier-2 smoke, which self-skips a missing daemon).
 */
function parseCompose(file: string, env: Record<string, string>, profiles: string[] = []): ComposeConfig {
  const withProfiles = profiles.length > 0 ? { ...env, COMPOSE_PROFILES: profiles.join(",") } : env;
  const res = run(["docker", "compose", "-f", file, "config", "--format", "json"], withProfiles);
  if (res.exitCode !== 0) {
    throw new Error(
      "docker compose config failed (malformed tree, or Docker CLI absent — this hermetic " +
        `tier deliberately does not self-skip; a CLI-less env must fail RED):\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout) as ComposeConfig;
}

/** The per-host bundle fragment for the DEFAULT install: heartbeat is default-on so its profile is
 *  ACTIVE, cAdvisor (default-off) is gated OFF. Mirrors what deploy-toolkit activates for a bundle
 *  host that did not opt out of heartbeat (issue #33). */
function fragmentDefault(): ComposeConfig {
  return parseCompose(COMPOSE_FRAGMENT, FRAGMENT_ENV, [HEARTBEAT_PROFILE]);
}

/** The per-host bundle fragment with NO profiles active — a node-exporter-only host that opted out
 *  of heartbeat (heartbeat: false) and cAdvisor: only node_exporter is materialized (issue #33). */
function fragmentNodeOnly(): ComposeConfig {
  return parseCompose(COMPOSE_FRAGMENT, FRAGMENT_ENV);
}

/** The per-host bundle fragment with cAdvisor's gating profile ACTIVE alongside the default-on
 *  heartbeat profile (all three core service bodies materialized). */
function fragmentWithCadvisor(): ComposeConfig {
  return parseCompose(COMPOSE_FRAGMENT, FRAGMENT_ENV, [HEARTBEAT_PROFILE, CADVISOR_PROFILE]);
}

/** The shipped stack compose tree with the deep-health profile ACTIVE (prober materialized). */
function stackWithProber(): ComposeConfig {
  return parseCompose(STACK_COMPOSE_FILE, STACK_ENV, [DEEP_HEALTH_PROFILE]);
}

/**
 * A tag is FORBIDDEN if it floats (`latest`/`main`/`edge`), is a leftover placeholder
 * (`PINNED`/`vPINNED`/`PLACEHOLDER`), or digest-pins. Mirrors stack Guard A + the §4
 * placeholder-rejection AC.
 */
const FORBIDDEN_TAG = /(:latest\b|:main\b|:edge\b|:v?PINNED\b|PLACEHOLDER|@sha256:)/;

/** Assert an image reference is pinned to a concrete, non-placeholder, non-floating tag. */
function assertPinnedImage(image: string, label: string): void {
  // Tag lives after the final path segment: `repo/name:TAG` (an earlier `:` — a registry
  // host:port — must not be mistaken for the tag separator).
  const lastSegment = image.slice(image.lastIndexOf("/") + 1);
  const tag = lastSegment.split(":")[1];
  expect(tag, `${label} image is untagged: ${image}`).toBeDefined();
  expect(tag, `${label} image uses the forbidden :latest tag`).not.toBe("latest");
  expect(
    FORBIDDEN_TAG.test(image),
    `${label} image uses a floating/placeholder/digest tag: ${image}`,
  ).toBe(false);
}

/** Read one committed systemd unit's text. */
function unitText(name: string): string {
  return readFileSync(join(SYSTEMD_DIR, name), "utf8");
}

/** True when a service publishes a bind of `port` to the host (a `ports:` mapping, not `expose:`). */
function publishesPort(svc: ComposeService, port: number): boolean {
  return (svc.ports ?? []).some((p) => p.target === port);
}

function volumeObject(volume: string | Record<string, unknown>): Record<string, unknown> | null {
  return typeof volume === "string" ? null : volume;
}

/* ===========================================================================================
 * §4 — Compose fragment: parse validity + always-on membership (REQ-BUNDLE-02)
 * ========================================================================================= */

test("the bundle fragment parses daemon-free; node_exporter is always-on, heartbeat is profile-gated (default-on)", () => {
  const cfg = fragmentDefault(); // throws (never skips) if the CLI is absent or the YAML is malformed
  // node_exporter is the ONLY always-on member (03 §3/§5). heartbeat is default-on: present here
  // because fragmentDefault() activates the heartbeat profile (issue #33). cAdvisor stays gated OFF.
  expect(cfg.services["node-exporter"], "node_exporter is not always-on").toBeDefined();
  expect(cfg.services.heartbeat, "heartbeat is not present under the default (heartbeat) profile").toBeDefined();
  expect(cfg.services.cadvisor, "cAdvisor must be gated OFF under the default profile").toBeUndefined();
});

test("heartbeat is profile-gated: a node-exporter-only host (no profiles) materializes neither heartbeat nor cAdvisor (issue #33)", () => {
  const cfg = fragmentNodeOnly();
  // A host that opted out of heartbeat (heartbeat: false) — deploy-toolkit activates no profile.
  expect(cfg.services["node-exporter"], "node_exporter must stay always-on").toBeDefined();
  expect(cfg.services.heartbeat, "heartbeat must be gated OFF when its profile is inactive").toBeUndefined();
  expect(cfg.services.cadvisor, "cAdvisor must be gated OFF when its profile is inactive").toBeUndefined();
});

/* ===========================================================================================
 * §4 — Pinned images, never latest/placeholder (REQ-BUNDLE-06)
 * ========================================================================================= */

test("every fragment image is a concrete pinned tag matching the shared PINNED set (REQ-BUNDLE-06)", () => {
  const cfg = fragmentWithCadvisor(); // all three service bodies materialized
  const expected: Record<string, string> = {
    "node-exporter": PINNED.nodeExporter,
    cadvisor: PINNED.cadvisor,
    heartbeat: HEARTBEAT_IMAGE,
  };
  for (const [name, image] of Object.entries(expected)) {
    const svc = cfg.services[name];
    expect(svc, `${name} is not defined`).toBeDefined();
    expect(svc?.image, `${name} image drifted from the pinned tag`).toBe(image);
    if (svc?.image) assertPinnedImage(svc.image, name);
  }
});

/* ===========================================================================================
 * §4 — Published scrape ports (REQ-BUNDLE-03) + no unexpected control/write surface (REQ-SEC-02)
 * ========================================================================================= */

test("published scrape ports match the port contract; node uses host networking (REQ-BUNDLE-03)", () => {
  const cfg = fragmentWithCadvisor();
  // node_exporter observes true host stats via host networking — its :9100 listen IS the host
  // endpoint (03 §8); it declares no published `ports:` mapping.
  expect(cfg.services["node-exporter"]?.network_mode, "node_exporter must use host networking").toBe("host");
  // heartbeat and cAdvisor publish their exact contract ports.
  expect(publishesPort(cfg.services.heartbeat as ComposeService, HEARTBEAT_PORT)).toBe(true);
  expect(publishesPort(cfg.services.cadvisor as ComposeService, CADVISOR_PORT)).toBe(true);
});

test("no fragment service publishes a port beyond the local metric endpoints (REQ-SEC-02)", () => {
  const cfg = fragmentWithCadvisor();
  // The ONLY host-published bindings the bundle exposes are the read-only metric endpoints
  // 9110 (heartbeat) and 8080 (cAdvisor). node_exporter's :9100 rides host networking, not a
  // published mapping. Anything else would be an unexpected control/write surface.
  const allowed = new Set<number>([HEARTBEAT_PORT, CADVISOR_PORT]);
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const p of svc.ports ?? []) {
      expect(allowed.has(p.target), `${name} publishes unexpected port ${p.target}`).toBe(true);
    }
  }
});

/* ===========================================================================================
 * §4 — cAdvisor opt-in gating (REQ-CONT-01)
 * ========================================================================================= */

test("cAdvisor is present-but-profile-gated in the fragment (REQ-CONT-01)", () => {
  // Absent under the default profile ...
  expect(fragmentDefault().services.cadvisor).toBeUndefined();
  // ... and present, declaring its gating profile, when that profile is active.
  const gated = fragmentWithCadvisor().services.cadvisor;
  expect(gated, "cAdvisor body is not materialized under its profile").toBeDefined();
  expect(gated?.profiles ?? [], "cAdvisor does not declare its gating profile").toContain(CADVISOR_PROFILE);
});

/* ===========================================================================================
 * §4 — command-exporter opt-in gating + published port (issue #3/#1)
 * ========================================================================================= */

/** The per-host fragment with the command-exporter profile ACTIVE (its body materialized). */
function fragmentWithCommandExporter(): ComposeConfig {
  return parseCompose(COMPOSE_FRAGMENT, FRAGMENT_ENV, [COMMAND_EXPORTER_PROFILE]);
}

test("command-exporter is present-but-profile-gated, pinned, publishes :9130, parses its config mount RO (issue #3/#1)", () => {
  // Absent under the default profile (a host with no command signals never runs it) ...
  expect(fragmentDefault().services["command-exporter"]).toBeUndefined();
  // ... and materialized, declaring its gating profile, when active.
  const svc = fragmentWithCommandExporter().services["command-exporter"];
  expect(svc, "command-exporter body is not materialized under its profile").toBeDefined();
  expect(svc?.profiles ?? [], "command-exporter does not declare its gating profile").toContain(
    COMMAND_EXPORTER_PROFILE,
  );
  expect(svc?.image, "command-exporter image drifted from the pinned tag").toBe(COMMAND_EXPORTER_IMAGE);
  if (svc?.image) assertPinnedImage(svc.image, "command-exporter");
  expect(svc?.restart, "command-exporter declares no restart policy").toBe("unless-stopped");
  // Publishes its read-only metric endpoint :9130 (COMMAND_EXPORTER_PORT).
  expect(publishesPort(svc as ComposeService, COMMAND_EXPORTER_PORT)).toBe(true);
  // The rendered command-exporter config is bound READ-ONLY (the exporter PARSES it at runtime).
  const binds = (svc?.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  const cfgMount = binds.find((b) => b.includes("/rendered/command-exporter/config.yaml"));
  expect(cfgMount, "command-exporter has no rendered-config bind").toBeDefined();
  const ro = /:ro\b/.test(cfgMount ?? "") || (cfgMount ?? "").includes('"read_only":true');
  expect(ro, "the command-exporter config mount is not read-only").toBe(true);
  // Every bind the exporter declares is read-only (no write surface).
  for (const b of binds) {
    const readOnly = /:ro\b/.test(b) || b.includes('"read_only":true');
    expect(readOnly, `command-exporter has a writable mount: ${b}`).toBe(true);
  }
});

/* ===========================================================================================
 * §4b — per-host prober opt-in gating + host networking (issue #8)
 * ========================================================================================= */

/** The per-host fragment with the deep-health profile ACTIVE (the per-host prober materialized). */
function fragmentWithProber(): ComposeConfig {
  return parseCompose(COMPOSE_FRAGMENT, FRAGMENT_ENV, [DEEP_HEALTH_PROFILE]);
}

test("per-host prober is present-but-profile-gated, pinned, host-networked, parses its config mount RO (issue #8)", () => {
  // Absent under the default profile (a host with no host-local probes never runs it) ...
  expect(fragmentDefault().services.prober).toBeUndefined();
  // ... and materialized, declaring its gating profile, when active.
  const svc = fragmentWithProber().services.prober;
  expect(svc, "per-host prober body is not materialized under its profile").toBeDefined();
  expect(svc?.profiles ?? [], "per-host prober does not declare its gating profile").toContain(
    DEEP_HEALTH_PROFILE,
  );
  expect(svc?.image, "per-host prober image drifted from the pinned tag").toBe(PROBER_IMAGE);
  if (svc?.image) assertPinnedImage(svc.image, "prober");
  expect(svc?.restart, "per-host prober declares no restart policy").toBe("unless-stopped");
  // Host networking so loopback/bridge-local targets resolve on the host (the whole point, issue #8).
  expect(svc?.network_mode, "per-host prober must use host networking").toBe("host");
  // Host-label suppression so scrape-time file_sd owns the host label.
  const env = svc?.environment as Record<string, string> | undefined;
  expect(env?.PULSE_PROBER_SUPPRESS_HOST_LABEL, "per-host prober missing host-label suppression").toBeDefined();
  // The rendered per-host prober config is bound READ-ONLY to the fixed loader path.
  const binds = (svc?.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  const cfgMount = binds.find((b) => b.includes("/rendered/prober/config.yaml"));
  expect(cfgMount, "per-host prober has no rendered-config bind").toBeDefined();
  const ro = /:ro\b/.test(cfgMount ?? "") || (cfgMount ?? "").includes('"read_only":true');
  expect(ro, "the per-host prober config mount is not read-only").toBe(true);
  for (const b of binds) {
    const readOnly = /:ro\b/.test(b) || b.includes('"read_only":true');
    expect(readOnly, `per-host prober has a writable mount: ${b}`).toBe(true);
  }
});

/* ===========================================================================================
 * §4 — Restart policies + read-only rendered-config mount (REQ-CFG-03)
 * ========================================================================================= */

test("every fragment service self-restarts", () => {
  const cfg = fragmentWithCadvisor();
  for (const [name, svc] of Object.entries(cfg.services)) {
    expect(svc.restart, `${name} declares no restart policy`).toBe("unless-stopped");
  }
});

test("host introspection mounts are read-only and only cAdvisor is privileged", () => {
  const cfg = fragmentWithCadvisor();
  for (const name of ["node-exporter", "cadvisor"] as const) {
    const service = cfg.services[name];
    expect(service, `${name} is not defined`).toBeDefined();
    for (const volume of service?.volumes ?? []) {
      const object = volumeObject(volume);
      const readOnly = object?.read_only === true || (typeof volume === "string" && /:ro(?:,|$)/.test(volume));
      expect(readOnly, `${name} has a writable host mount: ${JSON.stringify(volume)}`).toBe(true);
    }
  }
  expect(cfg.services.cadvisor?.privileged).toBe(true);
  expect(cfg.services["node-exporter"]?.privileged ?? false).toBe(false);
  expect(cfg.services.heartbeat?.privileged ?? false).toBe(false);
});

test("the rendered-config mount is READ-ONLY (REQ-CFG-03)", () => {
  // The single-config seam both delivery forms consume: rendered/agent/<host>.yaml, mounted :ro
  // (03 §6.2). `config --format json` renders each volume as {type,source,target,read_only,…}.
  const heartbeat = fragmentDefault().services.heartbeat;
  const binds = (heartbeat?.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  const rendered = binds.find((b) => b.includes("/rendered/agent/"));
  expect(rendered, "heartbeat has no rendered-config bind").toBeDefined();
  const readOnly = /:ro\b/.test(rendered ?? "") || (rendered ?? "").includes('"read_only":true');
  expect(readOnly, "the rendered-config mount is not read-only").toBe(true);
});

/* ===========================================================================================
 * §4 / §5 — systemd delivery form: all forms present, pinned (REQ-BUNDLE-02)
 *
 * systemd has no `compose config` equivalent, so the unit files are asserted by text scan —
 * exactly the four always/gated per-host units PLUS the opt-in per-host prober (issue #8), each
 * running its matching pinned image with Restart=on-failure. Only the per-host prober references
 * the prober image / PROBER_PORT (a host-local probe delivery); the others must not (03 §1/§8).
 * ========================================================================================= */

describe("systemd delivery form (REQ-BUNDLE-02)", () => {
  test("exactly the per-host units exist, including the opt-in per-host prober (issue #8)", () => {
    for (const unit of SYSTEMD_UNITS) {
      expect(existsSync(join(SYSTEMD_DIR, unit)), `missing systemd unit ${unit}`).toBe(true);
    }
    const shipped = readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith(".service"));
    expect(shipped.sort()).toEqual([...SYSTEMD_UNITS].sort());
    // The per-host prober IS shipped (issue #8) — an opt-in unit for host-local probes.
    expect(shipped.includes("pulse-prober.service"), "the per-host prober unit is missing").toBe(true);
  });

  test("each unit runs its matching pinned image with Restart=on-failure, no floating/placeholder tag", () => {
    const unitImage: Record<string, string> = {
      "pulse-node-exporter.service": PINNED.nodeExporter,
      "pulse-cadvisor.service": PINNED.cadvisor,
      "pulse-heartbeat.service": HEARTBEAT_IMAGE,
      "pulse-command-exporter.service": COMMAND_EXPORTER_IMAGE,
      "pulse-prober.service": PROBER_IMAGE,
    };
    for (const [unit, image] of Object.entries(unitImage)) {
      const text = unitText(unit);
      expect(text.includes(image), `${unit} does not reference pinned image ${image}`).toBe(true);
      assertPinnedImage(image, unit);
      expect(text.includes("Restart=on-failure"), `${unit} is not Restart=on-failure`).toBe(true);
      expect(FORBIDDEN_TAG.test(text), `${unit} contains a floating/placeholder tag`).toBe(false);
    }
  });

  test("all systemd host bind mounts are read-only and only cAdvisor is privileged", () => {
    for (const unit of SYSTEMD_UNITS) {
      const text = unitText(unit);
      for (const line of text.split("\\").filter((part) => part.includes("-v "))) {
        for (const match of line.matchAll(/-v\s+([^\s]+)/g)) {
          expect(match[1]?.includes(":ro"), `${unit} has a writable bind: ${match[1]}`).toBe(true);
        }
      }
      expect(text.includes("--privileged"), `${unit} privilege drift`).toBe(
        unit === "pulse-cadvisor.service",
      );
    }
  });

  test("only the per-host prober unit references the prober image or PROBER_PORT (issue #8, §8)", () => {
    // The always/gated units must NOT reference the prober image or its port.
    for (const unit of NON_PROBER_SYSTEMD_UNITS) {
      const text = unitText(unit);
      expect(text.includes(PROBER_IMAGE), `${unit} references the prober image`).toBe(false);
      expect(text.includes(String(PROBER_PORT)), `${unit} references PROBER_PORT`).toBe(false);
    }
    // The per-host prober unit runs the prober image under host networking with the host-label
    // suppression that lets scrape-time file_sd own the host label (issue #8).
    const prober = unitText("pulse-prober.service");
    expect(prober.includes(PROBER_IMAGE), "per-host prober unit missing the prober image").toBe(true);
    expect(prober.includes("--network host"), "per-host prober unit not on host networking").toBe(true);
    expect(
      prober.includes("PULSE_PROBER_SUPPRESS_HOST_LABEL"),
      "per-host prober unit missing host-label suppression",
    ).toBe(true);
  });
});

/* ===========================================================================================
 * §4 / §7 — the RESERVED central prober slot in stack-core (05 §5.2b)
 *
 * The deep-health prober is NOT a per-host member; it fills stack-core's reserved slot. This
 * suite structurally verifies that slot: profile-gated, in-network 9120 only (never host-
 * published), pinned, read-only config mount — and that VictoriaMetrics scrapes it statically.
 * ========================================================================================= */

describe("central deep-health prober slot (05 §5.2b)", () => {
  test("the prober is profile-gated, pinned, and exposes only 9120 in-network (never host-published)", () => {
    // Gated OFF by default (this parse also proves the stack tree parses daemon-free) ...
    const cfgDefault = parseCompose(STACK_COMPOSE_FILE, STACK_ENV);
    expect(cfgDefault.services.prober, "prober must be gated OFF under the default profile").toBeUndefined();

    // ... materialized under the deep-health profile.
    const prober = stackWithProber().services.prober;
    expect(prober, "prober body is not materialized under its profile").toBeDefined();
    expect(prober?.profiles ?? [], "prober does not declare deep-health").toContain(DEEP_HEALTH_PROFILE);
    expect(prober?.image, "prober image drifted from the pinned tag").toBe(PROBER_IMAGE);
    if (prober?.image) assertPinnedImage(prober.image, "prober");

    // In-network only: `expose: 9120`, and NO host-published `ports:` binding (REQ-SEC-02).
    expect((prober?.expose ?? []).map(String)).toContain(String(PROBER_PORT));
    expect(publishesPort(prober as ComposeService, PROBER_PORT), "prober publishes 9120 to the host").toBe(false);
    expect(prober?.ports ?? [], "prober declares a host-published ports mapping").toEqual([]);

    // Read-only rendered prober-config mount + a healthcheck the runner keys off.
    const binds = (prober?.volumes ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    const cfgMount = binds.find((b) => b.includes('"target":"/rendered/prober"'));
    expect(cfgMount, "prober has no rendered-config bind").toBeDefined();
    const ro = /:ro\b/.test(cfgMount ?? "") || (cfgMount ?? "").includes('"read_only":true');
    expect(ro, "the prober rendered-config mount is not read-only").toBe(true);
    expect(prober?.healthcheck, "prober declares no healthcheck").toBeDefined();
  });

  test("VictoriaMetrics has exactly one static prober:9120 scrape job", () => {
    const scrape = readFileSync(STACK_SCRAPE_FILE, "utf8");
    expect(scrape.includes("job_name: prober"), "no prober scrape job").toBe(true);
    const target = `prober:${PROBER_PORT}`; // "prober:9120"
    const occurrences = scrape.split(target).length - 1;
    expect(occurrences, `expected exactly one ${target} target, found ${occurrences}`).toBe(1);
  });
});

/* ===========================================================================================
 * Sanity — the port/version constants the assertions above are anchored on (00 §3)
 * ========================================================================================= */

test("bundle port + contract constants are the contracted values (00 §3)", () => {
  expect(NODE_EXPORTER_PORT).toBe(9100);
  expect(HEARTBEAT_PORT).toBe(9110);
  expect(CADVISOR_PORT).toBe(8080);
  expect(PROBER_PORT).toBe(9120);
  expect(CONTRACT_VERSION).toBe(2);
  expect(resolve(SYSTEMD_DIR)).toBe(SYSTEMD_DIR); // path constant is absolute
});
