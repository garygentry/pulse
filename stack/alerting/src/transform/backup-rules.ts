// stack/alerting/src/transform/backup-rules.ts
// The backup-freshness rule family (03 §5, REQ-BACKUP-01..03, REQ-RULE-05).
//
// ⚠ Designed against the REQUIRED-but-UNDELIVERED metric contract in 00 §7
// (`pulse_backup_freshness_age_seconds`/`_up`). The renderer emits `kind: "backup-freshness"`
// entries even though the runtime prober drops them, so the per-service `threshold` is available
// here. The builder + its unit/golden tests are implementable now; only the promtool integration
// against a live series is gated (item 014). Reads NO secret field (`ProberEntry.credential` is
// ignored — REQ-SEC-01).
import { METRICS, RUNBOOK_SLUGS, runbookUrl } from "../constants.js";
import type { ProberConfigRendered, ProberEntry } from "./rendered.js";
import type { AlertingFinding } from "./findings.js";
import { serializeRuleGroups, type AlertRuleYaml } from "./rules-yaml.js";

const GROUP = "backup-freshness";
/** Runbook link shared by every backup-freshness rule (issue #16). */
const BACKUP_RUNBOOK = runbookUrl(RUNBOOK_SLUGS.backupFreshness);
/** NoData grace: must exceed the (infrequent) backup eval cadence so a single missed scrape does
 *  not flap. Module-local (per-family window, §4.3 rationale). REQ-RULE-05. */
const NODATA_FOR = "15m";

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

/**
 * Parse a Prometheus-style duration (`"24h"`, `"1d12h"`, `"90m"`, `"86400s"`) to whole seconds.
 * Supports concatenated unit groups; returns `null` for any malformed input.
 */
export function parseDurationSeconds(input: string | undefined): number | null {
  if (!input) return null;
  const re = /(\d+)(y|w|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    total += Number(match[1]) * UNIT_SECONDS[match[2]!]!;
    consumed += match[0].length;
  }
  return consumed === input.length && consumed > 0 ? total : null;
}

/** `svc:<host>/<service>#backup` → `{host, service}`, or `null`. */
export function parseBackupName(name: string): { host: string; service: string } | null {
  const m = /^svc:([^/]+)\/(.+)#backup$/.exec(name);
  return m ? { host: m[1]!, service: m[2]! } : null;
}

/**
 * Build the backup-freshness rule family for one estate's rendered prober config.
 * Filters `kind: "backup-freshness"` entries, sorts by name (determinism — §3.1), and per entry
 * emits `BackupStale` (warning, `> threshold`), `BackupCritical` (critical, `> 2× threshold`),
 * and `BackupNoData` (warning, `== 0 or absent(…)`, `for: 15m`). Malformed entries push
 * `INVALID_RULE` findings (bad name or unparseable threshold) and are skipped.
 */
export function buildBackupRules(
  prober: ProberConfigRendered,
  findings: AlertingFinding[],
): string {
  const entries: ProberEntry[] = prober.probes
    .filter((p) => p.kind === "backup-freshness")
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // determinism (§3.1)

  const rules: AlertRuleYaml[] = [];
  for (const entry of entries) {
    const parsed = parseBackupName(entry.name);
    if (!parsed) {
      findings.push({
        severity: "error",
        code: "INVALID_RULE",
        file: "rendered/prober/config.yaml",
        path: `probes[name=${entry.name}]`,
        message: `Backup probe entry name '${entry.name}' is not of the form svc:<host>/<service>#backup.`,
        fix: "Re-render the prober config; do not hand-edit probe entry names.",
      });
      continue;
    }
    const seconds = parseDurationSeconds(entry.threshold);
    if (seconds === null) {
      findings.push({
        severity: "error",
        code: "INVALID_RULE",
        file: "rendered/prober/config.yaml",
        path: `probes[name=${entry.name}].threshold`,
        message: `Backup threshold '${entry.threshold ?? ""}' for service '${parsed.service}' is not a valid duration.`,
        fix: `Set backupFreshness.threshold on service '${parsed.service}' to a duration like "24h", then re-render.`,
      });
      continue;
    }
    const sel = `{service="${parsed.service}"}`;
    rules.push({
      alert: "BackupStale",
      expr: `${METRICS.backupAgeSeconds}${sel} > ${seconds}`,
      labels: { severity: "warning" },
      annotations: {
        summary: "Backup for {{ $labels.service }} is stale",
        description:
          "Last successful backup for service {{ $labels.service }} on host {{ $labels.host }} " +
          `is older than its declared threshold (${entry.threshold}).`,
        runbook_url: BACKUP_RUNBOOK,
      },
    });
    rules.push({
      alert: "BackupCritical",
      expr: `${METRICS.backupAgeSeconds}${sel} > ${seconds * 2}`,
      labels: { severity: "critical" },
      annotations: {
        summary: "Backup for {{ $labels.service }} is critically stale",
        description:
          "Last successful backup for service {{ $labels.service }} on host {{ $labels.host }} " +
          `is older than twice its declared threshold (${entry.threshold}).`,
        runbook_url: BACKUP_RUNBOOK,
      },
    });
    rules.push({
      alert: "BackupNoData",
      expr: `${METRICS.backupUp}${sel} == 0 or absent(${METRICS.backupUp}${sel})`,
      for: NODATA_FOR,
      labels: { severity: "warning" },
      annotations: {
        summary: "Backup freshness signal missing for {{ $labels.service }}",
        description:
          "No readable backup-freshness signal for service {{ $labels.service }} on host " +
          "{{ $labels.host }}. Missing data is NOT treated as a healthy backup (REQ-BACKUP-03).",
        runbook_url: BACKUP_RUNBOOK,
      },
    });
  }
  return serializeRuleGroups([{ name: GROUP, rules }]);
}
