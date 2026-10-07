#!/usr/bin/env bun
/**
 * Reap leaked Docker smoke resources before the Docker smoke tier runs.
 *
 * Docker smoke suites bring up a compose stack under a per-lifecycle project named
 * `pulse-test-<scope>-<pid>-<uuid>` (see stack/tests/harness.ts) and tear it down in an
 * `afterAll` hook. When a test process is killed before that hook runs — an interrupted
 * loop iteration, a Ctrl-C, an OOM — the containers, networks, and volumes leak and squat
 * ports/resources, which makes the NEXT run's Docker-readiness probes flap.
 *
 * This reaper force-removes every `pulse-test-*` resource. It is intentionally scoped to that
 * prefix ONLY (mirroring the harness's `smokeComposeArgs` safety check) so it can never touch
 * the production `pulse` project or anything else on the host.
 *
 * Wired as `smoke:reap` and run at the head of `bun run smoke`. A no-op (and silent success)
 * when Docker is unreachable, so it never breaks a Docker-less `bun run smoke`.
 */

const PREFIX = "pulse-test-";

function docker(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["docker", ...args]);
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout).trim() };
}

function names(kind: "container" | "network" | "volume"): string[] {
  // List by name and filter by prefix ourselves, so a remove can only ever target `pulse-test-*`.
  const fmt =
    kind === "container"
      ? ["ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}"]
      : [kind, "ls", "--filter", `name=${PREFIX}`, "--format", "{{.Name}}"];
  const { code, out } = docker(fmt);
  if (code !== 0 || !out) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(PREFIX));
}

function reap(kind: "container" | "network" | "volume", subcommand: string[]): number {
  const targets = names(kind);
  let removed = 0;
  for (const name of targets) {
    // Belt-and-suspenders: never issue a remove for anything outside the prefix.
    if (!name.startsWith(PREFIX)) continue;
    const { code } = docker([...subcommand, name]);
    if (code === 0) removed += 1;
  }
  return removed;
}

if (docker(["version"]).code !== 0) {
  // No daemon → nothing to reap. Silent success keeps Docker-less runs green.
  process.exit(0);
}

const containers = reap("container", ["rm", "-f"]);
const networks = reap("network", ["network", "rm"]);
const volumes = reap("volume", ["volume", "rm", "-f"]);

const total = containers + networks + volumes;
if (total > 0) {
  console.log(
    `[reap-smoke-docker] removed ${containers} container(s), ${networks} network(s), ${volumes} volume(s) matching ${PREFIX}*`,
  );
}
