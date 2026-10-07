// agent-kit/scripts/generate.ts
// Generation pipeline (REQ-DRIFT-01/ECO-04/MAINT-01/OBS-02).
//
// Walks the manifest, runs each emitter in ECOSYSTEMS order, writes every EmittedFile under
// `generated/<ecosystem>/`, then writes the pack data module. A deliberate, reviewed
// regeneration act invoked via `bun run --filter @pulse/agent-kit generate`.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ECOSYSTEMS } from "../src/emit/types.js";
import type { EmittedFile } from "../src/emit/types.js";
import { emitterFor } from "../src/emit/registry.js";
import { assertNoSecretLiterals } from "../src/emit/secret-lint.js"; // REQ-SEC-01
import { manifest } from "../src/content/manifest.js"; // the single-source manifest
import { buildSlots } from "../src/slots/index.js"; // Slots aggregator
import { renderPackModule } from "../src/emit/pack.js";

/** Absolute path to `agent-kit/generated`. */
const GENERATED_ROOT = resolve(import.meta.dir, "../generated");

/** Write one emitted file under the ecosystem root, creating parent dirs. */
async function writeEmitted(root: string, ecosystem: string, file: EmittedFile): Promise<void> {
  const abs = join(root, ecosystem, file.path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, file.contents, "utf8");
}

/**
 * Regenerate `generated/**` from the single source. Deterministic: the only inputs are
 * the manifest and slots. Throws on any malformed unit / unknown ecosystem / secret literal
 * — no partial or degraded emission.
 */
export async function generate(root: string = GENERATED_ROOT): Promise<void> {
  const slots = await buildSlots();
  const log: string[] = [];

  for (const ecosystem of ECOSYSTEMS) {
    // Clean the ecosystem tree first so a removed unit cannot leave a stale file behind.
    await rm(join(root, ecosystem), { recursive: true, force: true });
    const files = emitterFor(ecosystem).emit(manifest, slots);
    for (const file of files) {
      assertNoSecretLiterals(join(ecosystem, file.path), file.contents); // REQ-SEC-01
      await writeEmitted(root, ecosystem, file);
    }
    log.push(`  ${ecosystem.padEnd(8)} ${files.length} file(s)`);
  }

  // Pack data module (GUIDANCE_PACK + PACK_BYTES) from the freshly written tree.
  await writeFile(join(root, "guidance-pack.generated.ts"), await renderPackModule(root), "utf8");

  // Observability (REQ-OBS-02): which ecosystems were generated.
  console.log("agent-kit: generated per-ecosystem outputs:");
  console.log(log.join("\n"));
  console.log(`  pack     guidance-pack.generated.ts`);
}

if (import.meta.main) {
  await generate();
}
