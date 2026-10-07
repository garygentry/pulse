// src/content/skills/coverage-interpretation.ts
// REQ-SKILL-03 — the coverage-finding interpretation skill.
//
// The inline how-to for interpreting a coverage finding: explain a declared-but-unmonitored
// target and propose the estate edit that closes it. Pairs with the `coverage-interpreter`
// subagent (the delegable form). Authored prose; secret-literal-free.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const coverageInterpretation: ContentUnit = {
  id: "coverage-interpretation",
  kind: "skill",
  frontmatter: {
    name: "Coverage interpretation",
    description:
      "Explain a declared-but-unmonitored coverage finding and propose the estate edit that " +
      "closes it.",
    argumentHint: "<host or service from the coverage gap>",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-SKILL-03"],
  render(): Section[] {
    return [
      {
        heading: "What a coverage gap is",
        text:
          "`pulse coverage` reports a target that is declared in the estate-config but not " +
          "actually monitored. Any gap makes the verb exit 1 — a signal to act, not a fault.",
      },
      {
        heading: "Read the finding",
        text:
          "Run `pulse coverage --json` and locate the entry in `data.gaps`. Each gap names the " +
          "affected host or service and the reason it is unmonitored.",
      },
      {
        heading: "Diagnose",
        text:
          "Common causes:\n" +
          "- A host is declared but has no exporter port / probe wired.\n" +
          "- A service has no deep-health probe where one is expected.\n" +
          "- A suppression is silencing a target that should be monitored.",
      },
      {
        heading: "Propose the fix",
        text:
          "Make the estate-config edit that closes the gap — typically via the `estate-authoring` " +
          "skill (add the missing exporter port, probe, or deep-health block) — then re-run " +
          "`pulse validate` and `pulse coverage` and confirm the gap is gone.",
      },
      {
        heading: "Guardrail",
        text:
          "If the gap is intentional (the target genuinely should not be monitored), close it by " +
          "adding a suppression with an explicit `rationale` — never silence it silently (see the " +
          "invariants guide).",
      },
    ];
  },
};
