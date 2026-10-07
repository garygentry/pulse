// apps/web/tests/ui-workbench-registration.test.ts — the dev-only `/_ui` workbench is registered
// outside production builds only, stays out of nav/kiosk/palette, and covers the `@/ui` barrel.
// Production-bundle absence (no chunk, no marker) is asserted on a real build in build-budget.test.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { matchRoute, routesFromViews } from "../src/client/router.js";
import { parseRotate } from "../src/client/shell/kiosk.js";
import { uiWorkbenchView } from "../src/client/views/_ui/index.js";
import { devViews } from "../src/client/views/dev-views.js";
import { VIEWS } from "../src/client/views/registry.js";

const CLIENT = resolve(import.meta.dir, "../src/client");
const UI = join(CLIENT, "ui");
const WORKBENCH = join(CLIENT, "views/_ui");

describe("ui workbench registration", () => {
  test("registers /_ui off the nav in development", () => {
    const views = devViews("development");
    expect(views.map((v) => v.id)).toEqual(["_ui"]);
    expect(views[0]).toBe(uiWorkbenchView);
    expect(uiWorkbenchView.nav).toBeUndefined();
    const match = matchRoute(routesFromViews([...VIEWS, ...views]), "/_ui");
    expect(match?.view).toBe("_ui");
  });

  test("registers nothing in a production build", () => {
    expect(devViews("production")).toEqual([]);
    expect(matchRoute(routesFromViews([...VIEWS, ...devViews("production")]), "/_ui")).toBeNull();
  });

  test("an unset NODE_ENV counts as development (the bundler always defines it)", () => {
    expect(devViews(undefined).map((v) => v.id)).toEqual(["_ui"]);
  });

  test("the nav registry, and so the side nav, command palette and kiosk rotation, never list it", () => {
    expect(VIEWS.some((v) => v.id === "_ui")).toBe(false);
    expect(parseRotate("_ui:30,overview:30", VIEWS.map((v) => v.id)).map((s) => s.viewId)).toEqual([
      "overview",
    ]);
  });

  test("load() resolves the workbench component outside production", async () => {
    const component = await uiWorkbenchView.load();
    expect(typeof component).toBe("function");
  });

  test("main.tsx gates registration on the literal NODE_ENV the build inlines", () => {
    const main = readFileSync(join(CLIENT, "main.tsx"), "utf8");
    expect(main).toMatch(/process\.env\.NODE_ENV !== "production"\s*\?\s*devViews\(/);
    expect(main).toContain("routesFromViews([...VIEWS, ...DEV_VIEWS])");
    // The chunk's dynamic import is gated too: the bundler emits a chunk for every parsed import().
    const index = readFileSync(join(WORKBENCH, "index.ts"), "utf8");
    expect(index).toMatch(/process\.env\.NODE_ENV !== "production"\s*\?\s*import\("\.\/view\.js"\)/);
  });

  test("the production stylesheet excludes the workbench from Tailwind source detection", () => {
    const css = readFileSync(join(CLIENT, "styles/app.css"), "utf8");
    expect(css).toContain('@source not "../views/_ui";');
  });
});

// ─── Coverage: every component the barrel exports appears on the workbench ───────────────────────

/** Runtime (non-type) names a module's `export { … }` / `export function|const` statements declare. */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of (block[1] ?? "").split(",")) {
      const part = raw.trim();
      if (part === "" || part.startsWith("type ")) continue;
      const alias = part.split(/\s+as\s+/).pop() ?? part;
      names.push(alias.trim());
    }
  }
  for (const decl of source.matchAll(/export\s+(?:function|const)\s+([A-Za-z0-9_]+)/g)) {
    if (decl[1] !== undefined) names.push(decl[1]);
  }
  return names;
}

function resolveModule(dir: string, spec: string): string {
  const base = join(dir, spec);
  const found = [`${base}.tsx`, `${base}.ts`, join(base, "index.ts")].find((f) => existsSync(f));
  if (found === undefined) throw new Error(`cannot resolve ${spec} from ${dir}`);
  return found;
}

/** Every runtime name the `@/ui` barrel exports, following `export *` one level per hop. */
function barrelExports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const dir = resolve(file, "..");
  const names = exportedNames(source);
  for (const star of source.matchAll(/export \* from "([^"]+)"/g)) {
    if (star[1] !== undefined) names.push(...barrelExports(resolveModule(dir, star[1])));
  }
  return names;
}

/** Barrel components deliberately not on the page, each with its reason. */
const NOT_ON_WORKBENCH: Record<string, string> = {
  AlertDialogOverlay: "rendered by AlertDialogContent",
  AlertDialogPortal: "rendered by AlertDialogContent",
  DialogOverlay: "rendered by DialogContent",
  DialogPortal: "rendered by DialogContent",
  DropdownMenuPortal: "rendered by DropdownMenuContent",
  PopoverAnchor: "positioning helper with no visual of its own",
  SelectScrollDownButton: "rendered by SelectContent",
  SelectScrollUpButton: "rendered by SelectContent",
  SidebarInset: "app-shell layout part; the shell is its specimen",
  SidebarRail: "app-shell layout part; the shell is its specimen",
  SidebarTrigger: "toggles the app-shell sidebar; the shell is its specimen",
  SidebarMenuSkeleton: "random width per mount, which would break visual baselines",
};

function workbenchSource(): string {
  const files = [join(WORKBENCH, "view.tsx"), join(WORKBENCH, "kit.tsx")];
  for (const name of readdirSync(join(WORKBENCH, "sections"))) files.push(join(WORKBENCH, "sections", name));
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("ui workbench coverage", () => {
  const exported = [...new Set(barrelExports(join(UI, "index.ts")))];
  // Components are PascalCase; the domain status maps are the SCREAMING_CASE values to show.
  const components = exported.filter((n) => /^[A-Z][a-z]/.test(n));
  const statusMaps = exported.filter((n) => /_(STATUS|SEVERITY|STATE)$/.test(n));

  test("the barrel scan finds the library (not vacuous)", () => {
    expect(components).toContain("Button");
    expect(components).toContain("CommandPalette");
    expect(components).toContain("TimeSeriesChart");
    expect(components).toContain("RadioGroup");
    expect(statusMaps).toEqual(
      expect.arrayContaining(["TARGET_STATUS", "ALERT_SEVERITY", "MUTATION_STATE", "FRESHNESS_STATUS"]),
    );
  });

  test("every exported component and status map appears on the workbench", () => {
    const source = workbenchSource();
    const missing = [...components, ...statusMaps].filter(
      (name) => NOT_ON_WORKBENCH[name] === undefined && !new RegExp(`\\b${name}\\b`).test(source),
    );
    expect(missing).toEqual([]);
  });

  test("the not-on-workbench list has no stale entries", () => {
    const source = workbenchSource();
    const stale = Object.keys(NOT_ON_WORKBENCH).filter(
      (name) => !components.includes(name) || new RegExp(`\\b${name}\\b`).test(source),
    );
    expect(stale).toEqual([]);
  });
});
