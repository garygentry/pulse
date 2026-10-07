// apps/cli/src/commands/proposals/args.ts — the `pulse proposals …` tail parser.
// Deliberately does NOT import ../../args.js (that would be an import cycle): it returns `{ ok: false }`
// instead of throwing UsageError and receives GLOBAL_OPTIONS as a parameter.

import { parseArgs } from "node:util";

import {
  PROPOSAL_ID_RE,
  PROPOSAL_REJECT_REASON_MIN_CHARS,
  PROPOSAL_REJECT_REASON_MAX_CHARS,
} from "@pulse/core/proposals";
import type { ProposalState } from "@pulse/core/proposals";

/** The four sub-verbs (REQ-PROP-07). */
export const PROPOSALS_SUBVERBS = ["list", "show", "apply", "reject"] as const;
/** One of the `pulse proposals` sub-verbs. */
export type ProposalsSubVerb = (typeof PROPOSALS_SUBVERBS)[number];

/**
 * C0, DEL, C1, and the bidi/format controls (REQ-SEC-07). Core's free-text CONTROL_EXCEPT_LF_RE refuses
 * the same set except LF; `--reason` is single-line. Shared with commit-message.ts.
 */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Fields common to every sub-verb invocation. */
interface ProposalsCommon {
  /** `--proposals-dir`, when passed (highest precedence in resolveConfig). */
  readonly proposalsDirFlag?: string;
}
/** The parsed proposals tail, discriminated by sub-verb. */
export type ProposalsInvocation =
  | (ProposalsCommon & { readonly sub: "list"; readonly state: ProposalState | null })
  | (ProposalsCommon & { readonly sub: "show"; readonly id: string })
  | (ProposalsCommon & { readonly sub: "apply"; readonly id: string; readonly overlay: string | null })
  | (ProposalsCommon & { readonly sub: "reject"; readonly id: string; readonly reason: string });

/** A parseArgs option bag (the shape of args.ts GLOBAL_OPTIONS). */
export type OptionBag = Record<string, { type: "boolean" | "string"; default?: boolean | string }>;

/** Result of {@link parseProposalsArgs}; `ok: false` is turned into a UsageError by args.ts. */
export type ProposalsArgsResult =
  | { readonly ok: true; readonly version: true; readonly values: Record<string, string | boolean | undefined> }
  | {
      readonly ok: true;
      readonly version: false;
      readonly values: Record<string, string | boolean | undefined>;
      readonly invocation: ProposalsInvocation;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Parse the argv tail of `pulse proposals …` (the verb token already removed). Uses its OWN options
 * bag with `allowPositionals: true`; every other verb keeps `allowPositionals: false`.
 *
 * @param tokens - argv minus the `proposals` token, original order preserved.
 * @param globalOptions - args.ts `GLOBAL_OPTIONS` (passed in to avoid an import cycle).
 * @returns Parsed invocation, a `--version` short-circuit, or a usage message. Never throws.
 */
export function parseProposalsArgs(tokens: readonly string[], globalOptions: OptionBag): ProposalsArgsResult {
  const options: OptionBag = {
    ...globalOptions,
    state: { type: "string" },
    overlay: { type: "string" },
    reason: { type: "string" },
    "proposals-dir": { type: "string" },
  };
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const r = parseArgs({ args: [...tokens], options, strict: true, allowPositionals: true });
    values = r.values as Record<string, string | boolean | undefined>;
    positionals = r.positionals;
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (values.version === true) return { ok: true, version: true, values };

  const [sub, id, ...extra] = positionals;
  if (sub === undefined) {
    return fail(`proposals: missing sub-command (expected one of: ${PROPOSALS_SUBVERBS.join(", ")})`);
  }
  if (!(PROPOSALS_SUBVERBS as readonly string[]).includes(sub)) {
    return fail(`proposals: unknown sub-command ${JSON.stringify(sub)}`);
  }
  if (extra.length > 0) return fail(`proposals ${sub}: unexpected argument ${JSON.stringify(extra[0])}`);

  const onlyFor = (flag: "state" | "overlay" | "reason", verb: ProposalsSubVerb): string | null =>
    values[flag] !== undefined && sub !== verb ? `--${flag} is only valid for 'proposals ${verb}'` : null;
  const misuse = onlyFor("state", "list") ?? onlyFor("overlay", "apply") ?? onlyFor("reason", "reject");
  if (misuse !== null) return fail(misuse);

  const common: ProposalsCommon =
    typeof values["proposals-dir"] === "string" ? { proposalsDirFlag: values["proposals-dir"] } : {};

  if (sub === "list") {
    if (id !== undefined) return fail(`proposals list: unexpected argument ${JSON.stringify(id)}`);
    const state = values.state;
    if (state !== undefined && state !== "pending" && state !== "applied" && state !== "rejected") {
      return fail(`--state must be one of pending, applied, rejected (got ${JSON.stringify(state)})`);
    }
    return ok(values, { ...common, sub: "list", state: (state as ProposalState | undefined) ?? null });
  }

  if (id === undefined) return fail(`proposals ${sub}: missing <id>`);
  if (!PROPOSAL_ID_RE.test(id)) {
    return fail(
      `proposals ${sub}: malformed proposal id ${JSON.stringify(id)} (expected p-YYYYMMDDTHHMMSSZ-<8 hex>)`,
    );
  }

  switch (sub) {
    case "show":
      return ok(values, { ...common, sub: "show", id });
    case "apply":
      return ok(values, {
        ...common,
        sub: "apply",
        id,
        overlay: typeof values.overlay === "string" ? values.overlay : null,
      });
    case "reject": {
      const reason = validateRejectReason(values.reason);
      return typeof reason === "string" ? ok(values, { ...common, sub: "reject", id, reason }) : reason;
    }
    default:
      return fail(`proposals: unknown sub-command ${JSON.stringify(sub)}`);
  }
}

/**
 * Validate `--reason` (REQ-PROP-09, REQ-SEC-07): required; trimmed length 10–500 code points; no
 * control characters (rejected at input, never silently neutralized).
 */
export function validateRejectReason(raw: string | boolean | undefined): string | { ok: false; message: string } {
  if (typeof raw !== "string") return fail('proposals reject: --reason "<10–500 chars>" is required');
  const reason = raw.trim();
  const len = [...reason].length;
  if (len < PROPOSAL_REJECT_REASON_MIN_CHARS || len > PROPOSAL_REJECT_REASON_MAX_CHARS) {
    return fail(
      `proposals reject: --reason must be ${PROPOSAL_REJECT_REASON_MIN_CHARS}–${PROPOSAL_REJECT_REASON_MAX_CHARS} characters after trimming (got ${len})`,
    );
  }
  if (CONTROL_CHARS_RE.test(reason)) return fail("proposals reject: --reason must not contain control characters");
  return reason;
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function ok(values: Record<string, string | boolean | undefined>, invocation: ProposalsInvocation): ProposalsArgsResult {
  return { ok: true, version: false, values, invocation };
}
