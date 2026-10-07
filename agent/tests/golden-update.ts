// agent/tests/golden-update.ts — DELIBERATELY (re)generate the committed prober exposition
// goldens (item 015; 06-testing-strategy.md §1, §8).
//
// Regenerating a golden is a REVIEWED act, never automatic: a silently-updated golden defeats
// the exact-text compare in `prober.test.ts`. Run it by hand when a prober-output change is
// intentional, then review the diff before committing — the same workflow as
// `packages/renderer/tests/golden-update.ts`:
//
//     bun agent/tests/golden-update.ts
//
// It drives each registered scenario (agent/tests/golden/scenarios.ts) through the real,
// hermetic prober pipeline and writes `agent/tests/golden/<name>.exposition.txt`. The input
// `<name>.config.yaml` fixtures are hand-authored and are NOT written here.

import { writeFile } from "node:fs/promises";

import { SCENARIOS, renderScenario, scenarioExpositionPath } from "./golden/scenarios.js";

for (const scenario of SCENARIOS) {
  const text = await renderScenario(scenario);
  const dest = scenarioExpositionPath(scenario);
  await writeFile(dest, text, "utf8");
  console.log(`wrote golden/${scenario.name}.exposition.txt (${scenario.description})`);
}
