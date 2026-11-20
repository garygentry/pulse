// Operator test-send handler. The route table has already applied the operator-secret, admin-surface and
// configured-state gates and parsed the body; this handler only runs the test send and maps its result.

import { PUSH_CACHE_CONTROL } from "../constants.js";
import { pushErrorResponse } from "../refusal.js";
import { runTestSend, type TestSendDeps } from "../test-send.js";
import type { AdminTestRequest } from "./schemas.js";

/**
 * POST /api/push/admin/test. Body (already parsed): `{ deviceId?: string }`; `{}` means every device.
 * 200 `PushTestResult` (`{"results":[]}` when no device is registered) | 404 API_NOT_FOUND for an unknown deviceId.
 *
 * @param deps - Test-send dependencies.
 * @param body - The parsed request body.
 */
export async function handleAdminTest(deps: TestSendDeps, body: AdminTestRequest): Promise<Response> {
  const outcome = await runTestSend(body.deviceId !== undefined ? { deviceId: body.deviceId } : {}, deps);
  if (!outcome.ok) return pushErrorResponse(outcome.refusal);
  return new Response(JSON.stringify(outcome.result), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": PUSH_CACHE_CONTROL },
  });
}
