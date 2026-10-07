// apps/web/src/server/mutations/definitions.ts — the five M2 mutation definitions.
//
// Pure factory: closes each handler over its dependencies and returns them in registration order
// (silences, acks, proposals). The only caller is buildWriteRuntime (bootstrap.ts), which
// registers each definition into the proxy-header registry.

import type { AlertmanagerWriteClient } from "@pulse/web-data/sources";
import type { MutationDefinition } from "./registry.js";
import type { AckStore } from "./stores/ack-store.js";
import type { ProposalStore } from "./stores/proposal-store.js";
import { createSilenceMutation, expireSilenceMutation } from "./handlers/silences.js";
import { removeAckMutation, setAckMutation } from "./handlers/acks.js";
import { createProposalMutation } from "./handlers/proposals.js";

/** Everything the five definitions close over (built in buildWriteRuntime). */
export interface MutationsDeps {
  /** Alertmanager write surface (createAlertmanagerWriteClient(PULSE_ALERTMANAGER_URL)). */
  readonly writeClient: AlertmanagerWriteClient;
  /** Durable ack store. */
  readonly ackStore: AckStore;
  /** Signed proposal store; holds the SecretProvider in its closure. */
  readonly proposalStore: ProposalStore;
  /** Clock seam for factories that need time outside a request; per-request time arrives as meta.now. */
  readonly now: () => Date;
}

/**
 * The five M2 mutations in registration order: silence create/expire, ack set/remove, proposal create. buildWriteRuntime does
 * `for (const def of createMutations(deps)) registry.register(def)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous B/R per definition
export function createMutations(deps: MutationsDeps): readonly MutationDefinition<any, any>[] {
  return Object.freeze([
    createSilenceMutation({ writeClient: deps.writeClient, now: deps.now }), // silences
    expireSilenceMutation({ writeClient: deps.writeClient, now: deps.now }), // silences
    setAckMutation({ ackStore: deps.ackStore, now: deps.now }), // acks
    removeAckMutation({ ackStore: deps.ackStore }), // acks
    createProposalMutation({ store: deps.proposalStore }), // proposals
  ]);
}
