// apps/web/tests/barrel-imports.test.ts — the build's barrel-import rewrite (build-client.ts
// "Barrel imports"): feature code's `@/ui` imports and every `lucide-react` import are pointed at the
// modules that own each name, so Bun.build's chunking sees only what each module really imports.
// The chunking outcome itself is pinned by build-budget.test.ts (per-view first load, icon chunk).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { barrelOwners, rewriteBarrelImports, type BarrelOwner } from "../scripts/build-client.js";

const UI_ROOT = resolve(import.meta.dir, "../src/client/ui");
const owners = barrelOwners(resolve(UI_ROOT, "index.ts"), (rel) => `@/ui/${rel.replace(/^\.\//, "")}`);
const rewrite = (source: string, map: ReadonlyMap<string, BarrelOwner> = owners): string =>
  rewriteBarrelImports(source, "@/ui", map, "demo.tsx");

describe("barrelOwners", () => {
  test("maps named and star re-exports of the @/ui barrel to their modules", () => {
    expect(owners.get("Icon")).toEqual({ module: "@/ui/patterns/icon", imported: "Icon" });
    expect(owners.get("Button")).toEqual({ module: "@/ui/primitives/button", imported: "Button" }); // export *
    expect(owners.get("ICONS")).toEqual({ module: "@/ui/lib/icons", imported: "ICONS" });
  });

  test("skips type-only exports", () => {
    expect(owners.has("IconName")).toBe(false);
    expect(owners.has("ColumnDef")).toBe(false);
  });

  test("covers every value feature code imports from the barrel (the build would fail otherwise)", () => {
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(resolve(UI_ROOT, ".."))]
      .map((rel) => resolve(UI_ROOT, "..", rel))
      .filter((file) => !file.startsWith(UI_ROOT));
    let imports = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes('"@/ui"')) continue;
      imports += 1;
      expect(() => rewriteBarrelImports(text, "@/ui", owners, file)).not.toThrow();
    }
    expect(imports).toBeGreaterThan(50);
  });

  test("maps lucide-react's icon re-exports to the icon modules", () => {
    const pkg = resolve(import.meta.dir, "../node_modules/lucide-react");
    const lucide = barrelOwners(resolve(pkg, "dist/esm/lucide-react.mjs"), (_rel, file) => file);
    for (const name of ["X", "XIcon", "LucideX"]) {
      expect(lucide.get(name)?.imported).toBe("default");
      expect(lucide.get(name)?.module).toMatch(/lucide-react\/dist\/esm\/icons\/x\.mjs$/);
    }
  });
});

describe("rewriteBarrelImports", () => {
  test("splits one barrel import into one import per owning module", () => {
    expect(rewrite('import { Button, Icon, cn } from "@/ui";')).toBe(
      'import { Button } from "@/ui/primitives/button"; import { Icon } from "@/ui/patterns/icon"; import { cn } from "@/ui/lib/utils";',
    );
  });

  test("keeps local aliases and maps re-export aliases to the owner's name", () => {
    const map = new Map([["Shown", { module: "./m", imported: "Real" }]]);
    expect(rewrite('import { Shown as Local } from "@/ui";', map)).toBe('import { Real as Local } from "./m";');
    expect(rewrite('import { Shown } from "@/ui";', map)).toBe('import { Real as Shown } from "./m";');
  });

  test("drops type specifiers and type-only imports, keeping the line count", () => {
    const source = 'import {\n  Icon,\n  type IconName,\n} from "@/ui";\nimport type { Tone } from "@/ui";\nconst x = 1;';
    const out = rewrite(source);
    expect(out.split("\n")).toHaveLength(source.split("\n").length);
    expect(out).toBe('import { Icon } from "@/ui/patterns/icon";\n\n\n\n\nconst x = 1;');
  });

  test("leaves other modules' imports alone", () => {
    const source = 'import { Button } from "@/ui/primitives/button";\nimport { x } from "./ui";';
    expect(rewrite(source)).toBe(source);
  });

  test("fails on a value the barrel does not export", () => {
    expect(() => rewrite('import { NoSuchThing } from "@/ui";')).toThrow(/"NoSuchThing" is not a value export of "@\/ui"/);
  });

  test("fails on a barrel reference it cannot rewrite, so nothing falls back to the barrel", () => {
    for (const source of [
      'import * as ui from "@/ui";',
      'export { Button } from "@/ui";',
      'import "@/ui";',
      'const ui = await import("@/ui");',
    ]) {
      expect(() => rewrite(source), source).toThrow(/only named imports/);
    }
    expect(rewrite('// was: import { Button } from "@/ui"\nconst x = 1;')).toContain("const x = 1;");
  });
});
