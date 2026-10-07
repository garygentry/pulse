// src/content/subagents/alert-triage.ts
// REQ-SKILL-04, REQ-SKILL-05, REQ-INTEG-05 — the alert-triage subagent.
//
// Classifies and explains a firing alert against the severity taxonomy. The severities are
// enumerated from `slots.severity` — never hard-coded — so exactly the taxonomy's
// three severities are presented, and `deadman` is explicitly NOT a fourth severity.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const alertTriage: ContentUnit = {
  id: "alert-triage",
  kind: "subagent",
  frontmatter: {
    name: "Alert triage",
    description:
      "Classify and explain a firing alert by severity (critical/warning/info) and its " +
      "routing, using the Pulse severity taxonomy.",
    argumentHint: "<alert name or payload>",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-SKILL-04", "REQ-SKILL-05", "REQ-INTEG-05"],
  render(slots): Section[] {
    return [
      {
        heading: "Role",
        text:
          "Given a firing alert, identify its severity, explain what it means, and state where it " +
          "routes. Do not modify hosts — triage and recommend only.",
      },
      {
        heading: "Severity taxonomy",
        text:
          `There are exactly ${slots.severity.length} severities, each with a required response ` +
          "and routing:\n" +
          slots.severity
            .map((s) => `- **${s.name}**: ${s.response} Routes to: ${s.channels}.`)
            .join("\n") +
          "\n\nNote: the deadman is a liveness mechanism (it fires when a source stops reporting), " +
          "not a fourth severity. Do not classify an alert as `deadman`.",
      },
      {
        heading: "Triage steps",
        text:
          "1. Read the alert name and labels.\n" +
          "2. Map it to one of the severities above.\n" +
          "3. State the routing (which channels, per the estate `routing_overrides`).\n" +
          "4. Recommend the next action — e.g. open the relevant runbook if a host is affected, " +
          "supervised by a human. Never touch a host yourself.",
      },
    ];
  },
};
