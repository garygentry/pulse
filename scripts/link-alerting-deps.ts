// scripts/link-alerting-deps.ts
// stack/alerting is a config-artifact tree with a thin TS transform — intentionally NOT a root
// workspaces member (see stack/alerting/package.json). Because bun install only symlinks workspace
// members, the package's declared @pulse/* dependencies get no node_modules/@pulse entry, so
// `@pulse/core` would not resolve for either `tsc -b` or `bun test` from under stack/alerting.
//
// This postinstall step creates those symlinks (stack/alerting/node_modules/@pulse/<name> ->
// packages/<name>) so name resolution matches every workspace member's. It is idempotent and never
// fails the install: a symlink problem is logged, not thrown.

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const linkRoot = join(repoRoot, "stack/alerting/node_modules/@pulse");

// @pulse/<name> → packages/<name>. Mirrors stack/alerting/package.json dependencies.
const deps = ["core", "renderer"] as const;

try {
  mkdirSync(linkRoot, { recursive: true });
  for (const name of deps) {
    const linkPath = join(linkRoot, name);
    const target = join(repoRoot, "packages", name);
    if (existsSync(target)) {
      // Recreate so a stale/wrong link self-heals; symlinkSync fails if the path exists.
      if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
        rmSync(linkPath, { recursive: true, force: true });
      }
      symlinkSync(relative(linkRoot, target), linkPath, "dir");
    }
  }
} catch (err) {
  console.warn(`[link-alerting-deps] could not link @pulse/* into stack/alerting: ${String(err)}`);
}
