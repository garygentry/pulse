// apps/web/tests/contract/perf-budget.test.ts — the time the suite pays for the generated contract: one
// in-memory generation, shape extraction included.

import { expect, test } from "bun:test";

import { generateContract } from "../../scripts/contract/generate.js";
import { firstGenerationMs, generated, GENERATION_TIMEOUT } from "./generated.js";

const BUDGET_MS = 15_000;

test("the one generation, extraction included, takes under 15 s", async () => {
  const ms = await firstGenerationMs();
  if (ms >= BUDGET_MS) {
    throw new Error(`contract generation took ${Math.round(ms)} ms; the budget is ${BUDGET_MS} ms`);
  }
  expect(ms).toBeLessThan(BUDGET_MS);
}, GENERATION_TIMEOUT);

test("the timed generation was a real one, and nothing generates a second time", async () => {
  // A generation started outside the shared helper would leave the helper timing a cache hit.
  expect(await firstGenerationMs()).toBeGreaterThan(50);
  expect(await generateContract({ frozen: "report" })).toBe(await generated());
}, GENERATION_TIMEOUT);
