// packages/web-data/src/contract/enums.ts — how a client treats a value it does not know in a closed
// (literal-union) contract field. Data only: no imports, browser-safe.

/** How a client treats an unknown member of a literal-union field. */
export type EnumFallback =
  /** Treat as this existing member. */
  | {
      /** Discriminant: substitute an existing member. */ readonly kind: "as-member";
      /** The member to substitute; one of the union's own members. */ readonly member: string;
    }
  /** No suitable member: a display rule documented in prose. */
  | {
      /** Discriminant: follow a prose display rule. */ readonly kind: "display-rule";
      /** The rule, as one non-empty sentence. */ readonly rule: string;
    };

/** One entry: the field path(s) sharing a fallback, and the fallback. */
export interface EnumFallbackEntry {
  /** Group id, used for the `unknown-enum-<group>` fixture name. Kebab-case. */
  readonly group: string;
  /**
   * Field paths this entry covers, as `<Root>.a.b[]` (`[]` array element, `{}` record value,
   * `(field=value)` discriminated variant). Every literal-union path appears in exactly one entry.
   */
  readonly paths: readonly string[];
  /** Fallback rule. For "as-member", `member` must be one of the union's members. */
  readonly fallback: EnumFallback;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const entry = (group: string, paths: readonly string[], fallback: EnumFallback): EnumFallbackEntry =>
  Object.freeze({ group, paths: Object.freeze([...paths].sort(byCodeUnit)), fallback: Object.freeze(fallback) });

/**
 * The complete fallback table, sorted by group. `view-id` covers the keys of a finite-key record rather than a
 * field value: a client ignores a key it does not know.
 */
export const ENUM_FALLBACKS: readonly EnumFallbackEntry[] = Object.freeze([
  entry("alert-state", [
    "AlertsPayload.alerts[].state",
  ], { kind: "as-member", member: "firing" }),
  entry("api-error-code", [
    "ErrorEnvelope.code",
  ], { kind: "display-rule", rule: "Treat as a generic failure and show the message." }),
  entry("attribution", [
    "IntervalHistoryPayload.lanes[].attribution",
  ], { kind: "as-member", member: "unmatched" }),
  entry("auth-mode", [
    "SessionPayload.authMode",
  ], { kind: "display-rule", rule: "Treat as no write access." }),
  entry("availability-state", [
    "AlertsPayload.alertmanager.state",
    "AlertsPayload.vmalert.state",
    "EstatePayload.coverage.availability.state",
    "EstatePayload.declaredVersusScraped.availability.state",
    "EstatePayload.findings.availability.state",
    "EstatePayload.liveTargets[].availability.state",
    "LiveTick.observation.sources.alertmanager-alerts.state",
    "LiveTick.observation.sources.alertmanager-receivers.state",
    "LiveTick.observation.sources.alertmanager-silences.state",
    "LiveTick.observation.sources.alertmanager-status.state",
    "LiveTick.observation.sources.gatus-statuses.state",
    "LiveTick.observation.sources.grafana-health.state",
    "LiveTick.observation.sources.victoriametrics-buildinfo.state",
    "LiveTick.observation.sources.victoriametrics-signals.state",
    "LiveTick.observation.sources.victoriametrics-targets.state",
    "LiveTick.observation.sources.vmalert-rules.state",
    "OverviewSnapshotV2.coverage.availability.state",
    "OverviewSnapshotV2.engine.availability.state",
    "OverviewSnapshotV2.hosts[].rollupEvidence.availability.state",
    "OverviewSnapshotV2.hosts[].services[].statusEvidence.availability.state",
    "OverviewSnapshotV2.hosts[].statusEvidence.availability.state",
    "OverviewSnapshotV2.signals[].availability.state",
  ], { kind: "as-member", member: "unavailable" }),
  entry("bundle-error-kind", [
    "BundleErrorBody.kind",
  ], { kind: "display-rule", rule: "Show that the estate bundle failed to load." }),
  entry("channel-kind", [
    "EstatePayload.estate.channels[].kind",
  ], { kind: "display-rule", rule: "Show the kind as text." }),
  entry("collection-class", [
    "EstatePayload.coverage.value.covered[].collectionClass",
    "EstatePayload.coverage.value.gaps[].collectionClass",
    "EstatePayload.coverage.value.suppressed[].collectionClass",
    "EstatePayload.estate.hosts[].collectionClass",
    "OverviewSnapshotV2.hosts[].collectionClass",
  ], { kind: "display-rule", rule: "Show as a generic host." }),
  entry("command-output", [
    "EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].output",
  ], { kind: "display-rule", rule: "Show the name and command only." }),
  entry("coverage-kind", [
    "EstatePayload.coverage.value.covered[].kind",
    "EstatePayload.coverage.value.gaps[].kind",
    "EstatePayload.coverage.value.suppressed[].kind",
  ], { kind: "display-rule", rule: "Show as a generic covered target." }),
  entry("credential-kind", [
    "EstatePayload.estate.channels[].credential.kind",
    "EstatePayload.estate.hosts[](collectionClass=hypervisor-api).detail.credential.kind",
    "EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].credential.kind",
    "EstatePayload.estate.hosts[](collectionClass=nas-api).detail.credential.kind",
    "EstatePayload.estate.services[].deepHealthDetail.credential.kind",
  ], { kind: "display-rule", rule: "Show the display text only." }),
  entry("deadman-kind", [
    "EstatePayload.estate.estate.deadman.kind",
  ], { kind: "display-rule", rule: "Show as configured." }),
  entry("declared-scrape-health", [
    "EstatePayload.declaredVersusScraped.value[].health",
  ], { kind: "as-member", member: "unknown" }),
  entry("declared-scrape-state", [
    "EstatePayload.declaredVersusScraped.value[].state",
  ], { kind: "as-member", member: "unknown" }),
  entry("delivery-form", [
    "EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.deliveryForm",
  ], { kind: "display-rule", rule: "Show the value as text." }),
  entry("finding-code", [
    "EstatePayload.findings.value.findings[].code",
  ], { kind: "display-rule", rule: "Show the code as text." }),
  entry("finding-severity", [
    "EstatePayload.findings.value.findings[].severity",
  ], { kind: "as-member", member: "info" }),
  entry("health-state", [
    "EstatePayload.liveTargets[].state",
  ], { kind: "as-member", member: "unknown" }),
  entry("history-severity", [
    "IntervalHistoryPayload.lanes[].severity",
  ], { kind: "as-member", member: "unknown" }),
  entry("interval-state", [
    "EndpointHistoryPayload.incidents[].state",
    "IntervalHistoryPayload.lanes[].intervals[].state",
  ], { kind: "as-member", member: "failed" }),
  entry("overview-severity", [
    "OverviewSnapshotV2.alerts[].severity",
    "OverviewSnapshotV2.hosts[].activeAlerts[].severity",
    "OverviewSnapshotV2.hosts[].services[].activeAlerts[].severity",
  ], { kind: "display-rule", rule: "Display as the lowest severity, labelled unknown." }),
  entry("provenance", [
    "EndpointHistoryPayload.incidents[].provenance",
    "IntervalHistoryPayload.lanes[].intervals[].provenance",
  ], { kind: "display-rule", rule: "Show the value as text." }),
  entry("push-alert-status", [
    "PushPayload.pulse.alert.status",
  ], { kind: "as-member", member: "firing" }),
  entry("push-category", [
    "PushPayload.aps.category",
  ], { kind: "display-rule", rule: "Use the default category, with no actions." }),
  entry("push-environment", [
    "DeviceRegistrationRequest.environment",
    "DeviceRegistrationResponse.environment",
  ], { kind: "display-rule", rule: "In a response, treat the registration as needing a refresh. In a request, the server refuses the value with 400 INVALID_REQUEST." }),
  entry("push-interruption-level", [
    "PushPayload.aps.interruption-level",
  ], { kind: "as-member", member: "active" }),
  entry("push-kind", [
    "PushPayload.pulse.kind",
  ], { kind: "display-rule", rule: "Ignore the pulse object, show aps.alert as is, and open the home screen on tap." }),
  entry("push-severity", [
    "PushPayload.pulse.alert.severity",
    "PushPayload.pulse.summary.severity",
  ], { kind: "as-member", member: "unknown" }),
  entry("push-target-screen", [
    "PushPayload.pulse.target.screen",
  ], { kind: "as-member", member: "home" }),
  entry("query-id", [
    "HistoryPayload.queryId",
    "TimelinePayload.targets[].queryIds[]",
  ], { kind: "display-rule", rule: "Omit the chart." }),
  entry("range-id", [
    "EndpointHistoryPayload.range",
    "HistoryPayload.range",
    "IntervalHistoryPayload.range",
    "TimelinePayload.alertHistory.ranges[]",
    "TimelinePayload.targets[].ranges[]",
  ], { kind: "display-rule", rule: "Hide the range." }),
  entry("rule-health", [
    "AlertsPayload.rules[].health",
  ], { kind: "as-member", member: "unknown" }),
  entry("silence-state", [
    "AlertsPayload.silences[].state",
  ], { kind: "as-member", member: "expired" }),
  entry("source-id", [
    "AlertsPayload.alertmanager.source",
    "AlertsPayload.vmalert.source",
    "EstatePayload.coverage.availability.source",
    "EstatePayload.declaredVersusScraped.availability.source",
    "EstatePayload.findings.availability.source",
    "EstatePayload.liveTargets[].availability.source",
    "OverviewSnapshotV2.coverage.availability.source",
    "OverviewSnapshotV2.engine.availability.source",
    "OverviewSnapshotV2.hosts[].rollupEvidence.availability.source",
    "OverviewSnapshotV2.hosts[].services[].statusEvidence.availability.source",
    "OverviewSnapshotV2.hosts[].statusEvidence.availability.source",
    "OverviewSnapshotV2.signals[].availability.source",
  ], { kind: "display-rule", rule: "Show under 'other sources'." }),
  entry("suppression-class", [
    "EstatePayload.coverage.value.covered[].suppressed.class",
    "EstatePayload.coverage.value.gaps[].suppressed.class",
    "EstatePayload.coverage.value.suppressed[].suppressed.class",
    "EstatePayload.estate.hosts[].suppressed.class",
    "EstatePayload.estate.services[].suppressed.class",
    "EstatePayload.estate.suppressions[].class",
  ], { kind: "display-rule", rule: "Show as suppressed." }),
  entry("target-kind", [
    "AlertsPayload.alerts[].historyRef.target.kind",
    "AlertsPayload.alerts[].target.kind",
    "EndpointHistoryPayload.target.kind",
    "EstatePayload.liveTargets[].target.kind",
    "HistoryPayload.target.kind",
    "IntervalHistoryPayload.lanes[].target.kind",
    "IntervalHistoryPayload.target.kind",
    "OverviewSnapshotV2.alerts[].target.kind",
    "OverviewSnapshotV2.hosts[].activeAlerts[].target.kind",
    "OverviewSnapshotV2.hosts[].services[].activeAlerts[].target.kind",
    "OverviewSnapshotV2.recentChecks[].target.kind",
    "OverviewSnapshotV2.signals[].target.kind",
    "TimelinePayload.targets[].parent.kind",
    "TimelinePayload.targets[].target.kind",
  ], { kind: "display-rule", rule: "Show as a generic target with no drill-down." }),
  entry("target-status", [
    "OverviewSnapshotV2.hosts[].rollup",
    "OverviewSnapshotV2.hosts[].rollupEvidence.status",
    "OverviewSnapshotV2.hosts[].services[].status",
    "OverviewSnapshotV2.hosts[].services[].statusEvidence.status",
    "OverviewSnapshotV2.hosts[].status",
    "OverviewSnapshotV2.hosts[].statusEvidence.status",
  ], { kind: "as-member", member: "unknown" }),
  entry("unit", [
    "HistoryPayload.unit",
    "OverviewSnapshotV2.signals[].unit",
  ], { kind: "display-rule", rule: "Show the raw number with no unit." }),
  entry("view-id", [
    "LiveTick.identities",
  ], { kind: "display-rule", rule: "Ignore the key." }),
].sort((a, b) => byCodeUnit(a.group, b.group)));
