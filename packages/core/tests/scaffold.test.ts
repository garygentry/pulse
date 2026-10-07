import { expect, test } from "bun:test";

// Scaffold smoke test: proves the workspace package resolves and `bun test`
// is green before any real suites exist. Superseded in spirit by the per-module
// suites (items 012–013); kept minimal so it never conflicts with them.
test("@pulse/core barrel is importable", async () => {
  const mod = await import("../src/index.js");
  expect(mod).toBeDefined();
});
