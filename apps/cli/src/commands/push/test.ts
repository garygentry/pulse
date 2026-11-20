// apps/cli/src/commands/push/test.ts — `pulse push test [--device <id>]`: send a test notification and report one
// outcome per device.

import { FINDING_CODES } from "@pulse/core";
import type { Finding } from "@pulse/core";

import type { PushTestData } from "../../envelope.js";
import type { CommandResult } from "../result.js";
import { findingForFailure } from "./client.js";
import { formatTestLines } from "./format.js";
import type { PushSubcommandInput } from "./index.js"; // type-only: no runtime cycle

const NO_DEVICES: Finding = Object.freeze({
  severity: "error",
  code: FINDING_CODES.PUSH_NO_DEVICES,
  file: "",
  path: "",
  message: "No device has registered for notifications yet.",
  fix: "Pair a device with pulse push pair, open the app so it registers, then run this again.",
});

const TEST_FAILED_FIX =
  'See the per-device lines above: "rejected" carries Apple\'s reason, "token-removed" means the device was removed and must pair again, and "unreachable" means Apple\'s push service could not be reached.';

/**
 * POST /api/push/admin/test; one line per device; exit 1 on any non-delivered result or none. `data` is the full
 * result whenever the server answered, so --json carries every per-device outcome even on exit 1.
 */
export async function runTest(
  input: PushSubcommandInput & { readonly deviceId: string | null },
): Promise<CommandResult<PushTestData | null>> {
  const { client, failure, out, deviceId } = input;
  const sent = await client.testSend(deviceId);
  if (!sent.ok) return { findings: [findingForFailure(sent.failure, failure)], data: null, outcomeFailed: true };

  const result = sent.value;
  const total = result.results.length;
  if (total === 0) return { findings: [{ ...NO_DEVICES }], data: { results: [] }, outcomeFailed: true };

  for (const line of formatTestLines(result.results)) out.diagnostic(line);
  const delivered = result.results.filter((r) => r.outcome === "delivered").length;
  out.note(`${delivered} of ${total} device(s) received the test notification.`);

  const findings: Finding[] = [];
  if (delivered < total) {
    findings.push({
      severity: "error",
      code: FINDING_CODES.PUSH_TEST_FAILED,
      file: "",
      path: "",
      message: `${total - delivered} of ${total} device(s) did not receive the test notification.`,
      fix: TEST_FAILED_FIX,
    });
  }
  return { findings, data: result, outcomeFailed: delivered < total };
}
