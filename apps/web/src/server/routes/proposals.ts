// src/server/routes/proposals.ts — the `/api/proposals` read route
// (REQ-PROP-06, REQ-UX-01, REQ-SEC-07).
//
// Lists the signed estate-edit proposals for one host/service target. Registered in BOTH auth modes:
// in `none` mode no proposal store provider is installed, so the route answers
// `enabled:false`. The list is enabled only under the caller's `proposeEstateEdit` capability (the
// same rule as `/api/session`), which keeps proposer names and rationales from untrusted callers. An
// unknown but well-formed id yields an empty list — nothing leaks about which entities exist.

import { PROPOSAL_TARGET_ID_MAX_BYTES } from "@pulse/core/proposals";

import type { ProposalListBody } from "../../shared/mutations.js"; // wire types live in shared/
import { defineRoute } from "../../shared/registry.js";
import { currentCapabilities } from "../mutations/session-provider.js";
import { currentProposalStore } from "../mutations/stores/proposal-store.js";
import { errorFor } from "./respond.js";

const DISABLED: ProposalListBody = Object.freeze({ enabled: false, proposals: [], invalidCount: 0 });
const HEADERS = { "cache-control": "private, no-store" } as const;
/** Same byte bound as the body's `target.id`. */
const ID_MAX = PROPOSAL_TARGET_ID_MAX_BYTES;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

/** `GET /api/proposals?kind=host|service&id=<drilldownId>`. Registered in both auth modes. */
export const proposalsRoute = defineRoute({
  method: "GET",
  path: "/api/proposals",
  handler: async ({ request }, ctx) => {
    const q = new URL(request.url).searchParams;
    const kinds = q.getAll("kind");
    const ids = q.getAll("id");
    const kind = kinds[0];
    if (kinds.length !== 1 || (kind !== "host" && kind !== "service")) {
      return errorFor("INVALID_REQUEST", 400, { param: "kind" });
    }
    const id = ids[0];
    const prefix = kind === "host" ? "host:" : "svc:";
    if (
      ids.length !== 1 ||
      id === undefined ||
      new TextEncoder().encode(id).byteLength > ID_MAX ||
      CONTROL_RE.test(id) ||
      !id.startsWith(prefix) ||
      id.length === prefix.length ||
      (kind === "service" && !id.slice(prefix.length).includes("/"))
    ) {
      return errorFor("INVALID_REQUEST", 400, { param: "id" });
    }
    const store = currentProposalStore();
    // Same rule as /api/session: trusted identity ∧ proxy-header ∧ audit/proposals/secret healthy.
    if (store === null || !currentCapabilities(ctx.identity, ctx.config.identity.mode).proposeEstateEdit) {
      return Response.json(DISABLED, { status: 200, headers: HEADERS });
    }
    const body = await store.listFor(kind, id);
    return Response.json(body, { status: 200, headers: HEADERS });
  },
});
