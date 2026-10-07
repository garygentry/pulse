// agent/command-exporter/src/errors.ts
//
// The command-exporter error hierarchy (issue #3/#1), mirroring the prober's (00 §7). A base class
// with a stable string `code`; the config error is FATAL at startup (failed healthcheck). A command
// that fails at RUNTIME is DATA, not an error — it is recorded as `_up = 0` and never thrown
// (fail-visibility: never pretend healthy when blind).

/** Base error for the command-exporter. Carries a stable, machine-matchable `code`. */
export class CommandExporterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandExporterError";
    this.code = code;
    Object.setPrototypeOf(this, CommandExporterError.prototype);
  }
}

/** Malformed/unreadable mounted `command-exporter/config.yaml`. FATAL at startup: surfaced as a
 *  failed container healthcheck — NOT a silent stop. Distinct from an ABSENT config, which is a
 *  non-event (the exporter idles healthy, serving an empty exposition). */
export class CommandExporterConfigError extends CommandExporterError {
  /** The config path that failed to parse. */
  readonly configPath: string;
  constructor(configPath: string, message: string) {
    super("COMMAND_EXPORTER_CONFIG_INVALID", message);
    this.name = "CommandExporterConfigError";
    this.configPath = configPath;
    Object.setPrototypeOf(this, CommandExporterConfigError.prototype);
  }
}
