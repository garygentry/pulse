// src/content/guidance/vocab-primer.ts
// REQ-GUIDE-02, REQ-INTEG-03, REQ-INTEG-04 — the inventory-contract / vocabulary primer.
//
// Teaches the estate-config vocabulary an agent authors against. Sections 2–3 render from
// `slots.inventoryVocab` (schema major, top-level sections, host collection classes) so a
// renamed section or a changed collection class in `inventorySchema` changes what this primer
// teaches AND fails `inventory-contract.test.ts` — the primer can never teach stale vocabulary.
// Worked against the reference estate.

import type { ContentUnit, Section } from "../../emit/types.js";
import { FIRST_CLASS_ECOSYSTEMS } from "../../emit/types.js";

export const vocabPrimer: ContentUnit = {
  id: "vocab-primer",
  kind: "guidance",
  frontmatter: {
    name: "Inventory vocabulary primer",
    description:
      "The estate-config vocabulary you author against: sections, host collection " +
      "classes, deep-health/backup specs, channels, routing, and suppressions.",
  },
  targets: [...FIRST_CLASS_ECOSYSTEMS],
  requirements: ["REQ-GUIDE-02", "REQ-INTEG-04", "REQ-INTEG-03"],
  render(slots): Section[] {
    const v = slots.inventoryVocab;
    return [
      {
        heading: "Estate config at a glance",
        text:
          `Pulse is driven by one declarative estate-config YAML that you edit. It targets ` +
          `schema major v${v.schemaMajor}. You never touch a host to change monitoring — you ` +
          `edit this file and re-render (see the invariants guide). The reference estate under ` +
          "`examples/reference/estate/estate.yaml` is the worked example this pack teaches from.",
      },
      {
        heading: "Top-level sections",
        text:
          "The estate-config declares these top-level sections (schema order):\n" +
          v.sections
            .map((s) => `- \`${s.key}\`${s.required ? " (required)" : ""}: ${s.summary}`)
            .join("\n"),
      },
      {
        heading: "Host collection classes",
        text:
          "Every host declares exactly one collection class, which fixes how Pulse collects " +
          "from it:\n" +
          v.collectionClasses.map((c) => `- \`${c}\``).join("\n") +
          "\n\nPick the class that matches how the host exposes itself (a Linux exporter, a " +
          "hypervisor/NAS API, a black-box probe, or an explicit exclusion).",
      },
      {
        heading: "Deep-health & backup-freshness",
        text:
          "A service may declare a `deep_health` probe (endpoint + response_mapping + " +
          "alert_expression) or a `backup_freshness` spec (signal + threshold). In the reference " +
          "estate the `portal-web` service attaches a `deep_health` probe and `nas-backups` " +
          "attaches a `backup_freshness` spec — copy those shapes:",
        code: [
          {
            lang: "yaml",
            body:
              "services:\n" +
              "  - name: portal-web\n" +
              "    host: harbor-web-01\n" +
              "    kind: http\n" +
              "    deep_health:\n" +
              "      endpoint: https://portal.aurora.example/api/health\n" +
              "      alert_expression: pulse_deep_health_status == 0\n" +
              "      credential: ${WEB_HEALTH_TOKEN}   # env reference, never a literal",
          },
        ],
      },
      {
        heading: "Command signals (host-computed backup freshness)",
        text:
          "A `backup_freshness` spec with a `threshold` alone is a declaration-only alert " +
          "threshold — it delivers no live series. Add a **`command`** and Pulse delivers it " +
          "through the command-exporter: the renderer synthesizes a `scalar` command-signal on " +
          "the service's host emitting `pulse_backup_freshness_age_seconds{service}` (the value) " +
          "and `pulse_backup_freshness_up{service}` (`1` ok / `0` blind — missing data is never a " +
          "healthy backup). The command must be read-only argv (run verbatim, no shell) that " +
          "prints the age of the newest backup artifact, in **seconds**, to stdout. The service " +
          "must resolve to a `managed-linux` host — that is the only class that runs the " +
          "command-exporter bundle; a `command` on any other class is a validation error.",
        code: [
          {
            lang: "yaml",
            body:
              "services:\n" +
              "  - name: nas-backups\n" +
              "    host: backup-orchestrator-01          # must be a managed-linux host\n" +
              "    kind: backup\n" +
              "    backup_freshness:\n" +
              "      signal: pulse_backup_freshness_age_seconds\n" +
              "      threshold: \"24h\"\n" +
              "      command: [\"/opt/pulse/backup-age\", \"/mnt/backups\"]  # prints newest-backup AGE in seconds\n" +
              "      interval: \"15m\"                     # optional; default 15m",
          },
        ],
      },
      {
        heading: "Channels, routing & suppressions",
        text:
          "Channels carry a credential reference and define where alerts go. Each channel has a " +
          "`kind` (`chat`, `email`, `push`, `telegram`, or `webhook`). A `telegram` channel adds " +
          "one required non-secret knob — `options.chat_id` (an int64 chat id or `@name`) — " +
          "alongside its credential; the renderer emits it to an Alertmanager `telegram_configs` " +
          "receiver with the credential as `bot_token` and `chat_id` carried verbatim from " +
          "`options`. `routing_overrides` map a severity to specific channels. A `suppressions` " +
          "entry silences a target, but every suppression requires an explicit `rationale` — " +
          "silence is never anonymous (see the invariants guide).",
        code: [
          {
            lang: "yaml",
            body:
              "channels:\n" +
              "  - name: ops-telegram\n" +
              "    kind: telegram\n" +
              "    credential: ${TELEGRAM_BOT_TOKEN}   # bot token — a reference, never a literal\n" +
              "    options:\n" +
              "      chat_id: \"-1001234567890\"        # required for telegram; non-secret",
          },
        ],
      },
      {
        heading: "Layers: generated base + hand-authored overlay",
        text:
          "A source file may carry an optional top-level `layer:` so a machine-generated skeleton " +
          "and hand-authored monitoring policy live side by side in the same estate directory. " +
          "`layer: base` is the regenerable, deterministic skeleton (intrinsic facts a generator " +
          "knows — hosts, addresses); `layer: overlay` is the human-owned refinement. The loader " +
          "deep-merges them by identity (same host/service/channel `name`, or the `estate` block) " +
          "with the **overlay winning** every conflict — except a conflicting array (e.g. " +
          "`exporter_ports`), where the overlay array replaces the base array whole. `layer:` is " +
          "opt-in: a repo with no markers behaves exactly as before (every source implicitly " +
          "`base`, a duplicate identity still a hard error). Commit the base, the overlay, and the " +
          "rendered tree together, and gate with `pulse render --check` (exit 0 = the committed " +
          "tree still equals a fresh render).",
        code: [
          {
            lang: "yaml",
            body:
              "# estate/00-skeleton.base.yaml — machine-generated, regenerable\n" +
              "layer: base\n" +
              "hosts:\n" +
              "  - name: app-01\n" +
              "    collection_class: managed-linux\n" +
              "    exporter_ports: [9100]\n" +
              "---\n" +
              "# estate/10-monitoring.overlay.yaml — you own this by hand\n" +
              "layer: overlay\n" +
              "hosts:\n" +
              "  - name: app-01              # same identity → deep-merged onto the base host\n" +
              "    cadvisor: true            # overlay scalar wins\n" +
              "    exporter_ports: [9100, 9256]   # overlay array REPLACES the base array whole",
          },
        ],
      },
      {
        heading: "Secret grammar",
        text:
          "Credentials are ALWAYS a reference — `${ENV_VAR}` or `op://vault/item/field` — never " +
          "an inline secret literal. If you ever see a raw token or password in a file, stop and " +
          "flag it to the operator.",
      },
    ];
  },
};
