// apps/web/src/client/store/chunk-css.ts — the client-owned chunk stylesheet loader (03 §7).

import { SHELL_MARKERS } from "../api/client.js";

/** Parsed island per Document. A WeakMap lets torn-down test documents be collected. */
let islandCache = new WeakMap<Document, Record<string, string[]>>();

function readIsland(doc: Document): Record<string, string[]> {
  const cached = islandCache.get(doc);
  if (cached !== undefined) return cached;

  let map: Record<string, string[]> = {};
  const el = doc.getElementById(SHELL_MARKERS.chunkCssIsland);
  if (el !== null) {
    try {
      const parsed: unknown = JSON.parse(el.textContent ?? "{}");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        map = parsed as Record<string, string[]>;
      } else {
        console.warn("[pulse] chunk-css island is not an object; ignoring");
      }
    } catch {
      console.warn("[pulse] chunk-css island is not valid JSON; ignoring");
    }
  }
  islandCache.set(doc, map);
  return map;
}

function hasStylesheet(doc: Document, path: string): boolean {
  return Array.from(doc.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .some((link) => link.getAttribute("href") === path);
}

/**
 * Attach the stylesheets owned by a lazy module and resolve after every new link settles.
 * Link errors are warned about but never reject, so stylesheet delivery cannot become a chunk
 * loading failure.
 */
export async function attachChunkStyles(key: string, doc: Document = document): Promise<void> {
  const paths = readIsland(doc)[key];
  if (!Array.isArray(paths) || paths.length === 0) return;

  const pending: Promise<void>[] = [];
  for (const path of new Set(paths)) {
    if (typeof path !== "string" || hasStylesheet(doc, path)) continue;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = path;
    pending.push(
      new Promise<void>((resolve) => {
        const settle = (failed: boolean): void => {
          link.removeEventListener("load", onLoad);
          link.removeEventListener("error", onError);
          if (failed) console.warn(`[pulse] chunk stylesheet failed to load: ${path}`);
          resolve();
        };
        const onLoad = (): void => settle(false);
        const onError = (): void => settle(true);
        link.addEventListener("load", onLoad);
        link.addEventListener("error", onError);
      }),
    );
    doc.head.appendChild(link);
  }
  await Promise.all(pending);
}

/** Drop the memoized per-document island map. Test-only seam. */
export function _resetChunkCssForTest(): void {
  islandCache = new WeakMap();
}
