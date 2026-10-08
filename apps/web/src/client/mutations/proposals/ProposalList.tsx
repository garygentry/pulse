// apps/web/src/client/mutations/proposals/ProposalList.tsx — read-only proposal list for one estate
// entity (REQ-PROP-06, REQ-SEC-07). Every server string is rendered as a text child through
// displayText (inert text). Imports `@pulse/core/proposals` TYPES only (erased): the core barrel builds
// zod schemas at load and must never reach a client chunk (build-budget).
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { signal } from "@preact/signals-core";
import type { ProposalListBody, ProposalView } from "../../../shared/mutations.js";
import { Disclosure, List, MUTATION_STATE, StatusBadge } from "@/ui";
import { displayText, fetchProposals } from "../client.js";
import { formatValue } from "./format.js";
import { useSignals } from "@preact/signals-react/runtime";

/** Bumped after a successful submission to trigger a refetch. */
export const proposalListRefresh = signal(0);

const PRE = "m-0 whitespace-pre-wrap wrap-anywhere";
const HINT = "m-0 text-sm text-muted-foreground";

function ProposalItem(p: { readonly v: ProposalView }): ReactElement {
  const v = p.v;
  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-sm" data-proposal-id={v.id}>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <span data-state={v.state}>{StatusBadge.fromMap(MUTATION_STATE, v.state)}</span>
        <code>{displayText(v.id)}</code>
        <time dateTime={v.createdAt} className="text-muted-foreground">{displayText(v.createdAt)}</time>
        <span className="text-muted-foreground">by {displayText(v.proposer)}</span>
      </p>
      <ul className="m-0 list-disc pl-5">
        {v.changes.map((c) => (
          <li key={c.field}>{displayText(`${c.field}: ${formatValue(c.seen)} → ${formatValue(c.proposed)}`)}</li>
        ))}
      </ul>
      <p className={PRE}>{displayText(v.rationale)}</p>
      {v.state === "rejected" && v.reason !== null ? <p className={PRE}>Reason: {displayText(v.reason)}</p> : null}
      {v.state === "applied" && v.commit !== null ? <p className="m-0">Commit: <code>{displayText(v.commit)}</code></p> : null}
    </li>
  );
}

type Load = { readonly kind: "loading" } | { readonly kind: "failed" } | { readonly kind: "ready"; readonly body: ProposalListBody };

/**
 * Disclosure "Proposals" with an N pill (named "Proposals, N items"), keyboard-operable. Refetches on mount, target
 * change and proposalListRefresh change. enabled:false → nothing (the capability is false then too).
 */
export function ProposalList(p: { readonly target: { readonly kind: "host" | "service"; readonly id: string } }): ReactElement | null {
  useSignals();
  const refresh = proposalListRefresh.value; // subscribe
  const { kind, id } = p.target;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setLoad((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    void fetchProposals(kind, id).then((body) => {
      if (live) setLoad(body === null ? { kind: "failed" } : { kind: "ready", body });
    });
    return () => { live = false; };
  }, [kind, id, refresh]);

  if (load.kind === "ready" && !load.body.enabled) return null;
  // The count is the Disclosure's pill; the trigger's accessible name reads "Proposals, 3 items".
  const count = load.kind === "ready" ? load.body.proposals.length : undefined;
  return (
    <div data-testid="proposal-list">
      <Disclosure label="Proposals" {...(count !== undefined ? { count } : {})} contentClassName="flex flex-col gap-2">
        {load.kind === "loading" ? <p className={HINT}>Loading proposals…</p> : null}
        {load.kind === "failed" ? <p className="m-0 text-sm font-medium text-foreground">Proposals could not be loaded.</p> : null}
        {load.kind === "ready" ? (
          <>
            {load.body.invalidCount > 0 ? (
              <p className={HINT}>{`${load.body.invalidCount} proposal file(s) could not be verified and are not shown.`}</p>
            ) : null}
            {load.body.proposals.length === 0 ? <p className={HINT}>No proposals for this entity.</p> : (
              <List variant="divided">
                {load.body.proposals.map((v) => <ProposalItem key={v.id} v={v} />)}
              </List>
            )}
          </>
        ) : null}
      </Disclosure>
    </div>
  );
}
