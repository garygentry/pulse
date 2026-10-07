// agent-kit/src/slots/cli-contract.ts
// CLI contract lock — the authored table (REQ-DRIFT-02, REQ-GUIDE-03, REQ-SKILL-02).
//
// The verb / exit-code / `--json`-shape table the workflow-guide (REQ-GUIDE-03) and the
// render/validate/coverage skill (REQ-SKILL-02) render from. Authored here as a typed
// `CliContract` value; `cli-contract.test.ts` (item 007) drives
// the real CLI via `runCli` and asserts every claim, so a drift fails the build (REQ-DRIFT-02).

import type { CliContract } from "../emit/types.js"; // CliContract/CliVerb/CliExitCase shapes

/**
 * The authored CLI contract. `verbs.map(v => v.name)` is asserted == the real CLI verb set;
 * each `exitCodes[]` case is asserted by driving the real CLI to that condition; `dataFields`
 * are asserted against the real `--json` envelope's `data` payload (verified shapes:
 * InitData ["created","skipped","wouldClobber"] apps/cli/src/envelope.ts;
 * RenderData ["outputRoot","filesWritten","mode","drift"]; CoverageData
 * ["covered","gaps","suppressed"]; validate carries no data, ValidateData = null).
 * `envelopeFields` are the PulseEnvelope<D> top-level keys an agent parses.
 */
export const CLI_CONTRACT: CliContract = {
  verbs: [
    {
      name: "init",
      summary: "Scaffold a Pulse repo (config + estate + guidance pack), create-only.",
      exitCodes: [
        { code: 0, condition: "scaffold written (or idempotent under --force)" },
        { code: 1, condition: "an existing target would be clobbered without --force (wouldClobber)" },
        { code: 2, condition: "a path escapes repo root / a raw fs fault" },
      ],
      dataFields: ["created", "skipped", "wouldClobber"],
    },
    {
      name: "render",
      summary: "Materialize the estate into the committed rendered/ tree.",
      exitCodes: [
        { code: 0, condition: "render clean (write mode, or --check with no drift)" },
        { code: 1, condition: "--check with drift" },
        { code: 2, condition: "a thrown tool fault" },
      ],
      dataFields: ["outputRoot", "filesWritten", "mode", "drift"],
    },
    {
      name: "validate",
      summary: "Load + validate the estate against the inventory schema.",
      exitCodes: [
        { code: 0, condition: "validate clean" },
        { code: 1, condition: "a seeded error finding (or a warning under --strict)" },
        { code: 2, condition: "a thrown tool fault" },
      ],
      dataFields: [], // ValidateData = null; findings carry everything
    },
    {
      name: "coverage",
      summary: "Report covered / gaps / suppressed entities for the estate.",
      exitCodes: [
        { code: 0, condition: "no gaps" },
        { code: 1, condition: "one or more declared-but-unmonitored gaps" },
        { code: 2, condition: "a thrown tool fault" },
      ],
      dataFields: ["covered", "gaps", "suppressed"],
    },
  ],
  envelopeFields: ["ok", "exitCode", "command", "findings", "data", "meta"],
};
