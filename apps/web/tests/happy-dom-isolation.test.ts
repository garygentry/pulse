import { afterAll, beforeAll, expect, test } from "bun:test";
import nodeProcess from "node:process";

import { registerHappyDom, unregisterHappyDom } from "./happy-dom.js";

beforeAll(() => {
  registerHappyDom();
});

afterAll(async () => {
  await unregisterHappyDom();
});

test("happy-dom preserves Bun process globals required by Playwright", async () => {
  expect(globalThis.process).toBe(nodeProcess);
  expect(globalThis.process.stderr).toBeDefined();
  expect(typeof globalThis.process.nextTick).toBe("function");

  const playwright = await import("playwright-core");
  expect(playwright.chromium).toBeDefined();
});
