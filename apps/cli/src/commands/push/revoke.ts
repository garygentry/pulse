// apps/cli/src/commands/push/revoke.ts — `pulse push revoke <id>`: remove one paired device.

import type { PushRevokeData } from "../../envelope.js";
import type { CommandResult } from "../result.js";
import { findingForFailure } from "./client.js";
import type { PushSubcommandInput } from "./index.js"; // type-only: no runtime cycle

/** DELETE /api/push/admin/devices/:id; 204 ⇒ exit 0. An unknown id is PUSH_DEVICE_NOT_FOUND through the probe. */
export async function runRevoke(
  input: PushSubcommandInput & { readonly deviceId: string },
): Promise<CommandResult<PushRevokeData | null>> {
  const { client, failure, out, deviceId } = input;
  const revoked = await client.revokeDevice(deviceId);
  if (!revoked.ok) return { findings: [findingForFailure(revoked.failure, failure)], data: null, outcomeFailed: true };

  out.diagnostic(`Revoked ${deviceId}. Its credential no longer works and nothing more is sent to it.`);
  return { findings: [], data: { deviceId }, outcomeFailed: false };
}
