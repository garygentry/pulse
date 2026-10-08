/** The shared, camelCase, thin-normalized estate model — the single downstream
 *  vocabulary (00-core-definitions.md §3). Types only; estate-agnostic by construction
 *  (REQ-MODEL-02): it encodes structure, never a specific estate's identity. */

import type { Provenance } from "./provenance.js";

export type { Provenance } from "./provenance.js";

// ── §3.0 Model root (REQ-MODEL-01) ──────────────────────────────────────────

/** The typed, thin-normalized estate model — the single shared downstream vocabulary
 *  (REQ-MODEL-01). Produced only on a successful load. */
export interface EstateModel {
  /** The declared schema major this model was validated against (REQ-VER-01). */
  schemaMajor: number;
  /** Estate-level metadata (§3.1). Exactly one per model. */
  estate: Estate;
  /** All declared hosts, insertion-ordered by first appearance (REQ-DET-01). */
  hosts: Host[];
  /** All declared services, insertion-ordered. */
  services: Service[];
  /** All declared channels, insertion-ordered. */
  channels: Channel[];
  /** severity→channel routing overrides, resolved against `channels` (REQ-CHAN-03). */
  routingOverrides: RoutingOverride[];
  /** Standalone suppressions (known-expected conditions); in-target suppression marks
   *  live on the host/service they apply to (§3.5, REQ-SUPP-03). */
  suppressions: Suppression[];
}

// ── §3.1 Estate metadata (REQ-META-01/02/03) ────────────────────────────────

/** Estate-level metadata. Exactly one `estate` block per load (a second is a
 *  DUPLICATE_ESTATE finding — 03-loader-and-pipeline.md §merge). */
export interface Estate {
  /** Estate name — a label only; carries no monitoring semantics (REQ-META-01). */
  name: string;
  /** One or more domains the estate serves (REQ-META-01). */
  domains: string[];
  /** Resolver targeted by generated DNS checks. Omitted to use the renderer's public default. */
  dnsResolver?: string;
  /** IANA timezone. Required and validated; a missing or unparseable value is an error
   *  finding (REQ-META-02, CON-06). */
  timezone: string;
  /** Channel/endpoint the always-firing deadman signal targets (REQ-META-01). A secret
   *  reference when it carries a credential, else a plain identifier. */
  deadmanHook: SecretRef | string;
  /** Retention-target window as a declared value (REQ-META-03, P1). Optional; stored
   *  opaquely. */
  retention?: string;
  /** Where this block was declared (REQ-MODEL-03). */
  provenance: Provenance;
}

// ── §3.2 Hosts and collection classes (REQ-HOST-01/02/03/04, CON-07) ─────────

/** The fixed v1 collection-class discriminant (CON-07). Mirrors COLLECTION_CLASSES. */
export type CollectionClass =
  | "managed-linux"
  | "hypervisor-api"
  | "nas-api"
  | "probe-only"
  | "excluded";

/** Fields common to every host regardless of collection class (REQ-HOST-01/04). */
interface HostBase {
  /** Host identity — unique across the estate (duplicate → DUPLICATE_IDENTITY). */
  name: string;
  /** One or more reachable addresses (hostname/IP) (REQ-HOST-01). */
  addresses: string[];
  /** Per-host churn flag (charter §invariant 6, REQ-HOST-04). */
  expectedChurn?: boolean;
  /** Per-target scrape-interval class label (REQ-HOST-04). Opaque to core-contract. */
  scrapeIntervalClass?: string;
  /** Where this host was declared (REQ-MODEL-03). */
  provenance: Provenance;
}

/** A host, discriminated on `collectionClass`. Exactly one class per host, and the
 *  class-specific fields are required for that class and rejected on the others
 *  (REQ-HOST-02/03). */
export type Host =
  | (HostBase & {
      collectionClass: "managed-linux";
      exporterPorts: number[];
      cadvisor: boolean;
      /** Heartbeat opt-in (issue #30). Defaults true; `false` renders a node-exporter-only host
       *  (no :9110 heartbeat scrape target, no `scrapePorts.heartbeat` in the agent descriptor). */
      heartbeat: boolean;
      deliveryForm: "compose" | "systemd";
      /** Read-only command signals this host runs (issue #3 / #1). Always present (possibly
       *  empty) after normalization. Only managed-linux hosts run the agent bundle. */
      commandSignals: CommandSignal[];
    })
  | (HostBase & { collectionClass: "hypervisor-api"; apiEndpoint: string; credential: SecretRef })
  // nas-api renders as a DIRECT node_exporter scrape (issue #4). `apiEndpoint`/`credential`
  // are optional, reserved fields for the documented opt-in TrueNAS-API-exporter override;
  // both-or-neither (checkNasApiCompleteness). The shipped renderer ignores them.
  | (HostBase & { collectionClass: "nas-api"; apiEndpoint?: string; credential?: SecretRef })
  | (HostBase & { collectionClass: "probe-only"; probe: ProbeSpec })
  | (HostBase & { collectionClass: "excluded"; suppressed: SuppressionMark });

/** Host-level synthetic reachability/liveness probe for a `probe-only` host. Distinct
 *  from a service DeepHealthProbe (§3.3). The contract carries only the declaration
 *  (REQ-HOST-03). */
export interface ProbeSpec {
  /** Probe transport, e.g. "icmp" | "tcp" | "http". Opaque string to core-contract. */
  kind: string;
  /** What to probe — address/port/URL as the kind requires. */
  target: string;
  /** Optional expected-response assertion (HTTP status class or body match). */
  expect?: string;
}

// ── §3.3 Services, deep-health, backup-freshness (REQ-SVC-01/02/03/04) ───────

export interface Service {
  /** Service identity — unique across the estate (REQ-SVC-01). */
  name: string;
  /** Owning host name; resolved against EstateModel.hosts (REQ-SVC-01). An unresolved
   *  name is an UNRESOLVED_HOST finding (04). */
  host: string;
  /** Service kind label (opaque to core-contract). */
  kind: string;
  /** Whether Pulse manages this service's lifecycle (REQ-SVC-01). */
  managed: boolean;
  /** Ingress URL that drives end-to-end checks, where applicable (REQ-SVC-01). */
  ingressUrl?: string;
  /** Present iff this service declares a deep-health probe (REQ-SVC-02/04). */
  deepHealth?: DeepHealthProbe;
  /** Optional backup-freshness spec (REQ-SVC-03). */
  backupFreshness?: BackupFreshness;
  /** Per-endpoint alert bindings (issue #15). Present iff the service declares `alerts:`; each
   *  entry renders into the service's Gatus `endpoints[].alerts[]`, binding the synthetic ingress
   *  check to the Gatus→Alertmanager provider so it pages. Inert on a service that renders no Gatus
   *  endpoint (no `ingressUrl` / suppressed). */
  alerts?: EndpointAlert[];
  /** Present iff this service is a suppressed target (REQ-SUPP-03). */
  suppressed?: SuppressionMark;
  /** Where this service was declared (REQ-MODEL-03). */
  provenance: Provenance;
}

/** One per-endpoint alert binding (issue #15). CamelCase model vocabulary. A binding on a service
 *  that renders a Gatus endpoint makes stack/alerting emit a `GatusCheckFailed` vmalert rule over
 *  that check's `gatus_results_total` series (issue #1); Gatus itself carries no alerting config.
 *  Omitted thresholds take the rule builder's defaults (failure 3, success 2). */
export interface EndpointAlert {
  /** Retained for compatibility; selects nothing. Historically the Gatus provider type to bind
   *  (`"custom"`, the retired Gatus→Alertmanager provider). Any non-empty value is accepted. */
  type: string;
  /** Whether this binding is active; omitted → enabled. `false` → no rule is rendered. */
  enabled?: boolean;
  /** Human-readable description carried as the alert's `description` annotation. */
  description?: string;
  /** Failed checks needed to fire (F, 1–60); omitted → 3. The rule fires when, within ONE window,
   *  there were ≥ F failed checks and no passing check — tested over F minutes + 30s (about the F-th
   *  consecutive failure at Gatus's nominal 60s cadence) and over 4·F minutes (so slowed-down checks
   *  still fire, later). */
  failureThreshold?: number;
  /** Passing checks needed to resolve (S, 1–60); omitted → 2. A firing alert resolves when, within
   *  the clear window of ceil(1.5·S) + 1 minutes, there were ≥ S passing checks and no failed check
   *  (so S = 1 still needs a 3-minute failure-free window). With no fresh results (Gatus down) it
   *  keeps firing. */
  successThreshold?: number;
  /** Retained for compatibility; has no effect. Resolve notifications are governed by each
   *  Alertmanager receiver's `send_resolved`; `false` draws an advisory alerting finding. */
  sendOnResolved?: boolean;
}

/** Service deep-health probe declaration (REQ-SVC-02). Carries the vocabulary only. */
export interface DeepHealthProbe {
  /** Probe endpoint returning a JSON health document. */
  endpoint: string;
  /** Response mapping: metric name → JSON path (REQ-SVC-02). The KEY is the metric name the prober
   *  emits as the `pulse_deep_health` `metric` label; the VALUE is the JSON path it reads from the
   *  probe response. Deep-health alert expressions reference the metric name (the key). */
  responseMapping: Record<string, string>;
  /** Per-probe alert expression, e.g. "camera_count < 6" (REQ-SVC-02). Opaque string. */
  alertExpression: string;
  /** Optional credential reference for authenticated probes; never resolved by core. */
  credential?: SecretRef;
  /** True iff this probe must run from the service's own host (issue #8): a loopback/bridge-local
   *  endpoint the central prober cannot reach. Routes the probe to a per-host prober config
   *  (agent/<host>/prober/config.yaml) instead of the central prober/config.yaml. */
  hostLocal?: boolean;
}

/** Backup-freshness spec (REQ-SVC-03). */
export interface BackupFreshness {
  /** The freshness signal source (REQ-SVC-03) — the emitted series name, e.g.
   *  `pulse_backup_freshness_age_seconds`. Documentary; alerting keys off its own constant. */
  signal: string;
  /** Threshold; downstream: > threshold → warning, > 2× → critical (charter 02). */
  threshold: string;
  /** Optional argv (issue #3) that prints the newest-backup AGE IN SECONDS. When present, the
   *  renderer synthesizes a scalar command-signal on the service's (managed-linux) host, delivering
   *  `pulse_backup_freshness_age_seconds{service}` + `_up`. Absent → declaration-only (unchanged). */
  command?: string[];
  /** Optional check cadence (duration string). Renderer default "15m". */
  interval?: string;
}

// ── Command signals (issue #3 / #1) ──────────────────────────────────────────

/** A read-only command a managed-linux host runs on a cadence; the command-exporter publishes its
 *  output as metrics (issue #3 / #1). Two output modes, discriminated on `output` (mirrors the
 *  schema union). `scalar`: the command prints one number → `metric{labels}` + `upMetric{labels}`.
 *  `exposition`: the command prints Prometheus text, passed through with `pulse_command_signal_up`. */
export type CommandSignal =
  | {
      output: "scalar";
      /** Signal identity — unique among a host's signals. */
      name: string;
      /** Read-only argv, run verbatim (no shell). */
      command: string[];
      /** Cadence as a duration string (renderer parses to ms). */
      interval: string;
      /** The gauge series name the numeric value is emitted as. */
      metric: string;
      /** The honest-when-blind liveness series name (1 ok / 0 failed). */
      upMetric: string;
      /** Fixed non-host labels baked onto both series; `host` is scrape-applied. */
      labels?: Record<string, string>;
      /** Optional credential reference; never resolved by core (REQ-SEC-01). */
      credential?: SecretRef;
    }
  | {
      output: "exposition";
      name: string;
      command: string[];
      interval: string;
      credential?: SecretRef;
    };

// ── §3.4 Channels and routing (REQ-CHAN-01/02/03) ───────────────────────────

/** The v1 channel kinds (REQ-CHAN-01). An estate may enable any subset. `telegram` (issue #2)
 *  is an additive member — a backward-compatible minor change (06 §6.1). */
export type ChannelKind = "chat" | "email" | "push" | "telegram" | "webhook";

/** A channel's generic, per-kind, NON-secret options map (issue #2) — provider knobs a kind needs
 *  beyond its credential (e.g. Telegram's `chat_id`). Never carries a secret. */
export type ChannelOptions = Record<string, string | number | boolean>;

export interface Channel {
  /** Channel identity — unique across the estate. */
  name: string;
  /** Channel kind (REQ-CHAN-01). */
  kind: ChannelKind;
  /** Credential as a reference only, never a literal (REQ-CHAN-02, REQ-SECR-01). */
  credential: SecretRef;
  /** Optional non-secret per-kind options (issue #2). Present iff the channel declares `options`;
   *  `kind: telegram` requires `options.chat_id` (MISSING_CHAT_ID, 04). */
  options?: ChannelOptions;
  /** Where this channel was declared (REQ-MODEL-03). */
  provenance: Provenance;
}

/** A severity→channel routing override (REQ-CHAN-03). */
export interface RoutingOverride {
  /** Severity label to redirect (opaque here; `alerting` owns the taxonomy). */
  severity: string;
  /** Target channel names; each resolved against EstateModel.channels
   *  (unresolved → UNRESOLVED_CHANNEL finding, 04). */
  channels: string[];
  provenance: Provenance;
}

// ── §3.5 Suppressions (REQ-SUPP-01/02/03) ───────────────────────────────────

/** The three suppression classes (REQ-SUPP-01, charter §invariant 6). */
export type SuppressionClass = "excluded" | "expected-churn" | "known-expected";

/** In-place flag on a suppressed target (host/service) (REQ-SUPP-03). */
export interface SuppressionMark {
  /** Which suppression class applies. */
  class: SuppressionClass;
  /** Mandatory rationale (REQ-SUPP-02, CON-03). Absence is an error finding
   *  (MISSING_RATIONALE), not a warning. */
  rationale: string;
}

/** A standalone suppression entry — a known-expected condition (REQ-SUPP-01). */
export interface Suppression extends SuppressionMark {
  /** What is suppressed — a host/service/condition identity. */
  target: string;
  provenance: Provenance;
}

// ── §3.6 Secret references (REQ-SECR-01/02/03, REQ-SEC-01) ───────────────────

/** A parsed secret *reference* — the reference only, never a resolved value
 *  (REQ-SEC-01, REQ-SECR-03). Discriminated on `kind`. A non-matching value in a
 *  credential slot is a SECRET_LITERAL finding (04), not a SecretRef. */
export type SecretRef =
  | {
      kind: "env";
      /** The original reference text, e.g. "${SLACK_TOKEN}". */
      raw: string;
      /** The env var name, e.g. "SLACK_TOKEN". */
      varName: string;
    }
  | {
      kind: "op";
      /** The original reference text, e.g. "op://vault/item/field". */
      raw: string;
      vault: string;
      item: string;
      field: string;
    };
