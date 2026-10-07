// src/content/guidance/pointers-index.ts
// REQ-GUIDE-05, REQ-INTEG-02, REQ-SEC-02 — the operator tooling map.
//
// Ties the scaffolded skills/subagents and the deploy-toolkit runbooks together so the agent
// knows what tooling exists and when to reach for each. Authored prose; names the REAL runbooks
// under `docs/runbooks/` (by filename only, never copying their content) and the sibling content
// units by id. Reinforces that host writes happen only in supervised runbook sessions.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const pointersIndex: ContentUnit = {
  id: "pointers-index",
  kind: "guidance",
  frontmatter: {
    name: "Operator tooling index",
    description:
      "Which skill, subagent, or runbook to reach for — and which touch a host.",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-GUIDE-05", "REQ-INTEG-02"],
  render(): Section[] {
    return [
      {
        heading: "Skills & subagents",
        text:
          "This pack scaffolds these operator tools. Reach for them in-repo (they never touch a " +
          "host):\n\n" +
          "| Tool | Kind | Reach for it when… |\n" +
          "| --- | --- | --- |\n" +
          "| `estate-authoring` | skill | You need to add a host, service, or deep-health probe to the estate-config. |\n" +
          "| `render-validate-coverage` | skill | You need to run a verb and act on its exit code / `--json`. |\n" +
          "| `coverage-interpretation` | skill | You have a coverage gap to explain and close inline. |\n" +
          "| `alert-triage` | subagent | A firing alert needs classifying by severity and routing. |\n" +
          "| `coverage-interpreter` | subagent | You want to hand off a full `coverage --json` payload for per-gap analysis. |",
      },
      {
        heading: "Runbooks (host-write sessions)",
        text:
          "Host writes — installing agents, wiring channels, enrolling backups — happen ONLY in a " +
          "supervised runbook session under `docs/runbooks/`. You propose the estate edit; a human " +
          "runs the runbook. The runbooks:\n\n" +
          "| Runbook | File | Reach for it when… |\n" +
          "| --- | --- | --- |\n" +
          "| Bootstrap | `bootstrap.md` | Standing up a fresh Pulse engine on a host. |\n" +
          "| Agent install | `agent-install.md` | Enrolling the host-agent bundle on a monitored host. |\n" +
          "| Rollout session | `rollout-session.md` | The supervised session wiring alert channels + deadman. |\n" +
          "| Backup enrollment | `backup-enrollment.md` | Declaring backup freshness and wiring its rules. |\n" +
          "| Retirement checklist | `retirement-checklist.md` | Cutting a host/system over off the incumbent monitor. |",
      },
      {
        heading: "Decision guide",
        text:
          "- Editing the estate-config → the `estate-authoring` skill.\n" +
          "- A `validate` / `render` / `coverage` question → the `render-validate-coverage` skill.\n" +
          "- A coverage gap to explain → the `coverage-interpretation` skill (or hand the whole " +
          "`coverage --json` payload to the `coverage-interpreter` subagent).\n" +
          "- A firing alert → the `alert-triage` subagent.\n" +
          "- Touching a host → the matching runbook above, supervised by a human. Never do it " +
          "from the repo yourself.",
      },
    ];
  },
};
