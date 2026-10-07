// src/client/views/alerts/detail/LabelsAnnotations.tsx — labels + annotations with safe links.
//
// `description` and `runbook_url` are KEYS inside `alert.annotations` (the wire type has no dedicated
// fields). Alert-provided URLs are untrusted: `safeHref` is the single helper every alert-URL render
// path uses.
import type { ReactElement } from "react";

import { Badge, ExternalLink, KeyValue, KeyValueList, Section } from "@/ui";
import type { ActiveAlert } from "@pulse/web-data/wire";
import { safeHref } from "./labels-annotations-model.js";

const RUNBOOK_KEY = "runbook_url";
const DESCRIPTION_KEY = "description";

/** Read-only labels + annotations for the selected alert. */
export function LabelsAnnotations(props: { alert: ActiveAlert }): ReactElement {
  const { labels, annotations } = props.alert;
  const description = annotations[DESCRIPTION_KEY];
  const runbook = annotations[RUNBOOK_KEY];
  const runbookHref = runbook !== undefined ? safeHref(runbook) : null;

  // Annotation rows other than description/runbook_url render as plain key/value text.
  const otherAnnotations = Object.entries(annotations).filter(
    ([k]) => k !== DESCRIPTION_KEY && k !== RUNBOOK_KEY,
  );

  return (
    <Section level={3} title="Labels and annotations" data-section="labels">
      {description !== undefined ? (
        <p className="text-sm text-muted-foreground" data-detail-description="">{description}</p>
      ) : null}

      {runbook !== undefined ? (
        runbookHref !== null ? (
          <ExternalLink href={runbookHref} className="min-h-11 self-start" data-runbook="">
            Runbook
          </ExternalLink>
        ) : (
          // Present but unsafe scheme — surface the raw value as inert text, never as a link.
          <p className="text-sm text-muted-foreground break-words" data-runbook="unsafe">
            Runbook link omitted (unsupported URL scheme): <code>{runbook}</code>
          </p>
        )
      ) : null}

      <KeyValueList>
        {Object.entries(labels).map(([key, value]) => (
          <KeyValue
            key={`l-${key}`}
            data-kind="label"
            label={<Badge variant="outline" className="font-mono">{key}</Badge>}
          >
            {value}
          </KeyValue>
        ))}
        {otherAnnotations.map(([key, value]) => (
          <KeyValue
            key={`a-${key}`}
            data-kind="annotation"
            label={
              <span className="inline-flex flex-wrap items-center gap-1">
                <Badge variant="secondary" className="font-mono">{key}</Badge>
                <span className="text-xs">annotation</span>
              </span>
            }
          >
            {value}
          </KeyValue>
        ))}
      </KeyValueList>
    </Section>
  );
}
