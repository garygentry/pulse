// apps/cli/src/commands/connect-link.ts — `pulse connect-link`: print the phone connect link as
// a terminal QR code and as plain text.

import { FINDING_CODES } from "@pulse/core";
import type { Finding } from "@pulse/core";
import {
  buildConnectLink,
  CONNECT_LINK_MAX_LENGTH,
  encodeQrMatrix,
} from "@pulse/web-data/contract";
import type { ConnectLinkRefusal, QrMatrix } from "@pulse/web-data/contract";

import { EXTERNAL_URL_ENV } from "../config.js";
import type { ConnectLinkAddress } from "../config.js";
import type { ConnectLinkData, ConnectLinkSource } from "../envelope.js";
import type { OutputWriter } from "../output.js";
import { renderQrHalfBlocks } from "../qr-terminal.js";
import type { CommandResult } from "./result.js";

/** Input to {@link runConnectLink}. */
export interface ConnectLinkInput {
  /** The resolved address (`ResolvedConfig.externalUrl`), or `undefined` when no source set one. */
  readonly address: ConnectLinkAddress | undefined;
}

/** How each source is named in a message. A message names the source, never the value. */
const SOURCE_NAME: Record<ConnectLinkSource, string> = {
  flag: "--url",
  env: EXTERNAL_URL_ENV,
  config: "pulse.config.yaml",
};

/** How each source is named in the "Address from …" line. */
const SOURCE_LINE_NAME: Record<ConnectLinkSource, string> = {
  flag: "--url",
  env: EXTERNAL_URL_ENV,
  config: "pulse.config.yaml (externalUrl)",
};

/** Message and fix per refusal; `source` is the {@link SOURCE_NAME} label. */
const REFUSAL_TEXT: Record<
  ConnectLinkRefusal,
  { message: (source: string) => string; fix: string }
> = {
  "not-https": {
    message: (s) => `The address from ${s} does not use HTTPS, so no connect link was produced.`,
    fix: "Use the server's https address.",
  },
  loopback: {
    message: (s) => `The address from ${s} is a loopback address that a phone cannot reach.`,
    fix: "Use the server's https address on your network.",
  },
  credentials: {
    message: (s) => `The address from ${s} contains a user name or password.`,
    fix: "Remove the credentials; a connect link never carries them.",
  },
  unparseable: {
    message: (s) => `The address from ${s} is not a valid absolute URL.`,
    fix: "Use an absolute https URL such as https://pulse.example.com.",
  },
  "too-long": {
    message: (s) =>
      `The address from ${s} makes a connect link longer than ${CONNECT_LINK_MAX_LENGTH} characters.`,
    fix: "Use a shorter https address.",
  },
};

/** A failed run: one error finding, no data. Not tied to an estate file or field. */
function failure(
  code: Finding["code"],
  message: string,
  fix: string,
): CommandResult<ConnectLinkData | null> {
  return {
    findings: [{ severity: "error", code, file: "", path: "", message, fix }],
    data: null,
    outcomeFailed: true,
  };
}

function refused(
  refusal: ConnectLinkRefusal,
  source: ConnectLinkSource,
): CommandResult<ConnectLinkData | null> {
  const text = REFUSAL_TEXT[refusal];
  return failure(FINDING_CODES.CONNECT_LINK_REFUSED, text.message(SOURCE_NAME[source]), text.fix);
}

/**
 * Run `pulse connect-link`. Synchronous, with no network or filesystem access of its own.
 *
 * - No address: finding `connect_link_no_address`, `data: null`, `outcomeFailed: true`.
 * - Address refused: finding `connect_link_refused`, `data: null`, `outcomeFailed: true`. The
 *   message names the address's source and never repeats its value, which may hold credentials.
 * - Otherwise: the QR code via `out.note` (hidden by `--quiet`), the plain link via
 *   `out.diagnostic` (always shown), and `data` set.
 *
 * Everything written here goes to stderr; under `--json` the shell prints the envelope.
 */
export function runConnectLink(
  input: ConnectLinkInput,
  out: OutputWriter,
): CommandResult<ConnectLinkData | null> {
  const { address } = input;
  if (address === undefined) {
    return failure(
      FINDING_CODES.CONNECT_LINK_NO_ADDRESS,
      "No server address is configured for the connect link.",
      `Pass --url https://<server address>, set ${EXTERNAL_URL_ENV}, or set externalUrl in pulse.config.yaml.`,
    );
  }

  const built = buildConnectLink(address.value);
  if (!built.ok) return refused(built.refusal, address.source);

  let matrix: QrMatrix;
  try {
    matrix = encodeQrMatrix(built.link);
  } catch (err) {
    // The link length limit keeps a link within QR capacity, so this is defensive.
    if (err instanceof RangeError) return refused("too-long", address.source);
    throw err;
  }

  out.note(renderQrHalfBlocks(matrix));
  out.note("");
  out.diagnostic(built.link);
  out.note(`Address from ${SOURCE_LINE_NAME[address.source]}: ${built.baseUrl}`);

  return {
    findings: [],
    data: { link: built.link, baseUrl: built.baseUrl, source: address.source },
    outcomeFailed: false,
  };
}
