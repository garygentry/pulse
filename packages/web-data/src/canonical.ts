// packages/web-data/src/canonical.ts — deterministic canonical JSON encoding, SHA-256
// content identities, and deterministic gzip (04-cycle-and-current-view-folds.md §5).
// Server-side only (reachable through the `/cycle` barrel, never `/wire`): it uses
// `node:crypto` and `node:zlib`, which Bun and Node both provide. Canonicalization sorts
// object keys recursively, preserves fold-defined array order, and rejects any value that
// cannot round-trip deterministically (cycles, non-finite numbers, `undefined`, `bigint`,
// functions, symbols, and non-plain objects).

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { HashId } from "./wire/common.js";

/**
 * Thrown by {@link canonicalJson} when a value cannot be encoded deterministically. The
 * message is a fixed category string and never echoes the offending value, so callers can
 * classify the failure without leaking payload data.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const textEncoder = new TextEncoder();

/** Whether `value` is a plain object literal (its prototype is `Object.prototype` or null). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * Append the canonical JSON text for `value` to `out`. `stack` holds the objects/arrays on
 * the current path so a true reference cycle is rejected while shared (acyclic) references
 * remain legal. Object keys are sorted by UTF-16 code unit; array order is preserved.
 */
function encode(value: unknown, out: string[], stack: Set<object>): void {
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("Cannot canonicalize a non-finite number.");
      }
      // JSON.stringify renders finite numbers (including -0 as "0") deterministically.
      out.push(JSON.stringify(value));
      return;
    case "undefined":
      throw new CanonicalJsonError("Cannot canonicalize undefined.");
    case "bigint":
      throw new CanonicalJsonError("Cannot canonicalize a bigint.");
    case "function":
      throw new CanonicalJsonError("Cannot canonicalize a function.");
    case "symbol":
      throw new CanonicalJsonError("Cannot canonicalize a symbol.");
    case "object":
      break;
    default:
      throw new CanonicalJsonError("Cannot canonicalize an unsupported value.");
  }

  if (value === null) {
    out.push("null");
    return;
  }

  const container = value as object;
  if (stack.has(container)) {
    throw new CanonicalJsonError("Cannot canonicalize a circular reference.");
  }
  stack.add(container);

  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      encode(value[i], out, stack);
    }
    out.push("]");
  } else {
    if (!isPlainObject(container)) {
      throw new CanonicalJsonError("Cannot canonicalize a non-plain object.");
    }
    const record = container as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.push("{");
    let written = 0;
    for (const key of keys) {
      const entry = record[key];
      // Own keys explicitly set to `undefined` are unsupported values, not silently dropped.
      if (entry === undefined) {
        throw new CanonicalJsonError("Cannot canonicalize an undefined property value.");
      }
      if (written > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      encode(entry, out, stack);
      written += 1;
    }
    out.push("}");
  }

  stack.delete(container);
}

/**
 * Encode `value` to deterministic canonical JSON UTF-8 bytes: object keys sorted
 * recursively, array order preserved. Throws {@link CanonicalJsonError} for cycles,
 * non-finite numbers, `undefined`, `bigint`, functions, symbols, and non-plain objects.
 */
export function canonicalJson(value: unknown): Uint8Array {
  const out: string[] = [];
  encode(value, out, new Set<object>());
  return textEncoder.encode(out.join(""));
}

/** Compute the strong `sha256:<hex>` content identity of the exact `bytes`. */
export async function sha256Id(bytes: Uint8Array): Promise<HashId> {
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Deterministically gzip `bytes`. `node:zlib` writes a zeroed mtime and fixed OS byte, so
 * identical input always yields identical output suitable for a strong representation ETag.
 */
export async function deterministicGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gzipSync(bytes, { level: 9 }));
}
