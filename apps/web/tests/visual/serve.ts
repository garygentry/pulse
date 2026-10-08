// apps/web/tests/visual/serve.ts — the visual suite's web server (Playwright `webServer`).
//
// `dev:web --mock <scenario> --clock <iso>` without the watchers, with a frozen server clock:
//   1. builds the workspace packages and a development client bundle (so `/_ui` is served) into a
//      private temp dir, exactly as `scripts/dev.ts` does for its first build;
//   2. spawns the same dev composition root (`src/server/dev/entry.ts`) with the env
//      `buildChildEnv` computes, plus `--preload freeze-clock.ts` and `PULSE_VISUAL_NOW`, so every
//      server timestamp (snapshot, source health, Gatus results) is the frozen instant;
//   3. forwards SIGTERM/SIGINT to the child and exits with it.
//
// It never watches files and never rebuilds; a run serves one bundle. Usage:
//   bun tests/visual/serve.ts --mock <scenario> --clock <iso> --port <n>   (with PULSE_VISUAL_NOW)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildClient } from "../../scripts/build-client.js";
import { buildChildEnv, buildDevPackages, parseDevArgs, resolveDevPaths } from "../../scripts/dev.js";

const HERE = import.meta.dir;
const FREEZE_CLOCK = resolve(HERE, "freeze-clock.ts");

const parsed = parseDevArgs(Bun.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(parsed.usage);
  process.exit(2);
}
if (process.env["PULSE_VISUAL_NOW"] === undefined) {
  console.error("PULSE_VISUAL_NOW must be set (the frozen server instant, ISO-8601)");
  process.exit(2);
}

const paths = resolveDevPaths(resolve(HERE, "../../scripts"));
const clientDir = mkdtempSync(join(tmpdir(), "pulse-visual-client-"));

const packages = await buildDevPackages(paths.repoRoot);
if (!packages.ok) {
  console.error("[visual] package build failed");
  process.exit(1);
}
const build = await buildClient({ outdir: clientDir, minify: false, sourcemap: "none", clean: true });
if (!build.ok) {
  for (const e of build.errors) console.error(e);
  console.error("[visual] client build failed");
  process.exit(1);
}

const env = buildChildEnv(parsed.options, build.manifest.buildId, { ...paths, clientDir });
const child = Bun.spawn(["bun", "--preload", FREEZE_CLOCK, "src/server/dev/entry.ts"], {
  cwd: paths.appRoot,
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

const stop = (): void => {
  child.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.exit(await child.exited);
