// apps/web/src/client/mutations/AckInfo.tsx — read-only; shown to EVERYONE incl. wallboard (AUTHZ-05 permits).
// REQ-ACK-07b, SEC-06/07. Every server string goes through displayText (inert text).
import type { ReactElement } from "react";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { KeyValue, KeyValueList } from "@/ui";
import { displayText } from "./client.js";
import { StateBadge } from "./StateBadge.js";

/** Alias of `AlertAck` (re-exported by the unedited /wire barrel's `export *`). */
export type AckView = NonNullable<ActiveAlert["ack"]>;

/** Read-only ack summary for an alert (who, when, note); renders nothing when there is no ack. */
export function AckInfo(p: { readonly ack: AckView | undefined }): ReactElement | null {
  if (p.ack === undefined) return null;
  return (
    <section className="grid gap-2 rounded-md border border-border p-3" aria-label="Acknowledgement">
      <StateBadge state="acked" />
      <KeyValueList>
        <KeyValue label="By">{displayText(p.ack.by)}</KeyValue>
        <KeyValue label="At"><time dateTime={p.ack.at}>{displayText(p.ack.at)}</time></KeyValue>
        {p.ack.note !== null ? (
          <KeyValue label="Note"><span className="whitespace-pre-wrap wrap-anywhere">{displayText(p.ack.note)}</span></KeyValue>
        ) : null}
      </KeyValueList>
    </section>
  );
}
