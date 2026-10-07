// agent/command-exporter/src/run.ts
//
// Run ONE command signal and return its outcome (issue #3/#1). A signal's command is executed
// verbatim as argv (NO shell — the argv is the estate-declared command, run without interpolation),
// bounded by a timeout. Any failure — non-zero exit, timeout, spawn error (ENOENT), or (scalar)
// unparseable stdout — is DATA, returned as `{ ok: false }`, never thrown: the loop must never crash
// and a blind signal must report `_up = 0` rather than pretend healthy (fail-visibility).

import type { CommandSignalConfig } from "../../contract/types.js";

/** The result of running one signal's command this cycle. `value` (scalar) / `text` (exposition)
 *  are present only on `ok: true`; a failure carries neither. */
export interface SignalOutcome {
  ok: boolean;
  /** Parsed numeric value — scalar success only. */
  value?: number;
  /** Raw Prometheus-text stdout — exposition success only. */
  text?: string;
}

/**
 * Execute `signal.command` (argv, no shell) with a `timeoutMs` bound and interpret its output per
 * `signal.output`:
 *   - `scalar`     — stdout is trimmed and parsed as a finite number; a non-number ⇒ `{ ok: false }`.
 *   - `exposition` — stdout is returned verbatim as Prometheus text.
 * A non-zero exit, a timeout (killed), or a spawn failure all yield `{ ok: false }`. A `credential`
 * (SecretRef.raw) is injected as `PULSE_SIGNAL_CREDENTIAL` in the command's environment (never logged).
 *
 * @param signal - The command signal to run.
 * @param timeoutMs - Per-command timeout in milliseconds.
 * @returns The outcome; never throws.
 */
export async function runSignal(
  signal: CommandSignalConfig,
  timeoutMs: number,
): Promise<SignalOutcome> {
  try {
    const env =
      signal.credential !== undefined
        ? { ...process.env, PULSE_SIGNAL_CREDENTIAL: signal.credential }
        : process.env;
    const proc = Bun.spawn({
      cmd: signal.command,
      stdout: "pipe",
      stderr: "pipe",
      env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    // Read stdout fully, then await exit. A timeout kill resolves `exited` with a null code.
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false }; // non-zero exit or killed (timeout) → blind

    if (signal.output === "scalar") {
      const n = Number(stdout.trim());
      if (!Number.isFinite(n)) return { ok: false }; // stdout was not a number → blind
      return { ok: true, value: n };
    }
    return { ok: true, text: stdout };
  } catch {
    // Spawn failure (e.g. ENOENT — the command binary is not present in the container) → blind.
    return { ok: false };
  }
}
