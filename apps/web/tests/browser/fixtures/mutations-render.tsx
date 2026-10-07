// apps/web/tests/browser/fixtures/mutations-render.tsx — shared mount for the mutation browser fixture
// pages (10 §6; REQ-A11Y-01..04, REQ-UX-04, SC-06). NOT an entry: each `mutations-<page>.tsx` entry calls
// mountMutationsFixture once.
//
// Renders the REAL mutation components (triggers, lazy dialogs, badges, proposal list) inside a <main>
// landmark over the global stylesheet (styles/app.css). The store is seeded as a desk-density session with
// every capability true, the `mixed` alerts payload and the reference estate. The pages are static
// bundles with no server, so `window.fetch` is replaced BEFORE render:
//   - GET /api/session      → all capabilities true (ensureSession never overwrites the seed anyway)
//   - GET /api/proposals    → one pending, one applied and one rejected proposal
//   - POST /api/mutations/* → scripted by `window.__pulseMutationReply`: "success" (default) answers the
//     action's 2xx body; "refuse" answers 400 INVALID_REQUEST reason invalid-body with the fields
//     `rationale,note` (so the dialog marks its text field aria-invalid and shows a failed badge); "hold"
//     keeps the POST in flight until `window.__pulseMutationRelease()`, then answers as "success".
// Every POST is recorded on `window.__pulseMutationPosts` for the keyboard suite's Enter-submit check.
// The page sets `data-fixture-ready` on <html> after the synchronous render.

import { render } from "../../react-render.js";
import type { ReactElement } from "react";

import "../../../src/client/styles/app.css";

import type { WebEstateModelV2 } from "@pulse/renderer";
import type { ProposalListBody, ProposalView } from "../../../src/shared/mutations.js";
import { createAppStore } from "../../../src/client/store/index.js";
import type { AppStore } from "../../../src/client/store/index.js";
import { makeAlertsPayload, withAck, FIXTURE_FINGERPRINTS } from "../../alerts-fixtures.js";
import { makeEstatePayloadFixture } from "../../factories/estate-payload.js";

import referenceModel from "../../../../../examples/reference/rendered/web-estate-model.json" with { type: "json" };

/** Scripted reply mode for POST /api/mutations/* (set by the suites via page.evaluate). */
export type MutationReplyMode = "success" | "refuse" | "hold";

interface FixtureWindow {
  __pulseMutationReply?: MutationReplyMode;
  __pulseMutationPosts?: Array<{ path: string; body: unknown }>;
  __pulseMutationRelease?: () => void;
}

/** The reference estate model (browser-safe JSON import). */
export const REFERENCE_MODEL = referenceModel as unknown as WebEstateModelV2;

const VIEW = (over: Partial<ProposalView>): ProposalView => ({
  id: "p-20260930T010000Z-00000001",
  createdAt: "2026-09-30T01:00:00.000Z",
  proposer: "Gary Gentry",
  changes: [{ field: "expectedChurn", seen: false, proposed: true }],
  rationale: "Rebuilt host churns on every deploy.",
  state: "pending",
  reason: null,
  commit: null,
  ...over,
});

/** The /api/proposals answer: pending, applied and rejected (REQ-UX-04 chips). */
export const PROPOSAL_LIST: ProposalListBody = {
  enabled: true,
  invalidCount: 1,
  proposals: [
    VIEW({ id: "p-20260930T030000Z-00000003" }),
    VIEW({
      id: "p-20260930T020000Z-00000002", state: "applied", commit: "0123456789abcdef0123456789abcdef01234567",
      changes: [{ field: "scrapeIntervalClass", seen: null, proposed: "fast" }],
    }),
    VIEW({ id: "p-20260930T010000Z-00000001", state: "rejected", reason: "Churn is expected only during the migration." }),
  ],
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "00000000-0000-4000-8000-000000000042" },
  });

function successResult(path: string, body: Record<string, unknown>): { status: number; result: unknown } {
  const at = new Date().toISOString();
  switch (path) {
    case "/api/mutations/silences":
      return { status: 201, result: { silenceId: "silence-browser-created", endsAt: body["endsAt"] } };
    case "/api/mutations/silences/expire":
      return { status: 200, result: { silenceId: body["silenceId"] } };
    case "/api/mutations/acks":
      return { status: 200, result: { fingerprint: body["fingerprint"], at } };
    case "/api/mutations/acks/remove":
      return { status: 200, result: { fingerprint: body["fingerprint"], removed: true } };
    default:
      return { status: 201, result: { proposalId: "p-20260930T040000Z-00000004" } };
  }
}

function installFetchStub(): void {
  const w = window as unknown as FixtureWindow;
  w.__pulseMutationPosts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    if (path === "/api/session") {
      return json(200, {
        identity: { subject: "gary", displayName: "Gary Gentry", source: "proxy-header" },
        authMode: "proxy-header",
        capabilities: { silence: true, ack: true, proposeEstateEdit: true },
      });
    }
    if (path === "/api/proposals") return json(200, PROPOSAL_LIST);
    if (path.startsWith("/api/mutations/") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      w.__pulseMutationPosts!.push({ path, body });
      if (w.__pulseMutationReply === "hold") {
        await new Promise<void>((release) => { w.__pulseMutationRelease = release; });
      }
      if ((w.__pulseMutationReply ?? "success") === "refuse") {
        return json(400, {
          code: "INVALID_REQUEST",
          message: "invalid request",
          details: { reason: "invalid-body", requestId: "00000000-0000-4000-8000-000000000042", fields: "rationale,note" },
        });
      }
      const ok = successResult(path, body);
      return json(ok.status, { outcome: "succeeded", requestId: "00000000-0000-4000-8000-000000000042", result: ok.result });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** A desk-density store with every capability granted, live alerts (one acked) and the reference estate. */
export function makeMutationsStore(): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  const stampedTheme = (document.documentElement.classList.contains("dark") ? "dark" : "light");
  if (stampedTheme === "dark" || stampedTheme === "light") store.theme.value = stampedTheme;
  store.density.value = "desk";
  store.session.value = {
    identity: "Gary Gentry",
    authMode: "proxy-header",
    capabilities: { silence: true, ack: true, proposeEstateEdit: true },
  };
  store.alerts.value = withAck(makeAlertsPayload({ scenario: "mixed" }), [FIXTURE_FINGERPRINTS.diskFull]);
  store.estate.value = makeEstatePayloadFixture({ estate: REFERENCE_MODEL });
  return store;
}

/** Mount one mutation fixture page. Call once at the page entry's top. */
export function mountMutationsFixture(title: string, body: (store: AppStore) => ReactElement): void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("[mutations-fixture] #app mount node missing");
  installFetchStub();
  const store = makeMutationsStore();
  render(
    <main className="fixture-mutations">
      <h1>{title}</h1>
      {body(store)}
    </main>,
    root,
  );
  // render() is synchronous; no rAF here — Chromium throttles rAF on background pages.
  document.documentElement.dataset["fixtureReady"] = "1";
}
