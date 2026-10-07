/** fixtures/multiclass/model.ts — a multi-class estate exercising every emitter (07 §2, §3.1).
 *
 *  Covers all five collection classes (managed-linux/hypervisor-api/nas-api/probe-only/excluded),
 *  services with ingress / deep-health / backup-freshness / suppression, three channels
 *  (webhook/chat/telegram) with a routing override, and two estate domains — so the committed golden tree at
 *  tests/golden/multiclass.golden/ contains every artifact kind. `excluded` deliberately emits NO
 *  scrape file (the mapping table, 02 §3.4). Three managed-linux hosts exercise the agent emitter's
 *  full contract in the complete-tree golden: `web01` (compose / cadvisor off → no 8080), `app02`
 *  (systemd / cadvisor on → 8080 present), and `dns01` (systemd / cadvisor + heartbeat off →
 *  node-exporter-only, no 8080/9110; issue #30), while the three non-managed-linux classes emit
 *  NO agent config. Built via the shared factories (no loader round-trip). */

import type { EstateModel } from "@pulse/core";

import { PROV, envRef, makeChannel, makeHost, makeModel, makeService } from "../../factories.js";

export const multiclassModel: EstateModel = makeModel({
  estate: {
    name: "home-estate",
    domains: ["example.com", "internal.example.com"],
    timezone: "UTC",
    deadmanHook: "https://deadman.example.com/ping",
    provenance: PROV,
  },
  hosts: [
    makeHost("managed-linux", {
      name: "web01",
      addresses: ["10.0.0.4"],
      exporterPorts: [9100, 9256],
      cadvisor: false,
      deliveryForm: "compose",
      // Command signals (issue #3/#1): one `exposition` (command prints Prometheus text) and one
      // `scalar` (command prints a number → declared metric + up_metric). Exercises both output
      // modes of the command-exporter emitter in the complete-tree golden.
      commandSignals: [
        { output: "exposition", name: "gpu", command: ["/opt/pulse/gpu-metrics.sh"], interval: "30s" },
        {
          output: "scalar",
          name: "drift",
          command: ["/opt/pulse/drift-count"],
          interval: "5m",
          metric: "pulse_config_drift_count",
          upMetric: "pulse_config_drift_up",
          labels: { scope: "estate" },
        },
      ],
    }),
    makeHost("managed-linux", {
      name: "app02",
      addresses: ["10.0.0.7"],
      exporterPorts: [9100],
      cadvisor: true,
      deliveryForm: "systemd",
    }),
    // node-exporter-only managed-linux host (issue #30): a native node_exporter binary with no
    // container runtime (e.g. a Technitium DNS box). heartbeat off → no :9110 scrape target and no
    // scrapePorts.heartbeat in agent/dns01.yaml; only :9100 (managed-linux) is rendered.
    makeHost("managed-linux", {
      name: "dns01",
      addresses: ["10.0.0.8"],
      exporterPorts: [9100],
      cadvisor: false,
      heartbeat: false,
      deliveryForm: "systemd",
    }),
    makeHost("hypervisor-api", {
      name: "pve1",
      addresses: ["10.0.0.5"],
      apiEndpoint: "https://pve1:8006",
      credential: envRef("PVE_TOKEN"),
    }),
    // nas-api renders as a DIRECT node_exporter scrape (issue #4): no apiEndpoint/credential,
    // target is <addresses[0]>:9100. hypervisor-api (pve1) covers the API-credential path.
    makeHost("nas-api", {
      name: "nas1",
      addresses: ["10.0.0.6"],
    }),
    makeHost("probe-only", {
      name: "edge01",
      addresses: ["10.0.0.9"],
      probe: { kind: "icmp", target: "10.0.0.9" },
    }),
    makeHost("excluded", {
      name: "old01",
      addresses: ["10.0.0.99"],
      suppressed: { class: "excluded", rationale: "decommissioned 2026-01" },
    }),
  ],
  services: [
    makeService({
      name: "grafana",
      host: "web01",
      ingressUrl: "https://grafana.example.com",
      deepHealth: {
        endpoint: "https://grafana.example.com/api/health",
        responseMapping: { db_ok: "$.database" },
        alertExpression: "db_ok == 0",
      },
    }),
    makeService({
      name: "frigate",
      host: "web01",
      // A DELIVERED backup (issue #3): `command` prints the newest-snapshot age → the renderer
      // synthesizes a `backup:frigate` scalar signal on web01's command-exporter config, alongside
      // the prober declaration. Signal name reconciled to the emitted series.
      backupFreshness: {
        signal: "pulse_backup_freshness_age_seconds",
        threshold: "26h",
        command: ["/opt/pulse/backup-age", "/var/backups/frigate"],
      },
    }),
    makeService({
      name: "staging",
      host: "web01",
      managed: false,
      suppressed: { class: "known-expected", rationale: "flaky staging box" },
    }),
    // HOST-LOCAL deep-health probe (issue #8): a loopback endpoint the central prober can't reach,
    // routed to a per-host prober config (agent/app02/prober/config.yaml). Placed on app02 (no
    // command signals) so the golden also exercises the dedicated :9120 prober group
    // independently of the command-exporter :9130 on web01.
    makeService({
      name: "nvr",
      host: "app02",
      deepHealth: {
        endpoint: "http://127.0.0.1:5000/api/stats",
        responseMapping: { detectors: "$.detectors.count" },
        alertExpression: "pulse_deep_health_up == 0",
        hostLocal: true,
      },
    }),
  ],
  channels: [
    makeChannel({ name: "oncall", kind: "webhook", credential: envRef("OPSGENIE_WEBHOOK") }),
    makeChannel({ name: "team-chat", kind: "chat", credential: envRef("SLACK_TOKEN") }),
    // telegram (issue #2): bot-token credential + non-secret chat_id via the options map, so the
    // golden tree exercises the telegram_configs slot end to end.
    makeChannel({
      name: "team-telegram",
      kind: "telegram",
      credential: envRef("TELEGRAM_BOT_TOKEN"),
      options: { chat_id: -1002001002003 },
    }),
  ],
  routingOverrides: [{ severity: "critical", channels: ["oncall"], provenance: PROV }],
});
