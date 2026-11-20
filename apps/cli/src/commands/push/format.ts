// apps/cli/src/commands/push/format.ts — pure text formatters for `pulse push` output: terminal-safe strings,
// compact instants, the devices table and the per-device test lines.

import { truncateUtf8 } from "@pulse/web-data/contract";
import type { DeviceSummary, PushTestResult } from "@pulse/web-data/wire";

import { CONTROL_CHARS_RE } from "../proposals/args.js";

/** Global copy of {@link CONTROL_CHARS_RE} (the source regex is not global), built once. */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS_RE.source, "gu");

/**
 * Make a server-supplied string safe to print: replace every C0, DEL, C1, bidi and format control with "?", then
 * truncate to `maxBytes` UTF-8 bytes. The server already restricts display names; this is defence in depth against a
 * hostile or buggy server.
 */
export function sanitiseForTerminal(value: string, maxBytes: number): string {
  return truncateUtf8(value.replace(CONTROL_CHARS_GLOBAL, "?"), maxBytes);
}

/** ISO-8601 → "YYYY-MM-DD HH:MMZ" (UTC, minute precision). An unparseable value prints as "?". */
export function formatInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "?";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "?";
  const text = date.toISOString();
  return `${text.slice(0, -14)} ${text.slice(-13, -8)}Z`;
}

const SEVERITIES = ["critical", "warning", "info"] as const;

function notifyCell(prefs: DeviceSummary["preferences"]): string {
  const on = SEVERITIES.filter((s) => prefs[s]);
  if (on.length === SEVERITIES.length) return "all";
  if (on.length === 0) return "none";
  return on.join(",");
}

function lastDeliveryCell(ld: DeviceSummary["lastDelivery"]): string {
  if (ld === null) return "-";
  const reason = ld.reason !== null ? ` (${sanitiseForTerminal(ld.reason, 64)})` : "";
  return `${ld.outcome} ${formatInstant(ld.at)}${reason}`;
}

const HEADER = ["ID", "NAME", "PAIRED", "SEEN", "ENV", "NOTIFY", "LAST DELIVERY"] as const;

function width(cell: string): number {
  return [...cell].length;
}

/**
 * Header plus one row per device. Columns are left-aligned, padded to their widest cell (by code points) and
 * separated by two spaces; the last column is not padded, so no line ends in spaces. Pure.
 */
export function formatDeviceTable(devices: readonly DeviceSummary[]): readonly string[] {
  const rows: string[][] = [
    [...HEADER],
    ...devices.map((d) => [
      sanitiseForTerminal(d.id, 64),
      sanitiseForTerminal(d.displayName, 64),
      formatInstant(d.pairedAt),
      formatInstant(d.seenAt),
      d.environment ?? "-",
      notifyCell(d.preferences),
      lastDeliveryCell(d.lastDelivery),
    ]),
  ];
  const widths = HEADER.map((_, col) => Math.max(...rows.map((row) => width(row[col] as string))));
  const last = HEADER.length - 1;
  return rows.map((row) =>
    row
      .map((cell, col) => (col === last ? cell : cell + " ".repeat((widths[col] as number) - width(cell))))
      .join("  "),
  );
}

/** One line per result: outcome padded to 13, the sanitised name, the device id and an optional reason. Pure. */
export function formatTestLines(results: PushTestResult["results"]): readonly string[] {
  return results.map((r) => {
    const reason = r.reason !== undefined ? `: ${sanitiseForTerminal(r.reason, 64)}` : "";
    return `${r.outcome.padEnd(13)}${sanitiseForTerminal(r.displayName, 64)} (${sanitiseForTerminal(r.deviceId, 64)})${reason}`;
  });
}
