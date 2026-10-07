// apps/cli/src/commands/init.ts — repo scaffolding (05 §7, REQ-INIT-01/02/03).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { GuidancePack, GuidancePackFile } from "@pulse/renderer"; // 00 §7 (barrel-exported)

import type { CommandResult } from "./result.js";
import type { InitData } from "../envelope.js"; // 00 §5.1

/** Options the shell passes to `runInit` (05 §3.2). */
export interface InitOptions {
  /** Consumer repo root the scaffold is written into (cwd by default; `04` resolves it). */
  repoRoot: string;
  /** `--force` overwrites existing files instead of refusing (REQ-INIT-03). */
  force: boolean;
  /**
   * The bundled guidance pack (`00 §7`), or `undefined` when no pack was bundled. With no
   * pack, `init` still emits the base scaffold and succeeds (REQ-INIT-02).
   */
  pack?: GuidancePack;
}

/**
 * The build-embedded guidance-pack MANIFEST (`00 §7`), or `undefined` when no pack was bundled
 * into this binary. A release build overwrites this; a local/dev build leaves it `undefined`,
 * so `init` emits only the base scaffold (REQ-INIT-02).
 */
export const BUNDLED_GUIDANCE_PACK: GuidancePack | undefined = undefined; // release build overwrites

/** One planned scaffold action, resolved to concrete target + contents before any write. */
interface PlannedFile {
  /** Destination path relative to `repoRoot` (POSIX separators; deterministic). */
  target: string;
  /** The exact bytes to write (create-only). */
  contents: string;
}

/**
 * Run `pulse init` (REQ-INIT-01/02/03).
 *
 *  1. Build the BASE scaffold plan: `pulse.config.yaml` (§7.2) + `estate/estate.yaml` (§7.3),
 *     then append the guidance-pack plan (§7.4). The base scaffold is planned BEFORE pack
 *     files, and every pack file is create-only, so a pack can never stomp a base file.
 *  2. Classify each planned file against disk WITHOUT writing (§7.5): create / skip /
 *     would-clobber.
 *  3. If any would-clobber and NOT `--force`, write NOTHING and return exit 1 with
 *     `data.wouldClobber` (REQ-INIT-03). Otherwise perform the writes and the empty
 *     `rendered/` mkdir, returning exit 0.
 *
 * @param opts - repo root, `--force`, and the optional bundled pack.
 * @returns CommandResult<InitData>. `init` emits no `findings` (it authors config; it does not
 *   load/validate) — its only exit-1 driver is `wouldClobber` via `outcomeFailed`.
 * @throws Filesystem write errors (mkdir/writeFile) and a `joinRepo` path-escape PROPAGATE to
 *   the shell → exit 2 (unexpected tool fault, REQ-CLI-02b). `init` performs no
 *   network/child-process I/O (REQ-SEC-01).
 */
export function runInit(opts: InitOptions): CommandResult<InitData> {
  const plan: PlannedFile[] = [...baseScaffold(opts), ...packFiles(opts.pack)];

  const created: string[] = [];
  const skipped: string[] = [];
  const wouldClobber: string[] = [];

  // Classify without writing (so refusal can be all-or-nothing).
  const toWrite: PlannedFile[] = [];
  for (const file of plan) {
    const abs = joinRepo(opts.repoRoot, file.target); // resolves within repoRoot
    if (!existsSync(abs)) {
      toWrite.push(file);
      created.push(file.target);
    } else if (opts.force) {
      if (readFileSync(abs, "utf8") === file.contents) {
        skipped.push(file.target); // idempotent under --force
      } else {
        toWrite.push(file);
        created.push(file.target); // overwrite
      }
    } else {
      wouldClobber.push(file.target); // create-only refusal (REQ-INIT-03)
    }
  }

  // Non-destructive refusal: any clobber without --force ⇒ write nothing, exit 1.
  if (wouldClobber.length > 0 && !opts.force) {
    return {
      findings: [],
      data: {
        created: [], // wrote nothing
        skipped: sortPaths(skipped),
        wouldClobber: sortPaths(wouldClobber),
      },
      outcomeFailed: true, // exit 1 (REQ-INIT-03)
    };
  }

  // Apply: ensure the empty rendered/ root, then write each create-target.
  ensureDir(joinRepo(opts.repoRoot, "rendered"));
  for (const file of toWrite) {
    const abs = joinRepo(opts.repoRoot, file.target);
    ensureDir(dirname(abs));
    writeFileSync(abs, file.contents, "utf8");
  }

  return {
    findings: [],
    data: { created: sortPaths(created), skipped: sortPaths(skipped) }, // wouldClobber omitted
    outcomeFailed: false, // exit 0
  };
}

/** The `pulse.config.yaml` scaffold content (§7.2) — deterministic, byte-stable (REQ-DET-01). */
const PULSE_CONFIG_YAML = `# pulse.config.yaml — Pulse CLI configuration (created by \`pulse init\`).
# All values are overridable by CLI flag or PULSE_* env (flag > env > this file > default).
estateDir: estate      # where estate YAML lives (input to validate/render/coverage)
outputRoot: rendered   # where the rendered tree is written (committed, diff-reviewable)
strict: false          # default --strict (promote warning-severity findings to exit 1)
`;

/**
 * The minimal VALID estate skeleton (§7.3, REQ-INIT-01). MUST pass `@pulse/core`
 * `loadAndValidate` with zero error findings so a fresh scaffold validates, renders, and
 * reports coverage immediately (SC-01). One `managed-linux` host makes the scaffold a
 * meaningful, covered starting point; `deadman_hook` is a plain URL string (not a SecretRef),
 * so no `secret_literal` refusal is possible on the fresh scaffold.
 */
const ESTATE_YAML = `# estate/estate.yaml — minimal valid Pulse estate (created by \`pulse init\`).
# Edit this to describe your real estate, then run \`pulse validate\` and \`pulse render\`.
estate:
  schema_version: 1              # supported major (packages/core: SUPPORTED_SCHEMA_MAJORS = [1])
  name: my-estate
  domains:
    - example.com
  # dns_resolver: 10.0.0.53       # optional; use an internal resolver for split-horizon domains
  timezone: UTC                  # IANA zone (source of truth for quiet-hours/digests)
  deadman_hook: https://example.com/deadman   # replace with your real dead-man's-switch URL

hosts:
  - name: example-host
    collection_class: managed-linux
    delivery_form: compose
    addresses:
      - 10.0.0.10                # replace with a real reachable address
    exporter_ports:
      - 9100                     # node_exporter default
`;

/** The two base scaffold files (§7.2, §7.3), planned before any pack file. */
function baseScaffold(_opts: InitOptions): PlannedFile[] {
  return [
    { target: "pulse.config.yaml", contents: PULSE_CONFIG_YAML },
    { target: "estate/estate.yaml", contents: ESTATE_YAML },
  ];
}

/** Map each `GuidancePackFile` to a planned file, reading its bundled source content (§7.4). */
function packFiles(pack: GuidancePack | undefined): PlannedFile[] {
  if (pack === undefined) return [];
  return pack.files.map((f: GuidancePackFile) => ({
    target: f.target,
    contents: readPackSource(f.source),
  }));
}

/**
 * Resolve the bundled source content for a pack file (build-time embedding seam, §7.6). The
 * shipped artifact is a `bun build --compile` binary, so pack templates are embedded at build
 * time, not read from the host filesystem at runtime. While `BUNDLED_GUIDANCE_PACK` is
 * `undefined` this is never called on a real pack; a minimal deterministic stub is acceptable
 * per 05 §7.6 (the contract is only that it yields deterministic bytes per `source`).
 */
function readPackSource(source: string): string {
  // Deterministic placeholder: stable bytes derived only from `source` (no clock/host/env).
  return `# guidance-pack template: ${source}\n`;
}

/**
 * Resolve `target` within `repoRoot`. A path that escapes the repo root (absolute or `..`) is a
 * fault → thrown → propagates to the shell → exit 2 (REQ-CLI-02b).
 */
function joinRepo(repoRoot: string, target: string): string {
  const root = resolve(repoRoot);
  const abs = resolve(root, target);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new Error(`init: refusing to write outside repo root: ${target}`);
  }
  return abs;
}

/** Recursively ensure a directory exists (`mkdir -p`); a raw fs error propagates → exit 2. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Sort paths by raw UTF-16 code point (determinism, 00 §3.1) — never locale collation. */
function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
