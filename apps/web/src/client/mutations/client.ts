// mutations/client.ts — the browser-side mutation client (REQ-UX-02/03, REQ-SEC-07).
import { MUTATION_REASONS } from "../../shared/mutations.js";
import type { MutationReason, MutationSuccess, ProposalListBody, ProposalView } from "../../shared/mutations.js";
// `@pulse/core/proposals` TYPES only (erased): the core barrel builds zod schemas at load.
import type { ProposalState } from "@pulse/core/proposals";

/** A refusal or failure as seen by the client (REQ-UX-02). */
export class MutationClientError extends Error {
  /** Bounded reason from details.reason, or a transport-level classification. */
  readonly reason: MutationReason | "network" | "malformed-response";
  /** HTTP status, or 0 for a network failure. */
  readonly status: number;
  /** Server request id (details.requestId, else the X-Request-Id header), when present. */
  readonly requestId: string | null;
  /** Invalid body paths (dot-joined zod paths) for field association (REQ-A11Y-03). */
  readonly fields: readonly string[];
  constructor(reason: MutationClientError["reason"], status: number, requestId: string | null, fields: readonly string[]) {
    super(`mutation refused: ${reason}`); // never rendered; REASON_TEXT is
    this.name = "MutationClientError";
    this.reason = reason;
    this.status = status;
    this.requestId = requestId;
    this.fields = fields;
  }
}

const REASON_SET: ReadonlySet<string> = new Set(MUTATION_REASONS);
function isMutationReason(v: unknown): v is MutationReason {
  return typeof v === "string" && REASON_SET.has(v);
}

/** Structural check of the 2xx body (a MutationSuccess). */
function isSuccess(v: unknown): v is MutationSuccess<unknown> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["outcome"] === "succeeded" && typeof o["requestId"] === "string" && "result" in o;
}

/**
 * POST a mutation. Resolves the success body or throws MutationClientError.
 * Never exposes a raw response body: the refusal `message` (catalog text) is ignored. For example,
 * SOURCE_TIMEOUT's catalog text refers to history, so only `details.reason` is used.
 *
 * @param path - Exact mutation path (one of the registered /api/mutations/* routes).
 * @param body - JSON-serializable body (a per-endpoint body type from shared/mutations).
 * @param idempotencyKey - Key from newIdempotencyKey(), reused per logical action.
 * @param fetchImpl - Optional 4th parameter for tests; the 3-arg call shape is unaffected.
 * @throws MutationClientError on network failure, a non-JSON/ill-shaped body, or any non-2xx.
 */
export async function postMutation<R>(
  path: `/api/mutations/${string}`,
  body: unknown,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MutationSuccess<R>> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MutationClientError("network", 0, null, []);
  }
  const headerId = res.headers.get("x-request-id");
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new MutationClientError("malformed-response", res.status, headerId, []);
  }
  if (res.ok) {
    if (isSuccess(json)) return json as MutationSuccess<R>;
    throw new MutationClientError("malformed-response", res.status, headerId, []);
  }
  const details = (typeof json === "object" && json !== null
    ? (json as { details?: unknown }).details
    : undefined) as Record<string, unknown> | undefined;
  const reason = isMutationReason(details?.["reason"]) ? details["reason"] : "malformed-response";
  const requestId = typeof details?.["requestId"] === "string" ? details["requestId"] : headerId;
  const rawFields = details?.["fields"];
  const fields = typeof rawFields === "string" && rawFields !== "" ? rawFields.split(",") : [];
  throw new MutationClientError(reason, res.status, requestId, fields);
}
/** 22-char base64url of 16 CSPRNG bytes; matches IDEMPOTENCY_KEY_RE. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Reasons whose outcome the server STORES under the key (handler outcomes, incl.
 * upstream failures). After one of these, resubmitting with the same key would replay the same
 * failure, or return idempotency-conflict once the body is edited. So the dialog mints a fresh key
 * for the operator's deliberate retry. Every other reason is a pre-handler refusal, which is never
 * stored, so the key is reused (UX-03). A "network" failure also reuses the key: the request may
 * have landed, and a reuse dedupes it.
 */
export const STORED_FAILURE_REASONS: ReadonlySet<MutationClientError["reason"]> = new Set<MutationClientError["reason"]>([
  "alert-not-firing", "silence-gone", "entity-not-found", "stale-proposal", "write-failed", "internal",
  "idempotency-conflict",
  "upstream-timeout", "upstream-transport", "upstream-upstream-status", "upstream-malformed-json",
  "upstream-invalid-shape", "upstream-incompatible", "upstream-overflow", "upstream-disabled",
]);
/** Fixed, display-safe text per reason. Exhaustive: a missing key is a type error. */
export const REASON_TEXT: Readonly<Record<MutationClientError["reason"], string>> = {
  "untrusted-identity": "You are not signed in through the trusted proxy, so this action was refused.",
  "cross-origin": "The request did not come from this Pulse page and was refused.",
  "capability-false": "You no longer have permission for this action.",
  "write-path-degraded": "The write path is currently unavailable (storage not writable). Try again later.",
  "invalid-body": "Some values are invalid. Check the highlighted fields.",
  "body-too-large": "The request is too large. Shorten the text and try again.",
  "missing-idempotency-key": "The request was missing its submission key. Close the dialog and try again.",
  "idempotency-conflict": "This submission conflicts with an earlier one. Submit again to send it as a new action.",
  "audit-unavailable": "The audit log could not be written, so nothing was changed. Try again later.",
  "alert-not-firing": "This alert is no longer firing, so it cannot be acknowledged.",
  "silence-gone": "This silence has already expired or no longer exists.",
  "entity-not-found": "This entity is no longer in the estate.",
  "stale-proposal": "The declared value changed since this page loaded. Reload and propose again.",
  "write-failed": "Pulse could not save the change. Nothing was recorded; try again later.",
  "internal": "An internal error occurred. The action may not have completed.",
  "upstream-timeout": "Alertmanager timed out. The action was not retried.",
  "upstream-transport": "Alertmanager could not be reached. The action was not retried.",
  "upstream-upstream-status": "Alertmanager rejected the request. The action was not retried.",
  "upstream-malformed-json": "Alertmanager returned an unreadable response. The action was not retried.",
  "upstream-invalid-shape": "Alertmanager returned an unexpected response. The action was not retried.",
  "upstream-incompatible": "Alertmanager's API version is not supported. The action was not retried.",
  "upstream-overflow": "Alertmanager's response exceeded Pulse's limits. The action was not retried.",
  "upstream-disabled": "Alertmanager writes are not configured on this server.",
  network: "The server could not be reached. Check your connection and try again.",
  "malformed-response": "The server returned an unexpected response.",
};

/** Failure line shown and announced: fixed text plus the request id (a server UUID) for support. */
export function failureText(err: MutationClientError): string {
  return err.requestId === null ? REASON_TEXT[err.reason] : `${REASON_TEXT[err.reason]} (request ${err.requestId})`;
}

/** True when `fields` (MutationClientError.fields) names `name` or a sub-path of it (REQ-A11Y-03). */
export function fieldHasError(fields: readonly string[], name: string): boolean {
  return fields.some((f) => f === name || f.startsWith(`${name}.`));
}
/** C0 (except \t, \n) and C1 control characters, plus DEL. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Neutralize control characters for display (each is shown as U+FFFD). The result is ALWAYS
 * rendered as a React text child, never as markup. \n (pre-wrap rationales) and \t are kept.
 */
export function displayText(s: string): string {
  return s.replace(CONTROL_RE, "\uFFFD");
}

/** Length in Unicode code points: the unit of every "N characters" bound (05, 07). */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** GET /api/proposals?kind=&id=. null on any failure (rendered as a notice). */
export async function fetchProposals(
  kind: "host" | "service", id: string, fetchImpl: typeof fetch = fetch,
): Promise<ProposalListBody | null> {
  try {
    const res = await fetchImpl(`/api/proposals?kind=${kind}&id=${encodeURIComponent(id)}`,
      { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const b: unknown = await res.json();
    return isProposalListBody(b) ? b : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES: ReadonlySet<unknown> = new Set<ProposalState>(["pending", "applied", "rejected"]);

/** One list item: the string/array members the renderer reads, with the right primitive types. */
function isProposalView(v: unknown): v is ProposalView {
  if (!isObject(v)) return false;
  return typeof v["id"] === "string" && STATES.has(v["state"]) && typeof v["createdAt"] === "string"
    && typeof v["proposer"] === "string" && typeof v["rationale"] === "string" && Array.isArray(v["changes"])
    && v["changes"].every((c) => isObject(c) && typeof c["field"] === "string" && "seen" in c && "proposed" in c)
    && (v["reason"] === null || typeof v["reason"] === "string")
    && (v["commit"] === null || typeof v["commit"] === "string");
}

/** Guard: boolean enabled, array proposals (objects with string id/state), number invalidCount. */
export function isProposalListBody(v: unknown): v is ProposalListBody {
  return isObject(v) && typeof v["enabled"] === "boolean" && Array.isArray(v["proposals"])
    && v["proposals"].every(isProposalView)
    && typeof v["invalidCount"] === "number" && Number.isInteger(v["invalidCount"]) && v["invalidCount"] >= 0;
}
