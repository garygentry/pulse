// stack/alerting/src/transform/am-config.ts
// Local object shapes mirroring the native Alertmanager config schema (prom/alertmanager v0.27.0).
// These are the alerting-local RENDERING shapes — distinct from the abstract `AmRoutingRendered`
// INPUT shape (00 §2.1, ./rendered.ts). Serialized to YAML by render.ts (008) via the `yaml`
// package with deterministic key order. See 04-alertmanager-config.md §1.1.

/** A native Alertmanager receiver. Exactly one `*_configs` key is populated per receiver. */
export interface AmNativeReceiver {
  name: string;
  webhook_configs?: AmWebhookConfig[];
  slack_configs?: Record<string, unknown>[];
  email_configs?: Record<string, unknown>[];
  /** Native `telegram_configs` (issue #2): `bot_token` (a `${ENV}`/`op://` ref) + non-secret `chat_id`. */
  telegram_configs?: Record<string, unknown>[];
}

/** A native webhook receiver entry (the mirror + the dead-man receiver use this). */
export interface AmWebhookConfig {
  /** Destination URL or `${ENV}` reference — never a resolved literal (REQ-SEC-01). */
  url: string;
  /** Whether resolved notifications are delivered to this receiver. */
  send_resolved: boolean;
}

/** A native Alertmanager route node (root or child). */
export interface AmRoute {
  receiver: string;
  group_by?: readonly string[];
  matchers?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  mute_time_intervals?: string[];
  active_time_intervals?: string[];
  continue?: boolean;
  routes?: AmRoute[];
}

/** A native Alertmanager time interval. */
export interface AmTimeInterval {
  name: string;
  time_intervals: AmTimeIntervalSpec[];
}

/** A single time-of-day window spec within a named interval. */
export interface AmTimeIntervalSpec {
  /** IANA tz name from `Estate.timezone` (REQ-ROUTE-03). Required — never omitted. */
  location: string;
  times?: { start_time: string; end_time: string }[];
  weekdays?: string[];
}

/** A native Alertmanager inhibit rule. */
export interface AmInhibitRule {
  source_matchers: string[];
  target_matchers: string[];
  equal?: string[];
}

/** The complete assembled native config object serialized to alertmanager.yml. */
export interface AmNativeConfig {
  global: { resolve_timeout: string };
  /** Notification template globs Alertmanager loads (issue #16). Backs the runbook-link partials the
   *  email/telegram receivers reference. Present iff the transform registers templates. */
  templates?: string[];
  route: AmRoute;
  receivers: AmNativeReceiver[];
  time_intervals: AmTimeInterval[];
  inhibit_rules: AmInhibitRule[];
}
