// apps/web/tests/deps.test.ts — pinned client + tooling dependencies (item 003 / REQ-DEPS-01/02).
//
// Every row in PINNED_DEPS must appear at its exact version in the declaring manifest AND at the
// resolved node_modules/<name>/package.json, with the exact expected licence string.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** One pinned dependency: where it is declared, the exact version, and the licence string. */
export interface PinnedDep {
  name: string;
  manifest: "apps/web/package.json" | "package.json";
  field: "dependencies" | "devDependencies";
  version: string;
  license: string;
}

/** The full pin table (00 §11). Any change here is a recorded charter decision. */
export const PINNED_DEPS: readonly PinnedDep[] = [
  { name: "react",                 manifest: "apps/web/package.json", field: "dependencies",    version: "19.3.0",  license: "MIT" },
  { name: "react-dom",             manifest: "apps/web/package.json", field: "dependencies",    version: "19.3.0",  license: "MIT" },
  { name: "@preact/signals-core",  manifest: "apps/web/package.json", field: "dependencies",    version: "1.14.4",  license: "MIT" },
  { name: "@preact/signals-react", manifest: "apps/web/package.json", field: "dependencies",    version: "3.12.0",  license: "MIT" },
  { name: "uplot",                 manifest: "apps/web/package.json", field: "dependencies",    version: "1.6.32",  license: "MIT" },
  { name: "lucide-react",          manifest: "apps/web/package.json", field: "dependencies",    version: "1.49.0",  license: "ISC" },
  { name: "@testing-library/react",      manifest: "apps/web/package.json", field: "devDependencies", version: "16.3.3", license: "MIT" },
  { name: "@testing-library/user-event", manifest: "apps/web/package.json", field: "devDependencies", version: "14.6.7", license: "MIT" },
  { name: "@testing-library/jest-dom",   manifest: "apps/web/package.json", field: "devDependencies", version: "6.10.0", license: "MIT" },
  { name: "@testing-library/dom",        manifest: "apps/web/package.json", field: "devDependencies", version: "10.4.2", license: "MIT" },
  { name: "tailwindcss",              manifest: "apps/web/package.json", field: "dependencies",    version: "4.3.3",  license: "MIT" },
  { name: "bun-plugin-tailwind",      manifest: "apps/web/package.json", field: "dependencies",    version: "0.1.2",  license: "MIT" },
  { name: "@tailwindcss/typography",  manifest: "apps/web/package.json", field: "dependencies",    version: "0.5.20", license: "MIT" },
  { name: "tw-animate-css",           manifest: "apps/web/package.json", field: "dependencies",    version: "1.4.0",  license: "MIT" },
  { name: "@fontsource-variable/geist",      manifest: "apps/web/package.json", field: "dependencies", version: "5.3.0", license: "OFL-1.1" },
  { name: "@fontsource-variable/geist-mono", manifest: "apps/web/package.json", field: "dependencies", version: "5.3.0", license: "OFL-1.1" },
  { name: "class-variance-authority", manifest: "apps/web/package.json", field: "dependencies",    version: "0.7.1",  license: "Apache-2.0" },
  { name: "clsx",                     manifest: "apps/web/package.json", field: "dependencies",    version: "2.1.1",  license: "MIT" },
  { name: "tailwind-merge",           manifest: "apps/web/package.json", field: "dependencies",    version: "3.7.0",  license: "MIT" },
  // Radix through its scoped packages (not the `radix-ui` umbrella), at the versions radix-ui 1.6.7 resolves.
  { name: "@radix-ui/react-alert-dialog",     manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.23", license: "MIT" },
  { name: "@radix-ui/react-checkbox",         manifest: "apps/web/package.json", field: "dependencies",    version: "1.3.11", license: "MIT" },
  { name: "@radix-ui/react-collapsible",      manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.20", license: "MIT" },
  { name: "@radix-ui/react-dialog",           manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.23", license: "MIT" },
  { name: "@radix-ui/react-dropdown-menu",    manifest: "apps/web/package.json", field: "dependencies",    version: "2.1.24", license: "MIT" },
  { name: "@radix-ui/react-label",            manifest: "apps/web/package.json", field: "dependencies",    version: "2.1.15", license: "MIT" },
  { name: "@radix-ui/react-popover",          manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.23", license: "MIT" },
  { name: "@radix-ui/react-radio-group",      manifest: "apps/web/package.json", field: "dependencies",    version: "1.4.7",  license: "MIT" },
  { name: "@radix-ui/react-scroll-area",      manifest: "apps/web/package.json", field: "dependencies",    version: "1.2.18", license: "MIT" },
  { name: "@radix-ui/react-select",           manifest: "apps/web/package.json", field: "dependencies",    version: "2.3.7",  license: "MIT" },
  { name: "@radix-ui/react-separator",        manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.15", license: "MIT" },
  { name: "@radix-ui/react-slot",             manifest: "apps/web/package.json", field: "dependencies",    version: "1.3.3",  license: "MIT" },
  { name: "@radix-ui/react-tabs",             manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.21", license: "MIT" },
  { name: "@radix-ui/react-toggle",           manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.18", license: "MIT" },
  { name: "@radix-ui/react-toggle-group",     manifest: "apps/web/package.json", field: "dependencies",    version: "1.1.19", license: "MIT" },
  { name: "@radix-ui/react-tooltip",          manifest: "apps/web/package.json", field: "dependencies",    version: "1.2.16", license: "MIT" },
  // The CSP style nonce hook react-remove-scroll's scroll-lock <style> reads (main.tsx; issue #2).
  { name: "get-nonce",                manifest: "apps/web/package.json", field: "dependencies",    version: "1.0.1",  license: "MIT" },
  { name: "@tanstack/react-virtual",  manifest: "apps/web/package.json", field: "dependencies",    version: "3.14.13", license: "MIT" },
  { name: "culori",                   manifest: "apps/web/package.json", field: "devDependencies", version: "4.0.2",  license: "MIT" },
  { name: "@types/culori",            manifest: "apps/web/package.json", field: "devDependencies", version: "4.0.1",  license: "MIT" },
  { name: "playwright-core", manifest: "package.json",          field: "devDependencies", version: "1.62.1",  license: "Apache-2.0" },
  // The visual-regression runner (apps/web/tests/visual, GitHub #4). It drives its own `playwright`
  // copy of playwright-core, so it must stay on the same release as the pin above.
  { name: "@playwright/test", manifest: "package.json",         field: "devDependencies", version: "1.62.1",  license: "Apache-2.0" },
];

const REPO_ROOT = resolve(import.meta.dir, "../../..");

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  license?: string;
  version?: string;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

/** Resolve `node_modules/<name>/package.json`. Bun hoists workspace deps either into the
 *  declaring package's `node_modules` OR the repo root — try the declarer first, then root. */
function resolveInstalled(dep: PinnedDep): string | null {
  const candidates = [
    resolve(REPO_ROOT, dep.manifest, "..", "node_modules", dep.name, "package.json"),
    resolve(REPO_ROOT, "node_modules", dep.name, "package.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

describe("PINNED_DEPS — exact versions and licences (REQ-DEPS-01/02)", () => {
  for (const dep of PINNED_DEPS) {
    test(`${dep.name} is pinned exactly in ${dep.manifest}`, () => {
      const manifest = readJson(resolve(REPO_ROOT, dep.manifest));
      const declared = manifest[dep.field]?.[dep.name];
      expect(declared, `${dep.name} missing from ${dep.manifest} ${dep.field}`).toBeDefined();
      // Exact pin — no ^, ~, >=, <=, or space-separated ranges.
      expect(declared, `${dep.name} in ${dep.manifest} must equal "${dep.version}"`).toBe(dep.version);
      expect(declared, `${dep.name} may not carry a range prefix`).not.toMatch(/^[\^~<>=]/);
    });

    test(`${dep.name} is installed at the pinned version`, () => {
      const installedPath = resolveInstalled(dep);
      expect(installedPath, `resolved node_modules/${dep.name}/package.json for ${dep.manifest}`).not.toBeNull();
      const installed = readJson(installedPath!);
      expect(installed.version, `installed ${dep.name} version`).toBe(dep.version);
    });

    test(`${dep.name} carries the expected licence (${dep.license})`, () => {
      const installedPath = resolveInstalled(dep);
      expect(installedPath).not.toBeNull();
      const installed = readJson(installedPath!);
      expect(installed.license, `installed ${dep.name} license`).toBe(dep.license);
    });
  }

  test("@playwright/test and playwright-core are pinned to the same release", () => {
    const pin = (name: string) => PINNED_DEPS.find((d) => d.name === name)?.version;
    expect(pin("@playwright/test")).toBe(pin("playwright-core"));
  });

  test("every PINNED_DEPS row resolves (no silent miss)", () => {
    for (const dep of PINNED_DEPS) {
      expect(resolveInstalled(dep), `${dep.name} must be installed`).not.toBeNull();
    }
  });
});
