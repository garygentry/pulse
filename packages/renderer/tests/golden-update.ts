/** golden-update.ts — DELIBERATELY (re)generate committed golden trees (07 §3.1).
 *
 *  Regenerating a golden is a reviewed act, NEVER automatic: a silently-updated golden defeats
 *  the whole-tree compare. Run it by hand when a rendering change is intentional, then review the
 *  diff before committing:
 *
 *      bun packages/renderer/tests/golden-update.ts
 *
 *  It renders each registered fixture model and writes every RenderedFile under
 *  tests/golden/<case>.golden/, clearing the directory first so a removed file disappears. */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EstateModel } from "@pulse/core";

import { render } from "../src/render/index.js";
import { multiclassModel } from "./fixtures/multiclass/model.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The registry of golden cases: case name → the model to render. */
const CASES: Record<string, EstateModel> = {
  multiclass: multiclassModel,
};

for (const [name, model] of Object.entries(CASES)) {
  const dir = join(here, "golden", `${name}.golden`);
  // Narrow the discriminated RenderResult.ok BEFORE touching `tree` (07 §3.2): a fatal web
  // projection writes no replacement golden and fails loudly instead of leaving a stale tree.
  const result = render(model);
  if (!result.ok) {
    console.error(`✗ render failed for golden case "${name}"; no golden written:`);
    for (const f of result.findings) console.error(`  [${f.severity}] ${f.code} ${f.message}`);
    process.exit(1);
  }
  const { tree } = result;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of tree) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.contents, "utf8");
  }
  console.log(`wrote ${tree.length} files → golden/${name}.golden/`);
  for (const f of tree) console.log(`  ${f.path}`);
}
