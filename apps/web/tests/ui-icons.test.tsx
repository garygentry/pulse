// apps/web/tests/ui-icons.test.tsx — ported from deck's `ui-icons` suite (vendored `@/ui`).
import { describe, expect, it, spyOn } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { FALLBACK_ICON, Icon, ICONS, isIconName } from "@/ui";

import { cleanup, describeUi, render } from "./rtl.js";

// Resolve from the web package root.
const webRoot = resolve(import.meta.dir, "..");
const root = (path: string): string => resolve(webRoot, path);

function* files(dir: string, pattern: RegExp): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path, pattern);
    else if (pattern.test(entry)) yield path;
  }
}

/**
 * Every icon token the app source hands to the icon system: `icon: "…"` fields,
 * literal `data-icon="…"` attributes, and the values of `*_ICON` maps. The
 * vendored `src/client/ui` library is excluded (it imports Lucide components directly).
 */
function sourceIconTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const add = (token: string, file: string): void => {
    if (!tokens.has(token)) tokens.set(token, file);
  };
  const vendored = `${sep}${join("src", "client", "ui")}${sep}`;
  for (const file of files(root("src"), /\.tsx?$/)) {
    if (file.includes(vendored)) continue;
    const text = readFileSync(file, "utf8");
    for (const [, token] of text.matchAll(/\bicon:\s*"([^"]+)"/g)) add(token!, file);
    for (const [, token] of text.matchAll(/data-icon="([^"]+)"/g)) add(token!, file);
    for (const [, body] of text.matchAll(/\bconst \w+_ICON\b[^={]*=\s*(?:Object\.freeze\()?\{([^}]*)\}/g)) {
      for (const [, token] of body!.matchAll(/:\s*"([^"]+)"/g)) add(token!, file);
    }
  }
  return tokens;
}

describe("icon registry", () => {
  it("maps every IconName to a Lucide component", () => {
    for (const [name, component] of Object.entries(ICONS)) {
      expect(component, name).toBeTruthy();
      expect(isIconName(name)).toBe(true);
    }
  });

  it("covers every icon token the feature source uses", () => {
    const tokens = sourceIconTokens();
    // Guard against the scan silently finding nothing. (Deck asserts > 30; pulse's views hand the
    // icon system fewer distinct tokens — 21 at port time — so the floor is lowered.)
    expect(tokens.size).toBeGreaterThan(15);
    const unknown = [...tokens].filter(([token]) => !isIconName(token));
    expect(unknown).toEqual([]);
  });

  // Deck's "covers every icon token in the example estate" case is dropped: it scans deck's
  // `examples/estate/**/*.yaml` `icon:` fields, and pulse has no estate config carrying icons.

  it("does not treat inherited object keys as icon names", () => {
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("constructor")).toBe(false);
  });
});

describeUi("<Icon>", () => {
  it("renders the mapped icon as a decorative, unfocusable svg", () => {
    const { container } = render(<Icon name="check-circle" className="text-status-ok-fg" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).toHaveClass("lucide-circle-check", "text-status-ok-fg");
  });

  it("renders the aliases of one icon identically", () => {
    const a = render(<Icon name="check-circle" />).container.innerHTML;
    cleanup();
    const b = render(<Icon name="circle-check" />).container.innerHTML;
    expect(a).toBe(b);
  });

  it("falls back to a neutral icon and warns once for an unknown token", () => {
    // The warning is gated on `import.meta.env.DEV`, which Vite sets in deck's vitest run. Under
    // bun `import.meta.env` is `process.env`, so set DEV for this case only.
    const previousDev = process.env["DEV"];
    process.env["DEV"] = "true";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { container } = render(
        <>
          <Icon name="lantern" />
          <Icon name="lantern" />
        </>,
      );
      const fallback = render(<FALLBACK_ICON />).container.querySelector("svg")!;
      const svgs = container.querySelectorAll("svg");
      expect(svgs).toHaveLength(2);
      expect(svgs[0]!.getAttribute("class")).toBe(fallback.getAttribute("class"));
      expect(svgs[0]).toHaveAttribute("aria-hidden", "true");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('"lantern"');
    } finally {
      warn.mockRestore();
      if (previousDev === undefined) delete process.env["DEV"];
      else process.env["DEV"] = previousDev;
    }
  });
});
