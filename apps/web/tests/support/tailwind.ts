// apps/web/tests/support/tailwind.ts — the installed Tailwind compiler over the client's real
// stylesheet entry, for suites that ask "does this class compile?" or "which custom properties does
// the sheet declare?" (tests/ui-tailwind-classes.test.ts, tests/ui-guardrails.test.ts).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { compile } from "tailwindcss";

const WEB = resolve(import.meta.dir, "../..");
/** The client's single Tailwind entry (imports theme.css and theme-pulse.css). */
export const APP_CSS = join(WEB, "src/client/styles/app.css");

/** `CSS.escape`, as Tailwind uses it to turn a candidate into its class selector. */
export function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    const code = value.charCodeAt(i);
    if (code === 0) out += "�";
    else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) ||
      (i === 1 && code >= 48 && code <= 57 && value.charCodeAt(0) === 45)) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && value.length === 1 && code === 45) out += `\\${ch}`;
    else if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
    } else out += `\\${ch}`;
  }
  return out;
}

/** True when `css` has a selector for exactly class `token` (not a longer class it prefixes). */
export function hasClassRule(css: string, token: string): boolean {
  const selector = `.${cssEscape(token)}`;
  for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
    const next = css[at + selector.length];
    if (next === undefined || /[\s,:{.>~+)\[]/.test(next)) return true;
  }
  return false;
}

/** A package's stylesheet: its `exports["."].style` or `style` field, found up from `base`. */
function packageStylesheet(id: string, base: string): string {
  for (let dir = base; ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", id);
    if (existsSync(join(pkgDir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
        style?: string;
        exports?: { ".": { style?: string } };
      };
      return join(pkgDir, pkg.exports?.["."]?.style ?? pkg.style ?? "index.css");
    }
    if (dirname(dir) === dir) throw new Error(`stylesheet package not found: ${id}`);
  }
}

/** The installed Tailwind's compiler over app.css (same imports, plugins and theme). */
export async function referenceCompiler() {
  const loadStylesheet = async (id: string, base: string) => {
    const path = id.startsWith(".") ? resolve(base, id) : packageStylesheet(id, base);
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  };
  const loadModule = async (id: string, base: string) => {
    const path = Bun.resolveSync(id, base);
    return { path, base: dirname(path), module: ((await import(path)) as { default: unknown }).default };
  };
  return compile(readFileSync(APP_CSS, "utf8"), {
    base: dirname(APP_CSS),
    loadStylesheet,
    loadModule: loadModule as Parameters<typeof compile>[1] extends infer O ? O extends { loadModule?: infer L } ? L : never : never,
  });
}
