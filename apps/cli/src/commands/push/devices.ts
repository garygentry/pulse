// apps/cli/src/commands/push/devices.ts — `pulse push devices`: list the paired devices as a table on stderr.

import type { PushDevicesData } from "../../envelope.js";
import type { CommandResult } from "../result.js";
import { findingForFailure } from "./client.js";
import { formatDeviceTable } from "./format.js";
import type { PushSubcommandInput } from "./index.js"; // type-only: no runtime cycle

/**
 * GET /api/push/admin/devices; print the table to stderr. The table is the command's result, so --quiet does not hide
 * it; only the count line is a `note`.
 */
export async function runDevices(input: PushSubcommandInput): Promise<CommandResult<PushDevicesData | null>> {
  const { client, failure, out } = input;
  const listed = await client.listDevices();
  if (!listed.ok) return { findings: [findingForFailure(listed.failure, failure)], data: null, outcomeFailed: true };

  const { devices } = listed.value;
  if (devices.length === 0) {
    out.diagnostic("No devices paired.");
  } else {
    for (const line of formatDeviceTable(devices)) out.diagnostic(line);
    out.note(`${devices.length} device(s).`);
  }
  return { findings: [], data: { devices }, outcomeFailed: false };
}
