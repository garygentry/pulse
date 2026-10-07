// packages/renderer/src/render/command-exporter.ts — per-host command-exporter config (issue #3/#1).
//
// Emits one `command-exporter/<host>.yaml` for every managed-linux host that runs ≥1 command signal
// — either an explicit host `commandSignals` entry OR a synthesized scalar signal for a service whose
// `backupFreshness` declares a `command` (the newest-backup age probe). The exporter (agent/) reads
// this file and runs each command on its cadence, publishing the output on COMMAND_EXPORTER_PORT
// (9130). Like every emitter this is PURE + DETERMINISTIC and emits NO file for a host with no
// signals. Any `credential` flows through the shared `renderSecretRef` choke point (02 §7): a valid
// SecretRef emits only its raw reference; a literal is REFUSED (SECRET_LITERAL finding, field omitted).
import type { EstateModel, CommandSignal } from "@pulse/core";

import { compareString } from "../order.js";
import { toCanonicalYaml } from "../format.js";
import type { EmitResult } from "./emit-result.js";
import { renderSecretRef } from "./secrets.js";
import type { CredentialSite } from "./secrets.js";

/** Series names for the delivered backup-freshness contract (match stack/alerting's selectors). */
const BACKUP_AGE_METRIC = "pulse_backup_freshness_age_seconds";
const BACKUP_UP_METRIC = "pulse_backup_freshness_up";
/** Default backup check cadence when the service omits `interval`. Shared with the web model's
 *  `backupFreshness.interval` default (02 §5.3) so both stay in lockstep. */
export const DEFAULT_BACKUP_INTERVAL = "15m";
/** Reserved name prefix for synthesized backup signals (service names are estate-unique). */
const BACKUP_SIGNAL_PREFIX = "backup:";

/** One signal entry in a rendered `command-exporter/<host>.yaml`. `intervalMs` is the parsed cadence
 *  so the exporter stays a dumb `setInterval` consumer; `credential` is a reference string only. */
interface RenderedSignal {
  name: string;
  command: string[];
  intervalMs: number;
  output: "scalar" | "exposition";
  metric?: string;
  upMetric?: string;
  labels?: Record<string, string>;
  credential?: string;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * Parse a Prometheus-style duration (`"30s"`, `"15m"`, `"1d12h"`) to whole milliseconds. Core's
 * `durationStringSchema` already validated the format at load, so a well-formed model always parses;
 * the `?? 0` fallback is an unreachable defensive floor (never emitted for a validated estate).
 */
function durationToMs(input: string): number {
  const re = /(\d+)(y|w|d|h|m|s)/g;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    total += Number(match[1]) * (UNIT_MS[match[2]!] ?? 0);
  }
  return total;
}

/** Render one model `CommandSignal` to its wire entry, routing any credential through the choke
 *  point. `file`/`path` build a precise SECRET_LITERAL site if a literal ever reaches the slot. */
function renderSignal(
  signal: CommandSignal,
  file: string,
  findings: EmitResult["findings"],
): RenderedSignal {
  const entry: RenderedSignal = {
    name: signal.name,
    command: signal.command,
    intervalMs: durationToMs(signal.interval),
    output: signal.output,
  };
  if (signal.output === "scalar") {
    entry.metric = signal.metric;
    entry.upMetric = signal.upMetric;
    if (signal.labels !== undefined) entry.labels = signal.labels;
  }
  if (signal.credential !== undefined) {
    const site: CredentialSite = { file, path: `${signal.name}.credential` };
    const secret = renderSecretRef(signal.credential, site);
    if (secret.ok) entry.credential = secret.ref;
    else findings.push(secret.finding); // omit the key; never emit a literal (02 §7).
  }
  return entry;
}

/**
 * Emit `command-exporter/<host>.yaml` (`{ signals: RenderedSignal[] }`) per managed-linux host that
 * runs ≥1 command signal (REQ-RND-01). Explicit `host.commandSignals` render verbatim; a service
 * with `backupFreshness.command` synthesizes a scalar signal named `backup:<service>` emitting
 * `pulse_backup_freshness_age_seconds{service}` + `pulse_backup_freshness_up{service}` on the
 * service's host (host-class guaranteed managed-linux by checkBackupCommandHost). Signals are sorted
 * by name and hosts by file path for determinism. No signals anywhere → no file.
 *
 * @param model - The validated estate.
 * @returns One `RenderedFile` per host with signals, plus any secret-refusal findings.
 */
export function emitCommandExporter(model: EstateModel): EmitResult {
  const findings: EmitResult["findings"] = [];
  // hostName → rendered signal entries (explicit + synthesized), in declaration order pre-sort.
  const byHost = new Map<string, RenderedSignal[]>();

  const push = (host: string, entry: RenderedSignal): void => {
    const list = byHost.get(host);
    if (list === undefined) byHost.set(host, [entry]);
    else list.push(entry);
  };

  // (1) Explicit host command signals (managed-linux arm only carries the field).
  for (const host of model.hosts) {
    if (host.collectionClass !== "managed-linux") continue;
    const file = `command-exporter/${host.name}.yaml`;
    for (const signal of host.commandSignals) {
      push(host.name, renderSignal(signal, file, findings));
    }
  }

  // (2) Synthesized backup-freshness scalar signals — one per service that declares a command.
  for (const service of model.services) {
    const backup = service.backupFreshness;
    if (backup?.command === undefined) continue;
    push(service.host, {
      name: `${BACKUP_SIGNAL_PREFIX}${service.name}`,
      command: backup.command,
      intervalMs: durationToMs(backup.interval ?? DEFAULT_BACKUP_INTERVAL),
      output: "scalar",
      metric: BACKUP_AGE_METRIC,
      upMetric: BACKUP_UP_METRIC,
      labels: { service: service.name },
    });
  }

  if (byHost.size === 0) return { files: [], findings }; // no command signals anywhere → no file.

  const files: EmitResult["files"] = [];
  for (const [host, signals] of byHost) {
    signals.sort((a, b) => compareString(a.name, b.name));
    files.push({
      path: `command-exporter/${host}.yaml`,
      contents: toCanonicalYaml({ signals }),
    });
  }
  // The pipeline's final path-sort is authoritative; sort here too so the fragment is self-consistent.
  files.sort((a, b) => compareString(a.path, b.path));
  return { files, findings };
}
