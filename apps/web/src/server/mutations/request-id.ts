// apps/web/src/server/mutations/request-id.ts — server request id minting.

import { randomUUID } from "node:crypto";

/**
 * Mint a server request id (dispatcher step 2). It is a v4 UUID (36 ASCII chars, control-free, within
 * the writer's 256-byte field bound), so it is safe in headers, logs, audit records and proposal files.
 */
export function newRequestId(): string {
  return randomUUID();
}
