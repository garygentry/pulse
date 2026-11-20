// Push routing: the request-body pipeline shared by every push route that takes a JSON body.

import type { ZodType, ZodTypeDef } from "zod";

import { checkContentType, parseStrictBody, readBoundedJson } from "../mutations/guards.js";
import { fromGuardReason, type PushRefusal } from "./refusal.js";

/** Result of {@link readPushBody}. */
export type PushBodyResult<B> =
  | {
      /** The body was read and validated. */
      readonly ok: true;
      /** The validated body. */
      readonly body: B;
    }
  | {
      /** The body was refused. */
      readonly ok: false;
      /** Why: invalid-body or body-too-large (anything else is a bug and maps to internal). */
      readonly refusal: PushRefusal;
      /** Sanitised invalid-field paths, never values; set only when known. */
      readonly fields?: string;
    };

function refused<B>(refusal: PushRefusal, fields: string | undefined): PushBodyResult<B> {
  return fields === undefined ? { ok: false, refusal } : { ok: false, refusal, fields };
}

/**
 * Read and validate a JSON request body. Never throws.
 *
 * 1. The media type must be `application/json` (optionally with `charset=utf-8`); otherwise invalid-body and the body
 *    is not read. There is no unsupported-media-type status.
 * 2. The body is read up to `cap` bytes: a declared or streamed size over the cap is body-too-large; a malformed
 *    Content-Length, an absent body or a stream error is invalid-body.
 * 3. Strict UTF-8, JSON and schema validation; a failure is invalid-body with the failing paths in `fields`.
 *
 * @param request - The request.
 * @param cap     - Maximum body size in bytes.
 * @param schema  - The strict request schema.
 */
export async function readPushBody<B>(
  request: Request,
  cap: number,
  schema: ZodType<B, ZodTypeDef, unknown>,
): Promise<PushBodyResult<B>> {
  try {
    const type = checkContentType(request.headers);
    if (!type.ok) return refused(fromGuardReason(type.reason), undefined);
    const bytes = await readBoundedJson(request, cap);
    if (!bytes.ok) return refused(fromGuardReason(bytes.reason), undefined);
    const parsed = parseStrictBody(schema, bytes.value);
    if (!parsed.ok) {
      const refusal = fromGuardReason(parsed.reason);
      return refused(refusal, refusal === "invalid-body" ? parsed.fields : undefined);
    }
    return { ok: true, body: parsed.value };
  } catch {
    return refused("internal", undefined);
  }
}
