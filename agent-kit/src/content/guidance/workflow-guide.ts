// src/content/guidance/workflow-guide.ts
// REQ-GUIDE-03, REQ-INTEG-01 — the operate loop over the pulse CLI verbs.
//
// Teaches the operate loop `init → author → validate → render → coverage`: what each verb does
// and the 0/1/2 exit-code and `--json` semantics an agent keys off. Renders entirely from
// `slots.cliContract` — never a hard-coded verb
// or exit code, so a CLI drift fails the build instead of shipping stale guidance.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const workflowGuide: ContentUnit = {
  id: "workflow-guide",
  kind: "guidance",
  frontmatter: {
    name: "Operate loop",
    description:
      "What each pulse verb does and the exit-code / --json semantics to key off.",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-GUIDE-03", "REQ-INTEG-01"],
  render(slots): Section[] {
    const c = slots.cliContract;
    return [
      {
        heading: "The operate loop",
        text:
          "You operate Pulse by editing the estate-config and running the CLI verbs in order. " +
          "The loop is:\n\n" +
          c.verbs.map((v, i) => `${i + 1}. \`pulse ${v.name}\``).join("  →  ") +
          "\n\nStart with `init` once (scaffolds this pack), then cycle author → `validate` → " +
          "`render` → `coverage` on every change.",
      },
      {
        heading: "Verbs",
        text: c.verbs.map((v) => `- \`pulse ${v.name}\` — ${v.summary}`).join("\n"),
      },
      {
        heading: "Exit codes",
        text:
          "Every verb follows the 0/1/2 contract: 0 clean, 1 a finding/gap/drift you must act " +
          "on, 2 a fault (bad input or internal error). Per verb:\n\n" +
          c.verbs
            .map(
              (v) =>
                `### \`pulse ${v.name}\`\n` +
                v.exitCodes.map((e) => `- exit ${e.code}: ${e.condition}`).join("\n"),
            )
            .join("\n\n"),
      },
      {
        heading: "Reading --json",
        text:
          "Add `--json` to any verb for a machine `PulseEnvelope<D>` with top-level fields: " +
          c.envelopeFields.map((f) => `\`${f}\``).join(", ") +
          ". Key off `exitCode` and, per verb, the `data` field names:\n" +
          c.verbs
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
        text:
          "The estate dir is cwd-relative (there is no flag to override it), so `cd` into the " +
          "estate first:",
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
