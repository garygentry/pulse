// src/content/guidance/invariants.ts
// REQ-GUIDE-04, REQ-SEC-01, REQ-SEC-02 — the non-negotiable invariants & guardrails.
//
// States the three invariants an agent must never violate: render ≠ deploy, secret references
// never literals, and silence requires a rationale. Authored prose (no contract slot), held to
// the secret-safety lint (REQ-SEC-01) — every code example uses only `${ENV}` / `op://` grammar.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const invariants: ContentUnit = {
  id: "invariants",
  kind: "guidance",
  frontmatter: {
    name: "Invariants & guardrails",
    description:
      "The non-negotiables: render ≠ deploy, secret references never literals, silence " +
      "requires a rationale.",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-GUIDE-04", "REQ-SEC-01", "REQ-SEC-02"],
  render(): Section[] {
    return [
      {
        heading: "The three invariants",
        text:
          "These hold on every task, without exception:\n\n" +
          "1. **Render ≠ deploy.** Nothing you run in this repo touches a host.\n" +
          "2. **Secret references, never literals.** Credentials are `${ENV}` / `op://` refs only.\n" +
          "3. **Silence requires a rationale.** No target is excluded or suppressed without one.",
      },
      {
        heading: "Render ≠ deploy",
        text:
          "`pulse render`, `pulse validate`, and `pulse coverage` never touch a host — they only " +
          "read and write files in this repo. Any change to a host (installing an agent, wiring " +
          "alert channels, enrolling backups) happens ONLY in a supervised runbook session. You " +
          "propose the estate-config edit; a human runs the matching runbook (see the operator " +
          "tooling index).",
      },
      {
        heading: "Secret references, never literals",
        text:
          "Every credential in the estate-config is a **reference**, resolved at deploy time. " +
          "Never paste a raw token, password, or key into any file:",
        code: [
          {
            lang: "yaml",
            body:
              "credential: ${WEB_HEALTH_TOKEN}          # environment reference\n" +
              "credential: op://infra/nas/token         # 1Password reference",
          },
        ],
      },
      {
        heading: "Silence requires a rationale",
        text:
          "A host or target is only excluded (collection class `excluded`) or suppressed with an " +
          "explicit `rationale` field in the estate-config. Silent suppression is forbidden — if " +
          "you drop a target from monitoring, the config must say why, so a reviewer can see the " +
          "intent.",
      },
      {
        heading: "If in doubt",
        text:
          "When a task would require touching a host, deleting a file, or inlining a secret, stop " +
          "and escalate to the human operator rather than take a destructive or host-touching " +
          "action. Proposing the estate edit is always safe; applying it to a host is not yours " +
          "to do.",
      },
    ];
  },
};
