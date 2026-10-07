/**
 * `formatFindings` — stable human rendering (05-findings.md §7). A pure function of its input
 * array: renders in the order given, performs no sorting, no I/O, and no clock/PID/env reads
 * (REQ-DET-01, REQ-OBS-01). Callers pass `collector.drain()`, already sorted.
 */
import type { Finding } from "./index.js";

/**
 * Render findings as stable, human-readable text. Returns `""` for an empty array. Never
 * throws. One two-line block per finding:
 *
 *   <severity padded to 7><file>[:<path>] [<code>] <message>
 *          fix: <fix>
 *
 * (When `path` is empty — a file/estate-level finding — the `:<path>` segment is omitted.)
 * Blocks are joined by "\n".
 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => {
      const loc = f.path.length > 0 ? `${f.file}:${f.path}` : f.file;
      const head = `${f.severity.padEnd(7)}${loc} [${f.code}] ${f.message}`;
      const fixLine = `${" ".repeat(7)}fix: ${f.fix}`;
      return `${head}\n${fixLine}`;
    })
    .join("\n");
}
