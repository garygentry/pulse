// apps/cli/src/commands/push/pair.ts — `pulse push pair`: issue a pairing token and print it as a terminal QR code,
// the link, its expiry and the secrecy reminder.

import { encodeQrMatrix } from "@pulse/web-data/contract";
import type { QrMatrix } from "@pulse/web-data/contract";

import type { PushPairData } from "../../envelope.js";
import { renderQrHalfBlocks } from "../../qr-terminal.js";
import type { CommandResult } from "../result.js";
import { findingForFailure } from "./client.js";
import { formatInstant } from "./format.js";
import type { PushSubcommandInput } from "./index.js"; // type-only: no runtime cycle

/** The line printed after the link; it is always shown. */
export const PAIR_SECRET_LINE = "Treat this link as a secret; it pairs one device.";

/**
 * POST /api/push/admin/pairing-tokens with {baseUrl}; print QR + link + expiry. The QR goes through `note` (hidden by
 * --quiet); the link, the expiry and the secrecy line go through `diagnostic` (always shown). The link is never passed
 * to `detail` or the trace.
 */
export async function runPair(
  input: PushSubcommandInput & { readonly baseUrl: string },
): Promise<CommandResult<PushPairData | null>> {
  const { client, failure, out, now } = input;
  const issued = await client.issuePairingToken();
  if (!issued.ok) {
    return { findings: [findingForFailure(issued.failure, failure)], data: null, outcomeFailed: true };
  }
  const { link, expiresAt } = issued.value;

  let matrix: QrMatrix | null = null;
  try {
    matrix = encodeQrMatrix(link);
  } catch (err) {
    // The body guard keeps the link within the connect-link length limit, so this is defensive.
    if (!(err instanceof RangeError)) throw err;
  }
  if (matrix !== null) {
    out.note(renderQrHalfBlocks(matrix));
    out.note("");
  } else {
    out.note("(the link is too long for a terminal QR code)");
  }

  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - now().getTime()) / 60_000));
  out.diagnostic(link);
  out.diagnostic(`Expires at ${formatInstant(expiresAt)} (in about ${minutes} min; one use).`);
  out.diagnostic(PAIR_SECRET_LINE);

  return { findings: [], data: { link, expiresAt }, outcomeFailed: false };
}
