// src/client/views/alerts/detail/Silences.tsx — matching silences, read-only.
//
// Resolves alert.silencedBy against payload.silences (join on ActiveSilence.id). Ids missing from the
// snapshot are counted and surfaced, never silently dropped. When a store is given, each listed
// silence carries a capability-gated ExpireButton; free text renders via displayText.
import type { ReactElement } from "react";

import { KeyValueList, List, ListItem, Section } from "@/ui";
import type { ActiveAlert, ActiveSilence, AlertsPayload } from "@pulse/web-data/wire";
import { matcherExpression } from "./silences-model.js";
import type { AppStore } from "../../../store/index.js";
import { displayText } from "../../../mutations/client.js";
import { ExpireButton } from "../../../mutations/ExpireButton.js";

/** Matching silences for the selected alert. `store` is optional (additive): without it the list is
 *  read-only; with it each silence offers a gated expire action. */
export function Silences(props: { alert: ActiveAlert; payload: AlertsPayload | null; store?: AppStore }): ReactElement | null {
  const ids = props.alert.silencedBy;
  if (ids.length === 0) return null; // not silenced → no silences subsection

  const byId = new Map<string, ActiveSilence>(
    (props.payload?.silences ?? []).map((s) => [s.id, s]),
  );
  const matched: ActiveSilence[] = ids
    .map((id) => byId.get(id))
    .filter((s): s is ActiveSilence => s !== undefined);
  const unresolved = ids.filter((id) => !byId.has(id));

  return (
    <Section level={3} title="Matching silences" data-section="silences">
      {matched.length > 0 ? (
        <List variant="card" aria-label="Silences matching this alert">
          {matched.map((s) => (
            <ListItem
              key={s.id}
              title={
                <span className="flex flex-wrap gap-1" data-silence-matchers={s.id}>
                  {s.matchers.map((m, i) => (
                    <code key={i} data-matcher="" className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal">
                      {displayText(matcherExpression(m))}
                    </code>
                  ))}
                </span>
              }
              {...(props.store !== undefined
                ? { actions: <ExpireButton silence={s} store={props.store} /> }
                : {})}
            >
              <KeyValueList
                className="mt-2"
                items={[
                  { label: "Creator", value: displayText(s.createdBy) },
                  { label: "Comment", value: s.comment !== "" ? displayText(s.comment) : "—" },
                  { label: "Expires", value: s.endsAt },
                ]}
              />
            </ListItem>
          ))}
        </List>
      ) : null}
      {unresolved.length > 0 ? (
        // silencedBy referenced ids not present in payload.silences (churned / dropped) — shown, not hidden.
        <p className="text-sm text-muted-foreground" data-unresolved-count={unresolved.length}>
          {unresolved.length} referenced silence{unresolved.length === 1 ? "" : "s"} not present in the
          current silences snapshot.
        </p>
      ) : null}
    </Section>
  );
}
