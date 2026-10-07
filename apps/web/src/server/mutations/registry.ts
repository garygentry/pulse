// apps/web/src/server/mutations/registry.ts — the append-only, POST-only mutation registry.
//
// A separate registry from the GET `RouteDefinition` table (REQ-SEAM-01, REQ-COMPAT-02): the GET type is
// never widened. The registry is constructible ONLY in proxy-header auth mode (REQ-SEAM-02), accepts
// only POST definitions under `/api/mutations/` (REQ-SEAM-07), and has no removal member.

import type { ZodType, ZodTypeDef } from "zod";
import type { AuthMode, Identity } from "@pulse/web-data/identity";
import type { SessionCapabilities } from "@pulse/web-data/wire";
import type { ServerContext } from "../../shared/registry.js";
import { WebAppError } from "../../shared/errors.js";
import { MUTATION_PATH_PREFIX } from "./constants.js";
import type { FailedReason } from "./refusal.js";

// ── Action, outcome, definition ───────────────────────────────────────────────────────────────────

/** Closed audit action names — one per mutation (REQ-AUD-01, REQ-OBS-01 label set). */
export type MutationAction = "silence.create" | "silence.expire" | "ack.set" | "ack.remove" | "proposal.create";
/** Every MutationAction, for exhaustive tables and tests. */
export const MUTATION_ACTIONS: readonly MutationAction[] = [
  "silence.create",
  "silence.expire",
  "ack.set",
  "ack.remove",
  "proposal.create",
] as const;

/** Capability name, taken from the widened session capabilities wire type. */
export type CapabilityName = keyof SessionCapabilities; // "silence" | "ack" | "proposeEstateEdit"

/** Scalar audit detail map (the writer's value type). */
export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>;

/** Typed handler result; the dispatcher alone renders the Response. */
export type MutationOutcome<R> =
  | {
      /** The upstream/state change happened. */
      readonly outcome: "succeeded";
      /** HTTP status. */
      readonly status: 200 | 201;
      /** Result body echoed to the client in MutationSuccess.result. */
      readonly result: R;
      /** Extra scalar audit details for the finalize record (pre-encoding; see encodeAuditDetails). */
      readonly details?: AuditDetails;
    }
  | {
      /** The action failed after the attempted record. */
      readonly outcome: "failed";
      /** HTTP status. */
      readonly status: 404 | 409 | 500 | 502 | 504;
      /** Existing catalog code. */
      readonly code: "TARGET_NOT_FOUND" | "INVALID_REQUEST" | "SOURCE_UNAVAILABLE" | "SOURCE_TIMEOUT" | "INTERNAL_ERROR";
      /**
       * Bounded failed-phase reason. The dispatcher overrides `status`/`code` from `FAILED_POLICY`
       * for this reason; a value outside `FailedReason` reaching it at runtime is collapsed to `internal`.
       */
      readonly reason: FailedReason;
      /** Extra scalar audit details for the finalize record. */
      readonly details?: AuditDetails;
    };

/** One write endpoint (REQ-SEAM-01). */
export interface MutationDefinition<B, R> {
  /** Always POST (REQ-SEAM-07). */
  readonly method: "POST";
  /** Exact path under /api/mutations/. */
  readonly path: `/api/mutations/${string}`;
  /** Governing capability (re-evaluated per request, REQ-AUTHZ-03). */
  readonly capability: CapabilityName;
  /** Audit action name. */
  readonly action: MutationAction;
  /**
   * Strict zod schema for the JSON body (REQ-SEC-03). Input type is `unknown` because the repo sets
   * `exactOptionalPropertyTypes: true` (tsconfig.base.json:8): a schema with optional/transformed
   * fields has an input type ≠ B, so `ZodType<B>` would not accept it.
   */
  readonly body: ZodType<B, ZodTypeDef, unknown>;
  /**
   * Optional context-dependent validation, run at pipeline step 8 immediately after `body.safeParse`
   * and BEFORE the idempotency lookup and the audit `attempted` record. Failure → `invalid-body`
   * refusal (not audited, not stored — REQ-AUD-06) with `fields`. Used for checks zod cannot express
   * statically: the silence `endsAt` window against the injected clock (REQ-SIL-04), and proposal
   * field applicability / value schema / `proposed !== seen` against the target's kind and class
   * (REQ-PROP-03/04). It MUST be pure and side-effect free. Target existence (`entity-not-found`) and
   * staleness (`stale-proposal`) are NOT checked here — they are audited handler failures (see FAILED_POLICY).
   */
  validate?(
    body: B,
    ctx: ServerContext,
    now: Date,
  ): { readonly ok: true } | { readonly ok: false; readonly fields: readonly string[] };
  /** Audit target derived from the validated body, before any effect ("alert:<fp>", "silence:<id>", "<kind>:<id>"). */
  auditTarget(body: B): string;
  /** Scalar audit details for the attempted record (raw; encoded by encodeAuditDetails). */
  auditDetails(body: B): AuditDetails;
  /**
   * Effectful handler: validated body, read-only server context, acting identity, and request metadata.
   * `meta` is an additive 4th parameter to the charter's `(body, ctx, actor)`: the proposal payload must
   * carry the dispatcher's request id (REQ-PROP-05), and handlers share the dispatcher's clock.
   */
  handler(body: B, ctx: ServerContext, actor: Identity, meta: MutationHandlerMeta): Promise<MutationOutcome<R>>;
}

/** Per-request metadata passed by the dispatcher at step 11. */
export interface MutationHandlerMeta {
  /** The request id already written into the `attempted` audit record. */
  readonly requestId: string;
  /** The dispatcher's clock reading for this request (same `now` passed to `validate`). */
  readonly now: Date;
}

// ── Registry ──────────────────────────────────────────────────────────────────────────────────────

/** Append-only registry, constructible only in proxy-header mode (REQ-SEAM-02, SEAM-07). */
export interface MutationRegistry {
  /** Register; throws MutationRegistrationError on non-POST or duplicate path. No remove exists. */
  register<B, R>(def: MutationDefinition<B, R>): void;
  /** Exact-pathname lookup; undefined → dispatcher returns null → router 405. */
  match(pathname: string): MutationDefinition<unknown, unknown> | undefined;
  /** Frozen snapshot, in registration order (tests). */
  list(): readonly MutationDefinition<unknown, unknown>[];
}

// ── Error ───────────────────────────────────────────────────────────────────────────────────────

/** A registry misuse; thrown at start-up (composition root), never on the request path. */
export class MutationRegistrationError extends WebAppError {
  /** Which registration rule was violated. */
  readonly rule: "auth-mode" | "method" | "duplicate-path" | "path-prefix";
  /** The offending path, or null for the auth-mode rule. */
  readonly path: string | null;
  constructor(rule: MutationRegistrationError["rule"], path: string | null, message: string) {
    super("MUTATION_REGISTRATION", message);
    this.name = "MutationRegistrationError";
    this.rule = rule;
    this.path = path;
  }
}

// ── createMutationRegistry ────────────────────────────────────────────────────────────────────────

/**
 * Exact mutation path grammar: the fixed prefix, then one or more lowercase `[a-z0-9]` words joined by
 * `-` or `/`. No trailing slash, query or percent-encoding, so an exact string match is unambiguous.
 */
const MUTATION_PATH_RE = /^\/api\/mutations\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/**
 * Create the append-only mutation registry. It is constructible ONLY in proxy-header mode, so an
 * `authMode: "none"` process can never hold one (REQ-SEAM-02; the composition root builds it only in that branch).
 * Throwing at construction rather than on register() is the stricter form: in none mode no registry
 * object can exist at all.
 *
 * @param authMode - `config.identity.mode`.
 * @returns A registry with register/match/list and no removal method.
 * @throws {MutationRegistrationError} rule "auth-mode" when `authMode !== "proxy-header"`.
 */
export function createMutationRegistry(authMode: AuthMode): MutationRegistry {
  if (authMode !== "proxy-header") {
    throw new MutationRegistrationError("auth-mode", null, "Mutations can only be registered in proxy-header auth mode.");
  }
  const byPath = new Map<string, MutationDefinition<unknown, unknown>>();
  const order: MutationDefinition<unknown, unknown>[] = [];

  return {
    register<B, R>(def: MutationDefinition<B, R>): void {
      // Runtime guard on top of the "POST" literal type: a cast or JS caller cannot register other verbs (REQ-SEAM-07).
      if ((def.method as string) !== "POST") {
        throw new MutationRegistrationError("method", def.path, "Mutations must use POST.");
      }
      if (!def.path.startsWith(MUTATION_PATH_PREFIX) || !MUTATION_PATH_RE.test(def.path)) {
        throw new MutationRegistrationError("path-prefix", def.path, "Mutation path must be an exact /api/mutations/ path.");
      }
      if (byPath.has(def.path)) {
        throw new MutationRegistrationError("duplicate-path", def.path, "Mutation path already registered.");
      }
      // Method-shorthand members are bivariant, so the widening is sound for storage. Freeze so a
      // registered definition cannot be swapped out later (append-only).
      const stored = Object.freeze(def) as unknown as MutationDefinition<unknown, unknown>;
      byPath.set(def.path, stored);
      order.push(stored);
    },
    match(pathname: string): MutationDefinition<unknown, unknown> | undefined {
      return byPath.get(pathname); // exact string equality; "/api/mutations/acks/" does NOT match
    },
    list(): readonly MutationDefinition<unknown, unknown>[] {
      return Object.freeze(order.slice());
    },
  };
}
