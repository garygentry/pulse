// src/content/skills/estate-authoring.ts
// REQ-SKILL-01, REQ-INTEG-03, REQ-INTEG-04 — the estate-config authoring skill.
//
// A first-class runnable skill for evolving `estate.yaml` against the inventory-schema: add a
// host, add a service, add a deep-health probe. The collection-class list it teaches renders
// from `slots.inventoryVocab.collectionClasses`, so the edit-shapes track the live
// schema. Worked against the reference estate; secret-literal-free.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const estateAuthoring: ContentUnit = {
  id: "estate-authoring",
  kind: "skill",
  frontmatter: {
    name: "Estate authoring",
    description:
      "Add a host, service, or deep-health probe to the estate-config, validated against " +
      "the schema.",
    argumentHint: "<what to add, e.g. 'a managed-linux host'>",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-SKILL-01", "REQ-INTEG-04", "REQ-INTEG-03"],
  render(slots): Section[] {
    const v = slots.inventoryVocab;
    return [
      {
        heading: "When to use",
        text:
          "Any structural edit to the estate-config: adding a host, adding a service, or " +
          "attaching a deep-health probe. Work against `examples/reference/estate/estate.yaml` " +
          "as the shape reference.",
      },
      {
        heading: "Add a host",
        text:
          "1. Pick the collection class that matches the host — one of:\n" +
          v.collectionClasses.map((c) => `   - \`${c}\``).join("\n") +
          "\n2. Add the `hosts[]` entry with its id and addresses/exporter_ports (for an " +
          "exporter host) or api + credential reference (for an API-collected class).\n" +
          "3. Run `pulse validate` and confirm exit 0.",
      },
      {
        heading: "Add a service",
        text:
          "1. Add a `services[]` entry bound to an existing host (`host:` = the host id).\n" +
          "2. Choose its `kind` (e.g. `http`).\n" +
          "3. Run `pulse validate` and confirm exit 0.",
      },
      {
        heading: "Add a deep-health probe",
        text:
          "Attach a `deep_health` block to a service with an endpoint, a response_mapping, an " +
          "alert_expression, and a credential **reference** (never a literal), then validate:",
        code: [
          {
            lang: "yaml",
            body:
              "    deep_health:\n" +
              "      endpoint: https://portal.aurora.example/api/health\n" +
              "      alert_expression: pulse_deep_health_status == 0\n" +
              "      credential: ${WEB_HEALTH_TOKEN}   # env reference, never a literal",
          },
        ],
      },
      {
        heading: "Deliver backup freshness via a command",
        text:
          "To make a `backup_freshness` spec emit a live series (not just a declaration-only " +
          "threshold), add a read-only `command` that prints the newest backup artifact's AGE in " +
          "**seconds** to stdout. The renderer synthesizes a scalar command-signal on the " +
          "service's host emitting `pulse_backup_freshness_age_seconds{service}` and " +
          "`pulse_backup_freshness_up{service}` (`0` when the command can't run). The service must " +
          "resolve to a `managed-linux` host — the only class that runs the command-exporter — or " +
          "`validate` fails; then confirm exit 0:",
        code: [
          {
            lang: "yaml",
            body:
              "    backup_freshness:\n" +
              "      signal: pulse_backup_freshness_age_seconds\n" +
              "      threshold: \"24h\"\n" +
              "      command: [\"/opt/pulse/backup-age\", \"/mnt/backups\"]  # prints AGE in seconds\n" +
              "      interval: \"15m\"                     # optional; default 15m",
          },
        ],
      },
      {
        heading: "Add a channel (incl. Telegram)",
        text:
          "A `channels[]` entry has a `name`, a `kind` (`chat`, `email`, `push`, `telegram`, or " +
          "`webhook`), and a credential **reference**. A `telegram` channel additionally requires " +
          "`options.chat_id` (a non-secret int64 chat id or `@name`); it renders to an " +
          "Alertmanager `telegram_configs` receiver with the credential as `bot_token`. Wiring the " +
          "channel onto a host is a supervised runbook — you only declare it here — then validate:",
        code: [
          {
            lang: "yaml",
            body:
              "channels:\n" +
              "  - name: ops-telegram\n" +
              "    kind: telegram\n" +
              "    credential: ${TELEGRAM_BOT_TOKEN}   # reference, never a literal\n" +
              "    options:\n" +
              "      chat_id: \"-1001234567890\"        # required for telegram; non-secret",
          },
        ],
      },
      {
        heading: "Generated base + overlay layers",
        text:
          "When a skeleton is machine-generated, keep the generator's output in a `layer: base` " +
          "source and own your monitoring policy in a `layer: overlay` source in the same estate " +
          "directory — the loader deep-merges them by identity, overlay winning (arrays replace " +
          "whole). Never hand-edit the generated base; refine it in the overlay, then gate with " +
          "`pulse render --check` (exit 0 = no drift).",
      },
      {
        heading: "Guardrails",
        text:
          "- Credentials are `${ENV}` / `op://vault/item/field` references only — never a secret " +
          "literal.\n" +
          "- An excluded or suppressed target needs an explicit `rationale`.\n" +
          "- Never touch a host from here — you edit the config; host writes are a supervised " +
          "runbook (see the invariants guide and the operator tooling index).",
      },
      {
        heading: "Verify your edit",
        text: "End every edit by validating from the estate dir and reading exit 0:",
        code: [
          {
            lang: "bash",
            body: "cd examples/reference\npulse validate    # exit 0 = your edit is schema-clean",
          },
        ],
      },
    ];
  },
};
