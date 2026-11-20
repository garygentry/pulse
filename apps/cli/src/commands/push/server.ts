// apps/cli/src/commands/push/server.ts — resolve the base URL `pulse push` talks to, and the
// `--insecure-local` loopback exception. Pure; never throws; no network.

import { FINDING_CODES } from "@pulse/core";
import type { Finding } from "@pulse/core";
import { normaliseBaseUrl } from "@pulse/web-data/contract";
import type { ConnectLinkRefusal } from "@pulse/web-data/contract";

import type { ConnectLinkAddress, PushServerAddress } from "../../config.js";

/** Where the resolved base URL came from, including the externalUrl fallback (for messages and --verbose). */
export type PushServerOrigin = "flag" | "env" | "config" | "external-url-env" | "external-url-config";

/** Human label per origin. Messages name the source, never the raw value. */
export const PUSH_SERVER_SOURCE_LABEL: Readonly<Record<PushServerOrigin, string>> = Object.freeze({
  flag: "--server",
  env: "PULSE_SERVER_URL",
  config: "pulse.config.yaml (server)",
  "external-url-env": "PULSE_WEB_EXTERNAL_URL",
  "external-url-config": "pulse.config.yaml (externalUrl)",
});

/** Inputs to {@link resolvePushServer}; all come from ResolvedConfig plus the parsed invocation. */
export interface PushServerInputs {
  /** `ResolvedConfig.server` (flag > PULSE_SERVER_URL > file `server`), or undefined. */
  readonly server: PushServerAddress | undefined;
  /** `ResolvedConfig.externalUrl` (PULSE_WEB_EXTERNAL_URL > file `externalUrl` on this verb), or undefined. */
  readonly externalUrl: ConnectLinkAddress | undefined;
  /** `--insecure-local` was passed (argument parsing already required `--server` and checked its host). */
  readonly insecureLocal: boolean;
}

/** The base URL the CLI will call, or the finding that explains why there is none. */
export type PushServerResolution =
  | {
      /** Discriminant: resolved. */
      readonly ok: true;
      /** `https://<host>[:port][/path]` from normaliseBaseUrl, or `http://127.0.0.1:<port>` / `http://localhost:<port>`. */
      readonly baseUrl: string;
      /** Which source supplied it. */
      readonly source: PushServerOrigin;
      /** True only for the --insecure-local exception; the caller prints the warning. */
      readonly insecure: boolean;
    }
  | {
      /** Discriminant: no usable address. */
      readonly ok: false;
      /** The `PUSH_SERVER_MISSING` finding. */
      readonly finding: Finding;
    };

const LOCAL_FIX =
  "Use the server's https address. For a local development server only, pass --server http://127.0.0.1:<port> --insecure-local.";

/** Message and fix per refusal; the message names the source label, never the value. */
const REFUSAL_TEXT: Readonly<Record<ConnectLinkRefusal, { message: (label: string) => string; fix: string }>> = {
  "not-https": { message: (l) => `The address from ${l} does not use HTTPS.`, fix: LOCAL_FIX },
  loopback: { message: (l) => `The address from ${l} is a loopback address.`, fix: LOCAL_FIX },
  credentials: {
    message: (l) => `The address from ${l} contains a user name or password.`,
    fix: "Remove the credentials; the operator secret is read from PULSE_PUSH_OPERATOR_SECRET.",
  },
  unparseable: {
    message: (l) => `The address from ${l} is not a valid absolute URL.`,
    fix: "Use an absolute https URL such as https://pulse.example.com.",
  },
  "too-long": { message: (l) => `The address from ${l} is too long.`, fix: "Use a shorter https address." },
};

function finding(message: string, fix: string): Finding {
  return { severity: "error", code: FINDING_CODES.PUSH_SERVER_MISSING, file: "", path: "", message, fix };
}

function missingFinding(): Finding {
  return finding(
    "No Pulse server address is set for push commands.",
    "Pass --server https://<server address>, set PULSE_SERVER_URL, set server in pulse.config.yaml, or set PULSE_WEB_EXTERNAL_URL.",
  );
}

function refusedFinding(refusal: ConnectLinkRefusal, source: PushServerOrigin): Finding {
  const text = REFUSAL_TEXT[refusal];
  return finding(text.message(PUSH_SERVER_SOURCE_LABEL[source]), text.fix);
}

/**
 * Resolve the push server base URL. Precedence:
 *   --server > PULSE_SERVER_URL > pulse.config.yaml `server` > PULSE_WEB_EXTERNAL_URL > pulse.config.yaml `externalUrl`.
 * The first source that is SET wins; if it is refused, there is no fall-through to a lower source (the operator
 * asked for that address). Pure; never throws; no network.
 */
export function resolvePushServer(inputs: PushServerInputs): PushServerResolution {
  try {
    const { server, externalUrl, insecureLocal } = inputs;
    if (insecureLocal) {
      if (server !== undefined && server.source === "flag") {
        const local = parseInsecureLocalBase(server.value);
        if (local.ok) return { ok: true, baseUrl: local.baseUrl, source: "flag", insecure: true };
      }
      return { ok: false, finding: refusedFinding("not-https", server?.source ?? "flag") };
    }
    let candidate: { readonly value: string; readonly source: PushServerOrigin };
    if (server !== undefined) {
      candidate = server;
    } else if (externalUrl !== undefined) {
      candidate = {
        value: externalUrl.value,
        source: externalUrl.source === "config" ? "external-url-config" : "external-url-env",
      };
    } else {
      return { ok: false, finding: missingFinding() };
    }
    const normalised = normaliseBaseUrl(candidate.value);
    if (normalised.ok) return { ok: true, baseUrl: normalised.baseUrl, source: candidate.source, insecure: false };
    return { ok: false, finding: refusedFinding(normalised.refusal, candidate.source) };
  } catch {
    return { ok: false, finding: missingFinding() };
  }
}

/** Hosts the --insecure-local exception allows (after WHATWG URL parsing, which lower-cases). */
const INSECURE_LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * The --insecure-local rule. Accepts only `http:` with host `127.0.0.1` or `localhost` (case-insensitive,
 * after WHATWG URL parsing), no credentials, path empty or "/", and no query or fragment. The port is optional only
 * because URL drops a default `:80`. Returns `http://<host>[:<port>]`. Pure; never throws.
 */
export function parseInsecureLocalBase(
  raw: string,
): { readonly ok: true; readonly baseUrl: string } | { readonly ok: false } {
  const refused = { ok: false } as const;
  try {
    if (typeof raw !== "string") return refused;
    // A bare "?" or "#" leaves url.search/url.hash empty, so check the raw text too.
    if (raw.includes("?") || raw.includes("#")) return refused;
    if (!URL.canParse(raw)) return refused;
    const url = new URL(raw);
    if (url.protocol !== "http:") return refused;
    if (url.username !== "" || url.password !== "") return refused;
    if (!INSECURE_LOCAL_HOSTS.has(url.hostname)) return refused;
    if (url.pathname !== "/" && url.pathname !== "") return refused;
    if (url.search !== "" || url.hash !== "") return refused;
    const port = url.port === "" ? "" : `:${url.port}`;
    return { ok: true, baseUrl: `http://${url.hostname}${port}` };
  } catch {
    return refused;
  }
}
