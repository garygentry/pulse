// A throwaway self-signed P-256 certificate for 127.0.0.1/localhost, generated per process with openssl. The PEMs
// live in memory only: the temp directory openssl writes into is removed before this returns, and nothing is
// committed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A per-suite self-signed P-256 certificate for 127.0.0.1/localhost. Never committed. */
export interface TestTls {
  /** Certificate PEM. */
  readonly cert: string;
  /** Private key PEM, in memory only; the temp files are deleted before returning. */
  readonly key: string;
}

/** The exact refusal raised under CI when openssl is unavailable. */
export const OPENSSL_REQUIRED_MESSAGE = "openssl is required for the push test suites (S-12)";

/** Prefix of the temp directory openssl writes into (exported so a test can prove none is left behind). */
export const TLS_TEMP_PREFIX = "pulse-push-tls-";

/** Inputs of {@link buildTestTls}: the openssl binary (null when absent) and whether this is a CI run. */
export interface BuildTestTlsOptions {
  readonly openssl: string | null;
  readonly ci: boolean;
}

/**
 * Generate a certificate without memoisation. A missing openssl throws {@link OPENSSL_REQUIRED_MESSAGE} under CI and
 * returns null otherwise. openssl present but failing always throws (a broken toolchain must not silently skip).
 */
export function buildTestTls(opts: BuildTestTlsOptions): TestTls | null {
  if (opts.openssl === null) {
    if (opts.ci) throw new Error(OPENSSL_REQUIRED_MESSAGE);
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), TLS_TEMP_PREFIX));
  try {
    const keyPath = join(dir, "k.pem");
    const certPath = join(dir, "c.pem");
    const result = Bun.spawnSync(
      [
        opts.openssl,
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(`openssl failed (exit ${String(result.exitCode)}): ${result.stderr.toString().trim()}`);
    }
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let memo: { readonly value: TestTls | null } | undefined;

/**
 * The process-wide throwaway certificate. Under `CI=true` a missing openssl throws; locally it returns null and
 * callers use `describe.skipIf(tls === null)` with the reason in the title.
 */
export function createTestTls(): TestTls | null {
  if (memo === undefined) {
    memo = { value: buildTestTls({ openssl: Bun.which("openssl"), ci: process.env.CI === "true" }) };
  }
  return memo.value;
}
