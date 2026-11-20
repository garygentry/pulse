// Alertmanager v4 webhook body builders with public-safe labels.
//
// The plain types below mirror the webhook validator's accepted subset; they are declared locally so the helpers
// do not depend on the server's parser.

/** One alert of an Alertmanager v4 webhook body. */
export interface AmAlertFixture {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint: string;
}

/** An Alertmanager v4 webhook body. */
export interface AmNotificationFixture {
  version: "4";
  groupKey: string;
  truncatedAlerts: number;
  status: "firing" | "resolved";
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  alerts: AmAlertFixture[];
}

/** Options for `amAlert`. */
export interface AmAlertOptions {
  name?: string;
  severity?: string | null;
  target?: string | null;
  status?: "firing" | "resolved";
  fingerprint?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
}

const STARTS_AT = "2026-01-01T00:00:00Z";
const ZERO_TIME = "0001-01-01T00:00:00Z";

/** A v4 alert. Defaults: `HostDown`, severity `critical`, instance `web-01.example.com`, firing. */
export function amAlert(opts: AmAlertOptions = {}): AmAlertFixture {
  const name = opts.name ?? "HostDown";
  const status = opts.status ?? "firing";
  const severity = opts.severity === undefined ? "critical" : opts.severity;
  const target = opts.target === undefined ? "web-01.example.com" : opts.target;
  const labels: Record<string, string> = { alertname: name };
  if (severity !== null) labels.severity = severity;
  if (target !== null) labels.instance = target;
  Object.assign(labels, opts.labels ?? {});
  return {
    status,
    labels,
    annotations: { summary: `${name} on ${target ?? "unknown"}`, ...(opts.annotations ?? {}) },
    startsAt: opts.startsAt ?? STARTS_AT,
    endsAt: status === "resolved" ? "2026-01-01T00:05:00Z" : ZERO_TIME,
    generatorURL: "https://vmalert.example.com/vmalert/alert?group_id=1",
    fingerprint: opts.fingerprint ?? "0123456789abcdef",
  };
}

/** Options for `amNotification`. */
export interface AmNotificationOptions {
  alerts?: AmAlertFixture[];
  status?: "firing" | "resolved";
  groupKey?: string;
  truncatedAlerts?: number;
}

/** A v4 webhook body. Status defaults to firing when any alert fires, else resolved. */
export function amNotification(opts: AmNotificationOptions = {}): AmNotificationFixture {
  const alerts = opts.alerts ?? [amAlert()];
  const status = opts.status ?? (alerts.some((a) => a.status === "firing") ? "firing" : "resolved");
  return {
    version: "4",
    groupKey: opts.groupKey ?? '{}:{alertname="HostDown"}',
    truncatedAlerts: opts.truncatedAlerts ?? 0,
    status,
    receiver: "pulse-push",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "https://alertmanager.example.com",
    alerts,
  };
}
