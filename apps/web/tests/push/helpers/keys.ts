// Per-run APNs provider keys for the push suites. Keys are generated in memory; none is ever committed.

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A throwaway P-256 provider key. */
export interface TestApnsKey {
  /** PKCS#8 PEM of the private key (what a `.p8` file holds). */
  readonly pem: string;
  /** The matching public key, for signature verification. */
  readonly publicKey: KeyObject;
}

/** Generate a fresh P-256 PKCS#8 key. */
export function createTestApnsKey(): TestApnsKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { pem: privateKey, publicKey };
}

/** Generate a key and write it as `AuthKey_TEST.p8` (mode 0600) into `dir` (a suite temp directory). */
export function writeTestKeyFile(dir: string, name = "AuthKey_TEST.p8"): TestApnsKey & { readonly path: string } {
  const key = createTestApnsKey();
  const path = join(dir, name);
  writeFileSync(path, key.pem, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ...key, path };
}
