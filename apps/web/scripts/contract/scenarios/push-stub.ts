// Helpers the push-pairing and push-device builders share for driving a stub push runtime.

import type { ApiErrorCode } from "@pulse/web-data/wire";

import { ContractToolError } from "../errors.js";
import { createStubPushRuntime, responseBody, type StubPushOptions, type StubPushRuntime } from "../stub-context.js";
import { assertPushErrorBody } from "./push-common.js";

/** Run `fn` against a fresh stub runtime and always close it. */
export async function withStub<T>(options: StubPushOptions, fn: (stub: StubPushRuntime) => Promise<T>): Promise<T> {
  const stub = await createStubPushRuntime(options);
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

/** Decode an error answer at `status` and check its envelope carries `code`. `subject` is `<group>/<scenario>`. */
export async function pushErrorBody(res: Response, status: number, code: ApiErrorCode, subject: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await responseBody(res, status);
  } catch (error) {
    if (error instanceof ContractToolError) throw new ContractToolError("SCENARIO_INVALID", subject, error.message);
    throw error;
  }
  assertPushErrorBody(body, code, subject);
  return body;
}

/** Why a request-fixture answer disagrees with the fixture (null when it agrees). */
export async function verdictOf(res: Response, successStatus: number, rejection: ApiErrorCode | null): Promise<string | null> {
  if (rejection === null) return res.status === successStatus ? null : `status ${res.status}, expected ${successStatus}`;
  if (res.status !== 400) return `status ${res.status}, expected 400`;
  const answer = (await res.json()) as { code?: unknown };
  return answer.code === rejection ? null : `code ${String(answer.code)}, expected ${rejection}`;
}
