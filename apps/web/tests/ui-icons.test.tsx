// apps/web/tests/ui-icons.test.tsx — ported from deck's `ui-icons` suite (vendored `@/ui`).
import { describe, expect, it, spyOn } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { FALLBACK_ICON, Icon, ICONS, isIconName } from "@/ui";
import { chunkUrlFromError, createIconRegistry, createIconSetLoader, iconRegistry, ICON_LOAD_RETRY_DELAYS_MS } from "@/ui/lib/icon-registry";
import { createIcon } from "@/ui/patterns/icon";
import { SHELL_ICONS } from "@/ui/lib/icons-shell";

import { act, cleanup, describeUi, render } from "./rtl.js";

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

describe("icon chunks (shell set eager, the rest lazy)", () => {
  it("the shell set is part of the curated set, with the same components", () => {
    for (const [name, component] of Object.entries(SHELL_ICONS)) {
      expect(isIconName(name), name).toBe(true);
      expect(ICONS[name as keyof typeof ICONS], name).toBe(component);
    }
    expect(Object.keys(SHELL_ICONS).length).toBeLessThan(Object.keys(ICONS).length / 2);
  });

  it("importing the curated set registers it with <Icon>'s registry", () => {
    expect(iconRegistry.lookup("bell")).toBe(ICONS.bell);
    expect(iconRegistry.lookup("lantern")).toBe("unknown");
  });

  it("a registry resolves its seed at once and the rest after the full set registers", () => {
    const registry = createIconRegistry({ server: ICONS.server });
    const notified: number[] = [];
    const unsubscribe = registry.subscribe(() => notified.push(registry.version()));
    expect(registry.lookup("server")).toBe(ICONS.server);
    expect(registry.lookup("bell")).toBe("pending");
    expect(registry.lookup("lantern")).toBe("pending");
    registry.registerFullSet(ICONS);
    expect(registry.lookup("bell")).toBe(ICONS.bell);
    expect(registry.lookup("lantern")).toBe("unknown");
    expect(registry.lookup("toString")).toBe("unknown");
    registry.registerFullSet(ICONS); // idempotent: no second notification
    expect(notified).toEqual([1]);
    unsubscribe();
  });
});

describe("icon set loader", () => {
  /** A loader whose imports the test settles by hand, with retries queued instead of timed. */
  function harness() {
    const registry = createIconRegistry({ server: ICONS.server });
    const attempts: { resolve: () => void; reject: () => void }[] = [];
    const retries: { run: () => void; ms: number }[] = [];
    const loader = createIconSetLoader(
      registry,
      () => new Promise((resolve, reject) => attempts.push({ resolve: () => resolve({ ICONS }), reject: () => reject(new Error("chunk")) })),
      (run, ms) => retries.push({ run, ms }),
    );
    return { registry, attempts, retries, loader };
  }

  it("marks the set unavailable on a failed load and retries on a bounded backoff", async () => {
    const { registry, attempts, retries, loader } = harness();
    const first = loader.load();
    attempts[0]!.reject();
    await expect(first).rejects.toThrow("chunk");
    expect(registry.lookup("bell")).toBe("unavailable");
    expect(retries.map((r) => r.ms)).toEqual([ICON_LOAD_RETRY_DELAYS_MS[0]]);
    for (let i = 1; i <= ICON_LOAD_RETRY_DELAYS_MS.length; i += 1) {
      retries[i - 1]!.run();
      attempts[i]!.reject();
      await Promise.resolve().then(() => Promise.resolve());
    }
    // One retry per delay, then it waits for the next call.
    expect(retries.map((r) => r.ms)).toEqual([...ICON_LOAD_RETRY_DELAYS_MS]);
    const late = loader.load();
    attempts.at(-1)!.resolve();
    await late;
    expect(registry.lookup("bell")).toBe(ICONS.bell);
  });

  it("shares one attempt between concurrent calls and stops once loaded", async () => {
    const { registry, attempts, loader } = harness();
    const a = loader.load();
    const b = loader.load();
    expect(attempts).toHaveLength(1);
    attempts[0]!.resolve();
    await Promise.all([a, b]);
    await loader.load();
    expect(attempts).toHaveLength(1);
    expect(registry.lookup("bell")).toBe(ICONS.bell);
  });
});

describeUi("<Icon> before the full set loads", () => {
  function setup() {
    const registry = createIconRegistry({ server: ICONS.server });
    let loads = 0;
    const TestIcon = createIcon(registry, () => {
      loads += 1;
      return new Promise<void>(() => {});
    });
    return { registry, TestIcon, loads: () => loads };
  }

  it("renders a shell icon at once", () => {
    const { TestIcon } = setup();
    const svg = render(<TestIcon name="server" />).container.querySelector("svg")!;
    expect(svg).toHaveClass("lucide-server");
  });

  it("renders an empty svg of the same size, asks for the set, and fills in when it registers", () => {
    const { registry, TestIcon, loads } = setup();
    const { container } = render(<TestIcon name="bell" size={20} className="text-muted-foreground" />);
    const placeholder = container.querySelector("svg")!;
    expect(placeholder.childElementCount).toBe(0);
    expect(placeholder).toHaveAttribute("width", "20");
    expect(placeholder).toHaveAttribute("height", "20");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder).toHaveAttribute("data-slot", "icon");
    expect(placeholder).toHaveClass("text-muted-foreground");
    expect(loads()).toBe(1);
    act(() => registry.registerFullSet(ICONS));
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("lucide-bell");
    expect(svg).toHaveAttribute("width", "20");
  });

  it("renders the fallback glyph after a failed load, without an unknown-icon warning, then fills in", () => {
    const { registry, TestIcon } = setup();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { container } = render(<TestIcon name="bell" />);
      act(() => registry.markUnavailable());
      const fallback = render(<FALLBACK_ICON />).container.querySelector("svg")!;
      expect(container.querySelector("svg")!.getAttribute("class")).toBe(fallback.getAttribute("class"));
      expect(warn).not.toHaveBeenCalled();
      act(() => registry.registerFullSet(ICONS));
      expect(container.querySelector("svg")).toHaveClass("lucide-bell");
    } finally {
      warn.mockRestore();
    }
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

describe("chunkUrlFromError", () => {
  const origin = "https://pulse.example.org";
  it("re-roots the /assets/*.js path named in a Chromium/Firefox error on the page origin", () => {
    const err = new TypeError("Failed to fetch dynamically imported module: https://pulse.example.org/assets/chunk-icons-ab12cd34.js");
    expect(chunkUrlFromError(err, origin)).toBe("https://pulse.example.org/assets/chunk-icons-ab12cd34.js");
  });
  it("never yields another origin, even for a host with a .js label or a foreign URL", () => {
    const err = new TypeError("error loading dynamically imported module: http://pulse.js.example.com/assets/chunk-icons-x.js");
    expect(chunkUrlFromError(err, origin)).toBe("https://pulse.example.org/assets/chunk-icons-x.js");
    expect(chunkUrlFromError(new Error("https://evil.example/x.js"), origin)).toBeNull();
  });
  it("returns null when the error names no asset (Safari)", () => {
    expect(chunkUrlFromError(new TypeError("Importing a module script failed."), origin)).toBeNull();
  });
});
