// apps/web/tests/chunk-css.test.ts — promise and island behavior of the chunk stylesheet loader.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { SHELL_MARKERS } from "../src/client/api/client.js";
import { attachChunkStyles, _resetChunkCssForTest } from "../src/client/store/chunk-css.js";
import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";

function setIsland(value: string): void {
  const island = document.createElement("script");
  island.id = SHELL_MARKERS.chunkCssIsland;
  island.type = "application/json";
  island.textContent = value;
  document.body.appendChild(island);
}

function styleLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
}

function settleLinks(type: "load" | "error"): void {
  for (const link of styleLinks()) link.dispatchEvent(new Event(type));
}

describe("attachChunkStyles", () => {
  beforeAll(() => {
    registerHappyDom();
  });

  afterAll(async () => {
    await unregisterHappyDom();
  });

  beforeEach(() => {
    _resetChunkCssForTest();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    _resetChunkCssForTest();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  test("waits for every newly appended stylesheet to load", async () => {
    setIsland(JSON.stringify({ X: ["/assets/x-a.css", "/assets/x-b.css"] }));
    let resolved = false;
    const attached = attachChunkStyles("X").then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(styleLinks().map((link) => link.getAttribute("href"))).toEqual([
      "/assets/x-a.css",
      "/assets/x-b.css",
    ]);
    expect(resolved).toBe(false);
    settleLinks("load");
    await attached;
    expect(resolved).toBe(true);
  });

  test("deduplicates paths and skips already-present stylesheets", async () => {
    const existing = document.createElement("link");
    existing.rel = "stylesheet";
    existing.href = "/assets/shared.css";
    document.head.appendChild(existing);
    setIsland(JSON.stringify({ X: ["/assets/shared.css", "/assets/new.css", "/assets/new.css"] }));

    const first = attachChunkStyles("X");
    expect(styleLinks()).toHaveLength(2);
    styleLinks()[1]!.dispatchEvent(new Event("load"));
    await first;
    await attachChunkStyles("X");
    expect(styleLinks()).toHaveLength(2);
  });

  test("resolves after an error, warns, and removes settlement listeners", async () => {
    setIsland(JSON.stringify({ X: ["/assets/missing.css"] }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const attached = attachChunkStyles("X");
      const link = styleLinks()[0]!;
      link.dispatchEvent(new Event("error"));
      await attached;
      link.dispatchEvent(new Event("load"));
      link.dispatchEvent(new Event("error"));
      expect(warnings).toEqual([
        "[pulse] chunk stylesheet failed to load: /assets/missing.css",
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("malformed island warns once and resolves without attaching", async () => {
    setIsland("{not-json");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      await attachChunkStyles("X");
      await attachChunkStyles("Y");
      expect(styleLinks()).toHaveLength(0);
      expect(warnings).toEqual(["[pulse] chunk-css island is not valid JSON; ignoring"]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("caches island content independently for each Document", async () => {
    setIsland(JSON.stringify({ X: [] }));
    await attachChunkStyles("X", document);
    document.getElementById(SHELL_MARKERS.chunkCssIsland)!.textContent = JSON.stringify({
      X: ["/assets/ignored.css"],
    });
    await attachChunkStyles("X", document);
    expect(styleLinks()).toHaveLength(0);

    const otherWindow = new GlobalWindow({ url: "http://other.test/" });
    try {
      const other = otherWindow.document as unknown as Document;
      const island = other.createElement("script");
      island.id = SHELL_MARKERS.chunkCssIsland;
      island.textContent = JSON.stringify({ X: ["/assets/other.css"] });
      other.body.appendChild(island);
      const pending = attachChunkStyles("X", other);
      const link = other.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!;
      link.dispatchEvent(new otherWindow.Event("load") as unknown as Event);
      await pending;
      expect(link.getAttribute("href")).toBe("/assets/other.css");
    } finally {
      await otherWindow.close();
    }
  });

  test("absent island and unknown keys resolve silently", async () => {
    await attachChunkStyles("X");
    setIsland(JSON.stringify({ Y: ["/assets/y.css"] }));
    _resetChunkCssForTest();
    await attachChunkStyles("X");
    expect(styleLinks()).toHaveLength(0);
  });
});
