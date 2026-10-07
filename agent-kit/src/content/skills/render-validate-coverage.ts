// src/content/skills/render-validate-coverage.ts
// REQ-SKILL-02, REQ-INTEG-01 — the CLI-workflow skill.
//
// Wraps the render / validate / coverage verbs, their 0/1/2 exit codes, and `--json` surfaces.
// Renders from `slots.cliContract` — every verb, exit code, and envelope field is
// slot-driven, so a CLI drift fails the build rather than shipping a stale skill.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const renderValidateCoverage: ContentUnit = {
  id: "render-validate-coverage",
  kind: "skill",
  frontmatter: {
    name: "Render / validate / coverage",
    description:
      "Run the pulse render, validate, and coverage verbs and act on their exit codes " +
      "and --json output.",
    argumentHint: "<verb, e.g. validate>",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-SKILL-02", "REQ-INTEG-01"],
  render(slots): Section[] {
    const c = slots.cliContract;
    const wf = c.verbs.filter((v) => v.name !== "init");
    return [
      {
        heading: "When to use",
        text:
          "After any estate-config edit: `validate` to check it, `render` to produce the output " +
          "tree, `coverage` to confirm everything declared is actually monitored.",
      },
      {
        heading: "Verbs & exit codes",
        text: wf
          .map(
            (v) =>
              `### \`pulse ${v.name}\`\n${v.summary}\n` +
              v.exitCodes.map((e) => `- exit ${e.code}: ${e.condition}`).join("\n"),
          )
          .join("\n\n"),
      },
      {
        heading: "Reading --json",
        text:
          "Add `--json` for a machine envelope with fields: " +
          c.envelopeFields.map((f) => `\`${f}\``).join(", ") +
          ". Key off `exitCode` and, per verb, the `data` fields:\n" +
          wf
            .map(
              (v) =>
                `- \`${v.name}\`: ` +
                (v.dataFields.length
                  ? v.dataFields.map((f) => `\`${f}\``).join(", ")
                  : "(no data payload)"),
            )
            .join("\n"),
      },
      {
        heading: "Worked run",
        text: "The estate dir is cwd-relative (no flag override):",
        code: [
          {
            lang: "bash",
            body:
              "cd examples/reference\n" +
              "pulse validate --json    # exit 0 clean; 1 on a finding; 2 on a fault\n" +
              "pulse render\n" +
              "pulse coverage --json    # exit 1 if a declared target is unmonitored",
          },
        ],
      },
    ];
  },
};
