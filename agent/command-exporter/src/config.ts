// agent/command-exporter/src/config.ts
//
// Load, parse, and narrow the mounted `command-exporter/config.yaml` into the command signals the
// exporter runs (issue #3/#1), mirroring the prober's config loader (02 §3.1). Three load states:
//   - ABSENT file (ENOENT)        → `[]` — a non-event; the exporter idles healthy.
//   - MALFORMED / unreadable file → `CommandExporterConfigError` — FATAL at startup.
//   - WELL-FORMED file            → narrow each `{ signals: [...] }` entry to a CommandSignalConfig.
//
// This is the ONLY parser of the rendered config; a `credential` crosses as `SecretRef.raw` only
// (never resolved here — the exporter injects it into the command's env at run time).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml"; // yaml@2.9.0 — pinned, matches renderer (format.ts)
import type { CommandSignalConfig } from "../../contract/types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../../contract/constants.js";
import { CommandExporterConfigError } from "./errors.js";

/** Absolute path of the mounted command-exporter config, from `PULSE_RENDERED_DIR` or the compose
 *  default mount `/rendered/command-exporter/config.yaml`. */
export const CONFIG_PATH: string = join(
  process.env.PULSE_RENDERED_DIR ?? "/rendered",
  "command-exporter",
  "config.yaml",
);

/**
 * Load, parse, and narrow the mounted `command-exporter/config.yaml` into the command signals this
 * exporter runs.
 *
 * - ABSENT file (ENOENT) → `[]` (non-event; the exporter idles healthy).
 * - MALFORMED file (unreadable, unparseable YAML, wrong top-level shape, or a structurally invalid
 *   signal) → throws {@link CommandExporterConfigError} (FATAL at startup → failed healthcheck).
 *
 * @param path - The config path; defaults to {@link CONFIG_PATH}.
 * @returns The narrowed command-signal set (possibly empty).
 */
export async function loadCommandExporterConfig(
  path: string = CONFIG_PATH,
): Promise<CommandSignalConfig[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // ABSENT — non-event
    throw new CommandExporterConfigError(
      path,
      `unreadable command-exporter config: ${(err as Error).message}`,
    );
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new CommandExporterConfigError(path, `malformed YAML: ${(err as Error).message}`);
  }
  return narrowSignals(doc, path);
}

/**
 * Validate the parsed document as `{ signals: CommandSignalConfig[] }` and narrow each entry. Unlike
 * the prober (which silently drops foreign kinds from a shared file), this file is command-exporter-
 * owned: every entry MUST be a valid signal, so a structurally invalid one is a fatal config error.
 *
 * @throws {CommandExporterConfigError} If `doc` is not `{ signals: array }`, or any entry is invalid.
 */
export function narrowSignals(doc: unknown, path: string): CommandSignalConfig[] {
  if (!isRecord(doc) || !Array.isArray(doc.signals)) {
    throw new CommandExporterConfigError(
      path,
      `expected top-level { signals: [] }, got ${describe(doc)}`,
    );
  }
  return doc.signals.map((entry, i) => narrowSignal(entry, i, path));
}

/** Narrow one entry to a {@link CommandSignalConfig}, validating the fields the exporter relies on. */
function narrowSignal(entry: unknown, i: number, path: string): CommandSignalConfig {
  const where = `signals[${i}]`;
  if (!isRecord(entry)) {
    throw new CommandExporterConfigError(path, `${where} is not an object`);
  }
  const name = entry.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new CommandExporterConfigError(path, `${where} has an invalid name`);
  }
  if (
    !Array.isArray(entry.command) ||
    entry.command.length === 0 ||
    !entry.command.every((a) => typeof a === "string" && a.length > 0)
  ) {
    throw new CommandExporterConfigError(path, `signal "${name}" has an invalid command`);
  }
  const intervalMs = entry.intervalMs;
  if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new CommandExporterConfigError(path, `signal "${name}" has an invalid intervalMs`);
  }
  const command = entry.command as string[];
  const credential =
    typeof entry.credential === "string" && entry.credential.length > 0
      ? { credential: entry.credential }
      : {};

  if (entry.output === "scalar") {
    if (typeof entry.metric !== "string" || entry.metric.length === 0) {
      throw new CommandExporterConfigError(path, `scalar signal "${name}" has no metric`);
    }
    if (typeof entry.up_metric !== "string" && typeof entry.upMetric !== "string") {
      throw new CommandExporterConfigError(path, `scalar signal "${name}" has no upMetric`);
    }
    // The renderer emits `upMetric`; tolerate `up_metric` defensively (same series).
    const upMetric = (entry.upMetric ?? entry.up_metric) as string;
    const labels = isRecord(entry.labels)
      ? { labels: entry.labels as Record<string, string> }
      : {};
    return { output: "scalar", name, command, intervalMs, metric: entry.metric, upMetric, ...labels, ...credential };
  }
  if (entry.output === "exposition") {
    return { output: "exposition", name, command, intervalMs, ...credential };
  }
  throw new CommandExporterConfigError(
    path,
    `signal "${name}" has an unknown output ${JSON.stringify(entry.output)} (expected "scalar" | "exposition")`,
  );
}

/** Command-exporter per-command timeout, from `PULSE_COMMAND_TIMEOUT_MS` (positive int) or default. */
export function loadTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PULSE_COMMAND_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommandExporterConfigError(
      "<environment>",
      `PULSE_COMMAND_TIMEOUT_MS must be a positive integer`,
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
