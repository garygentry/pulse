// apps/cli/scripts/build-bin.ts — the compiled-binary build pipeline (01 §4, CON-03).
//
// Run via `bun run build:bin` (wired in apps/cli/package.json). It:
//   1. regenerates apps/cli/src/version.ts from a version arg/env (default: the "0.0.0-dev"
//      sentinel) — deterministically, `export const PULSE_VERSION = "<version>";` and nothing
//      clock/host/random (REQ-DET-01);
//   2. builds the two musl-static single binaries via `bun build --compile`:
//        pulse-linux-x64   (--target=bun-linux-x64-musl)
//        pulse-linux-arm64 (--target=bun-linux-arm64-musl)
//      into a gitignored dist/build location (never the repo tree). `--compile` bundles
//      @pulse/core + @pulse/renderer, so the supported schema majors travel with the binary;
//   3. emits SHA256SUMS over the produced binaries (the deploy-toolkit handoff contract);
//   4. restores version.ts to the "0.0.0-dev" sentinel, so the committed source stays clean.
//
// It also wires the generated @pulse/agent-kit guidance pack into the binary for the same
// compile (04 §5): before compiling, `wirePackIntoInit()` rewrites src/commands/init.ts so the
// BUNDLED_GUIDANCE_PACK / readPackSource seams serve the committed pack bytes; a `finally`
// restores the pack-less committed source. The pack module is imported by RELATIVE path, so no
// @pulse/agent-kit dependency edge is added to apps/cli/package.json (the committed graph stays
// acyclic — the reverse edge exists only transiently in the rewritten source during a release).
//
// It does NOT cut the private GitHub release — that publish is a human-gated release action
// (see scripts/README.md). This script stops at producing + checksumming the artifacts locally.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** The committed version sentinel a local (non-release) build carries. */
export const VERSION_SENTINEL = "0.0.0-dev";

/** The v1 build matrix: exactly the two Linux musl arch targets (macOS/Windows are out of scope). */
export const BUILD_TARGETS = [
  { target: "bun-linux-x64-musl", outfile: "pulse-linux-x64" },
  { target: "bun-linux-arm64-musl", outfile: "pulse-linux-arm64" },
] as const;

/** The checksum manifest attached to the private release alongside the two binaries. */
export const CHECKSUMS_FILENAME = "SHA256SUMS";

const SCRIPTS_DIR = import.meta.dir;
/** apps/cli/src/version.ts — the single source of the baked CLI version. */
const DEFAULT_VERSION_FILE = resolve(SCRIPTS_DIR, "../src/version.ts");
/** apps/cli/src/index.ts — the compile entry point. */
const DEFAULT_ENTRY = resolve(SCRIPTS_DIR, "../src/index.ts");
/** apps/cli/dist/build — build outputs land here (dist/ is gitignored repo-wide). */
const DEFAULT_OUT_DIR = resolve(SCRIPTS_DIR, "../dist/build");

/** apps/cli/src/commands/init.ts — the file whose two seams the release pack wire-in rewrites. */
export const INIT_FILE = resolve(SCRIPTS_DIR, "../src/commands/init.ts");

/**
 * RELATIVE import specifier for the committed generated pack module (04 §5.2) — deliberately NOT
 * a `@pulse/agent-kit` package specifier. From apps/cli/src/commands/ up to the repo root is
 * `../../../../` (commands → src → cli → apps → root), then into agent-kit/generated. Using a
 * relative path means NO `@pulse/agent-kit` entry is added to apps/cli/package.json, so the
 * committed dependency graph stays acyclic (only `agent-kit → @pulse/cli`). The reverse
 * `apps/cli → agent-kit` edge exists ONLY in the rewritten source, transiently, during a release
 * build — erased by the `finally` restore in {@link runBuild}.
 */
const PACK_MODULE = "../../../../agent-kit/generated/guidance-pack.generated.js";

/** The committed `BUNDLED_GUIDANCE_PACK` sentinel line (init.ts, 04 §5) the wire-in replaces. */
const PACK_SENTINEL = "export const BUNDLED_GUIDANCE_PACK: GuidancePack | undefined = undefined;";

/** The committed `readPackSource` stub body the wire-in replaces with real `PACK_BYTES` service. */
const PACK_STUB_RE = /return `# guidance-pack template: \$\{source\}\\n`;/;

/**
 * Rewrite src/commands/init.ts so `BUNDLED_GUIDANCE_PACK` = the generated `GUIDANCE_PACK` and
 * `readPackSource(source)` returns `PACK_BYTES[source]` (throwing if a source has no bytes).
 * `bun build --compile` then bundles the imported pack module's bytes into the artifact, so the
 * guidance pack ships version-locked inside the CLI binary (04 §5, REQ-DRIFT-04/REQ-GUIDE-01).
 *
 * Returns the ORIGINAL source so a `finally` can restore the pack-less committed form — mirrors
 * the {@link writeVersionFile} regenerate-then-restore discipline.
 *
 * @throws If EITHER seam's committed text no longer matches (the `.replace` changed nothing) —
 *   the release build fails loudly rather than shipping a pack-less binary (drift guard, §5.4).
 */
export function wirePackIntoInit(): string {
  const original = readFileSync(INIT_FILE, "utf8");

  const afterPack = original.replace(
    PACK_SENTINEL,
    `import { GUIDANCE_PACK, PACK_BYTES } from ${JSON.stringify(PACK_MODULE)};\n` +
      "export const BUNDLED_GUIDANCE_PACK: GuidancePack | undefined = GUIDANCE_PACK;",
  );
  if (afterPack === original) {
    throw new Error("build-bin: pack wire-in matched nothing in init.ts — seam text drifted");
  }

  const rewritten = afterPack.replace(
    PACK_STUB_RE,
    "{ const b = PACK_BYTES[source]; if (b === undefined) throw new Error(`no PACK_BYTES for ${source}`); return b; }",
  );
  if (rewritten === afterPack) {
    throw new Error("build-bin: pack wire-in matched nothing in init.ts — seam text drifted");
  }

  writeFileSync(INIT_FILE, rewritten, "utf8");
  return original;
}

/**
 * Render the exact bytes of `version.ts` for a given version. Pure and deterministic — the ONLY
 * variable is the version literal (emitted via `JSON.stringify`, so it is always a valid,
 * correctly-escaped string). No clock/host/pid/random content (REQ-DET-01); calling it twice
 * with the same version yields byte-identical output. This is the single source the committed
 * `version.ts` mirrors at the sentinel value — regeneration never hand-edits, only rewrites.
 */
export function renderVersionModule(version: string): string {
  return [
    "// apps/cli/src/version.ts — the CLI version string (00 §5, REQ-CLI-06).",
    "//",
    "// GENERATED by apps/cli/scripts/build-bin.ts — DO NOT hand-edit. A local (non-release) build",
    '// keeps the "0.0.0-dev" sentinel; the release build regenerates this file with the git tag',
    "// before `bun build --compile`. Deterministic: the version literal is the only variable, and",
    "// it is never read from package.json at runtime (a --compile binary cannot rely on it).",
    "",
    '/** The Pulse CLI version, baked at build time. `"0.0.0-dev"` for a local build. */',
    `export const PULSE_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n");
}

/** Write `version.ts` for the given version. Overwrites deterministically (see {@link renderVersionModule}). */
export function writeVersionFile(version: string, filePath: string = DEFAULT_VERSION_FILE): void {
  writeFileSync(filePath, renderVersionModule(version), "utf8");
}

/** The lowercase-hex SHA-256 of a file's bytes. */
export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Build the `sha256sum`-format checksum manifest over `filenames` (resolved within `dir`),
 * one `"<hex>  <name>\n"` line per file in the given order (two spaces, matching coreutils
 * `sha256sum`). Uses the bare basename so the manifest verifies against the co-located binaries.
 */
export function computeSha256Sums(dir: string, filenames: readonly string[]): string {
  return filenames.map((name) => `${sha256File(resolve(dir, name))}  ${basename(name)}\n`).join("");
}

/** Options for {@link runBuild}. All optional; the defaults drive a real local build. */
export interface BuildOptions {
  /** The version to bake (git tag at release). Defaults to arg/env resolution, then the sentinel. */
  version?: string;
  /** Where the artifacts + SHA256SUMS land. Defaults to apps/cli/dist/build. */
  outDir?: string;
  /** The compile entry point. Defaults to apps/cli/src/index.ts. */
  entry?: string;
  /** The version.ts to regenerate/restore. Defaults to apps/cli/src/version.ts. */
  versionFile?: string;
}

/** One arch target's build outcome. */
export interface TargetResult {
  target: string;
  outfile: string;
  ok: boolean;
  /** Present on failure — the compiler's stderr (arm64 cross-compile may be unavailable). */
  error?: string;
}

/** The outcome of a build run. */
export interface BuildResult {
  version: string;
  outDir: string;
  /** Per-target results in {@link BUILD_TARGETS} order. */
  targets: TargetResult[];
  /** Outfile names that built successfully (SHA256SUMS covers exactly these). */
  built: string[];
}

/**
 * Regenerate version.ts, compile each arch target, emit SHA256SUMS, then restore the sentinel.
 *
 * Resilient to a missing arch: each target is attempted independently and a failure is recorded
 * (not thrown), so an environment that can compile x64 but not cross-compile arm64 still produces
 * the x64 artifact + a SHA256SUMS over what built. The CLI entry ({@link main}) decides whether a
 * partial result is a release failure; a test can assert on the primary arch alone. The sentinel
 * restore runs in a `finally`, so the working tree is never left with an injected version.
 */
export async function runBuild(opts: BuildOptions = {}): Promise<BuildResult> {
  const version = opts.version ?? resolveVersionArg();
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const entry = opts.entry ?? DEFAULT_ENTRY;
  const versionFile = opts.versionFile ?? DEFAULT_VERSION_FILE;

  writeVersionFile(version, versionFile);
  // Rewrite init.ts to embed the pack, then `--compile` bundles its bytes into each artifact.
  // Wired INSIDE the try so a finally always restores init.ts + version.ts, even on seam drift.
  let originalInit: string | undefined;
  try {
    originalInit = wirePackIntoInit();
    mkdirSync(outDir, { recursive: true });

    const targets: TargetResult[] = BUILD_TARGETS.map(({ target, outfile }) => {
      const outPath = resolve(outDir, outfile);
      const proc = Bun.spawnSync(
        [process.execPath, "build", entry, "--compile", `--target=${target}`, "--outfile", outPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (proc.success) return { target, outfile, ok: true };
      return { target, outfile, ok: false, error: proc.stderr.toString().trim() };
    });

    const built = targets.filter((t) => t.ok).map((t) => t.outfile);
    if (built.length > 0) {
      writeFileSync(resolve(outDir, CHECKSUMS_FILENAME), computeSha256Sums(outDir, built), "utf8");
    }
    return { version, outDir, targets, built };
  } finally {
    // Always restore the committed sources — neither init.ts (a real pack) nor version.ts (an
    // injected value) may ever be left in the working tree (mirrors the version dance, §5.4).
    if (originalInit !== undefined) writeFileSync(INIT_FILE, originalInit, "utf8");
    writeVersionFile(VERSION_SENTINEL, versionFile);
  }
}

/** Resolve the version to bake: first CLI arg, else `PULSE_BUILD_VERSION`, else the sentinel. */
function resolveVersionArg(): string {
  const arg = process.argv[2];
  if (arg !== undefined && arg.length > 0) return arg;
  const env = process.env.PULSE_BUILD_VERSION;
  if (env !== undefined && env.length > 0) return env;
  return VERSION_SENTINEL;
}

/**
 * CLI entry: run the build, print a human summary to stderr, and exit non-zero if any target
 * failed or nothing built — a release requires BOTH arch binaries. (Artifacts + SHA256SUMS are
 * still written for whatever succeeded, so a partial local build is inspectable.)
 */
async function main(): Promise<void> {
  const result = await runBuild();
  const log = (s: string): void => void process.stderr.write(`${s}\n`);

  log(`pulse build:bin — version ${result.version}`);
  for (const t of result.targets) {
    if (t.ok) log(`  ✓ ${t.outfile} (${t.target})`);
    else log(`  ✗ ${t.outfile} (${t.target}) — ${t.error ?? "build failed"}`);
  }
  if (result.built.length > 0) {
    log(`  → ${CHECKSUMS_FILENAME} over: ${result.built.join(", ")}`);
    log(`  outputs: ${result.outDir}`);
  }

  const allBuilt = result.targets.every((t) => t.ok);
  if (!allBuilt) {
    log("build:bin: not all targets built — a release requires both arch binaries (see scripts/README.md).");
    process.exit(1);
  }
}

if (import.meta.main) void main();
