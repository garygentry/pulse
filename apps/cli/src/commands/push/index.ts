// apps/cli/src/commands/push/index.ts — `pulse push <sub>` orchestration: resolve the server, read the operator
// secret, warn under --insecure-local, build the client, then dispatch to the sub-command runner.

import type { Finding } from "@pulse/core";

import type { CommandContext } from "../../index.js"; // type-only: no runtime cycle
import type { PushDevicesData, PushPairData, PushRevokeData, PushTestData } from "../../envelope.js";
import type { OutputWriter } from "../../output.js";
import type { CommandResult } from "../result.js";
import type { PushInvocation } from "./args.js";
import { createPushClient, PUSH_HTTP_TIMEOUT_MS, PUSH_TEST_TIMEOUT_MS, readPushOperatorSecret } from "./client.js";
import type { FailureContext, PushClient } from "./client.js";
import { runDevices } from "./devices.js";
import { runPair } from "./pair.js";
import { runRevoke } from "./revoke.js";
import { PUSH_SERVER_SOURCE_LABEL, resolvePushServer } from "./server.js";
import { runTest } from "./test.js";

/** Dependencies of the push runners; all injectable. */
export interface PushRunDeps {
  /** The process environment (the operator secret is read from it). */
  readonly env: NodeJS.ProcessEnv;
  /** fetch (the global one in production, a stub in tests). */
  readonly fetchImpl: typeof fetch;
  /** Clock for the "expires in about N min" line. */
  readonly now: () => Date;
}

/** The union of push `data` payloads. */
export type PushCommandData = PushPairData | PushDevicesData | PushRevokeData | PushTestData;

/** Shared inputs of a subcommand runner. */
export interface PushSubcommandInput {
  /** The client bound to the resolved base and secret. */
  readonly client: PushClient;
  /** For failure messages. */
  readonly failure: FailureContext;
  /** stderr writer. */
  readonly out: OutputWriter;
  /** Clock. */
  readonly now: () => Date;
}

/**
 * Run `pulse push <sub>`. Every expected failure is an error finding with `outcomeFailed: true`; it throws only on a
 * programmer error (which the shell maps to exit 2).
 */
export async function runPush(
  invocation: PushInvocation,
  ctx: CommandContext,
  deps: PushRunDeps,
): Promise<CommandResult<PushCommandData | null>> {
  // 1–2. Resolve the server, then read the secret; report both failures together, with no request.
  const resolution = resolvePushServer({
    server: ctx.config.server,
    externalUrl: ctx.config.externalUrl,
    insecureLocal: invocation.insecureLocal,
  });
  const secret = readPushOperatorSecret(deps.env);
  const findings: Finding[] = [];
  if (!resolution.ok) findings.push(resolution.finding);
  if (!secret.ok) findings.push(secret.finding);
  if (!resolution.ok || !secret.ok) return { findings, data: null, outcomeFailed: true };

  // 3. The --insecure-local warning goes through diagnostic so --quiet never hides it.
  if (resolution.insecure) {
    ctx.out.diagnostic(
      `warning: --insecure-local: talking to ${resolution.baseUrl} over plain HTTP; the operator secret is sent unencrypted. Development only.`,
    );
  }

  // 4. Where the address came from (verbose only).
  ctx.out.detail(`Server: ${resolution.baseUrl} (from ${PUSH_SERVER_SOURCE_LABEL[resolution.source]})`);

  // 5. The client.
  const client = createPushClient({
    fetch: deps.fetchImpl,
    baseUrl: resolution.baseUrl,
    secret: secret.secret,
    trace: (line) => ctx.out.detail(line),
  });

  // 6. Dispatch to the sub-command runner.
  const input = (timeoutMs: number): PushSubcommandInput => ({
    client,
    failure: { baseUrl: resolution.baseUrl, insecure: resolution.insecure, timeoutMs },
    out: ctx.out,
    now: deps.now,
  });
  switch (invocation.sub) {
    case "pair":
      return runPair({ ...input(PUSH_HTTP_TIMEOUT_MS), baseUrl: resolution.baseUrl });
    case "devices":
      return runDevices(input(PUSH_HTTP_TIMEOUT_MS));
    case "revoke":
      return runRevoke({ ...input(PUSH_HTTP_TIMEOUT_MS), deviceId: invocation.id });
    case "test":
      return runTest({ ...input(PUSH_TEST_TIMEOUT_MS), deviceId: invocation.device });
  }
}
