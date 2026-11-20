// apps/cli/src/commands/push/args.ts — the `pulse push …` tail parser.
// Deliberately does NOT import ../../args.js (that would be an import cycle): it returns `{ ok: false }`
// instead of throwing UsageError and receives GLOBAL_OPTIONS as a parameter.

import { parseArgs } from "node:util";

import { DEVICE_ID_PATTERN } from "@pulse/web-data/contract";

import type { OptionBag } from "../proposals/args.js";
import { parseInsecureLocalBase } from "./server.js";

/** The four sub-verbs. */
export const PUSH_SUBVERBS = ["pair", "devices", "revoke", "test"] as const;
/** One of the `pulse push` sub-verbs. */
export type PushSubverb = (typeof PUSH_SUBVERBS)[number];

/** Parsed push invocation, discriminated by sub-verb. `server` is raw (not normalised). */
export type PushInvocation =
  | { readonly sub: "pair"; readonly server: string | null; readonly insecureLocal: boolean }
  | { readonly sub: "devices"; readonly server: string | null; readonly insecureLocal: boolean }
  | { readonly sub: "revoke"; readonly id: string; readonly server: string | null; readonly insecureLocal: boolean }
  | {
      readonly sub: "test";
      readonly device: string | null;
      readonly server: string | null;
      readonly insecureLocal: boolean;
    };

/** Parsed option values (the parseArgs `values` bag). */
export type PushOptionValues = Record<string, string | boolean | undefined>;

/** Result of {@link parsePushArgs}. `ok: false` becomes a UsageError (exit 2) in args.ts. */
export type PushArgsResult =
  | { readonly ok: true; readonly version: true; readonly values: PushOptionValues }
  | {
      readonly ok: true;
      readonly version: false;
      readonly values: PushOptionValues;
      readonly invocation: PushInvocation;
    }
  | { readonly ok: false; readonly message: string };

const ID_SHAPE = "(expected dev_ followed by 11 base64url characters)";

function isSubverb(s: string): s is PushSubverb {
  return (PUSH_SUBVERBS as readonly string[]).includes(s);
}

/**
 * Parse the argv tail of `pulse push …`, with the verb token already removed. It uses its own option bag
 * (global options plus `--server`, `--device`, `--insecure-local`) with `allowPositionals: true`.
 *
 * @param tokens - argv minus the `push` token, in the original order.
 * @param globalOptions - args.ts `GLOBAL_OPTIONS`, passed in to avoid an import cycle.
 * @returns The invocation, a `--version` short-circuit, or a usage message. Never throws.
 */
export function parsePushArgs(tokens: readonly string[], globalOptions: OptionBag): PushArgsResult {
  const options: OptionBag = {
    ...globalOptions,
    server: { type: "string" },
    "insecure-local": { type: "boolean", default: false },
    device: { type: "string" },
  };
  let values: PushOptionValues;
  let positionals: string[];
  try {
    const r = parseArgs({ args: [...tokens], options, strict: true, allowPositionals: true });
    values = r.values as PushOptionValues;
    positionals = r.positionals;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (values.version === true) return { ok: true, version: true, values };

  const [sub, arg, ...extra] = positionals;
  if (sub === undefined) {
    return { ok: false, message: `push: missing sub-command (expected one of: ${PUSH_SUBVERBS.join(", ")})` };
  }
  if (!isSubverb(sub)) return { ok: false, message: `push: unknown sub-command ${JSON.stringify(sub)}` };
  if (sub !== "revoke" && arg !== undefined) {
    return { ok: false, message: `push ${sub}: unexpected argument ${JSON.stringify(arg)}` };
  }
  if (extra.length > 0) {
    return { ok: false, message: `push ${sub}: unexpected argument ${JSON.stringify(extra[0])}` };
  }

  const device = typeof values.device === "string" ? values.device : undefined;
  if (device !== undefined && sub !== "test") return { ok: false, message: "--device is only valid for 'push test'" };

  if (sub === "revoke") {
    if (arg === undefined) return { ok: false, message: "push revoke: missing <id>" };
    if (!DEVICE_ID_PATTERN.test(arg)) {
      return { ok: false, message: `push revoke: malformed device id ${JSON.stringify(arg)} ${ID_SHAPE}` };
    }
  }
  if (sub === "test" && device !== undefined && !DEVICE_ID_PATTERN.test(device)) {
    return { ok: false, message: `push test: malformed --device id ${JSON.stringify(device)} ${ID_SHAPE}` };
  }

  // No message below echoes the --server value: it may carry credentials.
  const server = typeof values.server === "string" ? values.server : undefined;
  if (server !== undefined && server.trim() === "") return { ok: false, message: "--server needs an https address" };

  const insecureLocal = values["insecure-local"] === true;
  if (insecureLocal) {
    if (server === undefined) {
      return {
        ok: false,
        message: "--insecure-local requires --server http://127.0.0.1:<port> or http://localhost:<port>",
      };
    }
    if (!parseInsecureLocalBase(server).ok) {
      return { ok: false, message: "--insecure-local accepts only http://127.0.0.1:<port> or http://localhost:<port>" };
    }
  }

  const common = { server: server ?? null, insecureLocal };
  let invocation: PushInvocation;
  switch (sub) {
    case "revoke":
      invocation = { sub, id: arg as string, ...common };
      break;
    case "test":
      invocation = { sub, device: device ?? null, ...common };
      break;
    default:
      invocation = { sub, ...common };
  }
  return { ok: true, version: false, values, invocation };
}
