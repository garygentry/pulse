// src/client/views/estate/provenance-chip.tsx — the file:line provenance copy chip (spec 06 §2).
//
// Renders an entity's declared location as a keyboard-operable <button>; activation copies the
// exact `file:line` string (NOT `WebProvenance.path` — that is the snake_case YAML field path,
// surfaced only as tooltip context; 06 §2.1 reconciliation). No file/network access (REQ-SEC-01).
// Text-only: the closed IconName union has no copy/clipboard glyph, so none is invented.

import type { ReactElement } from "react";
import type { WebProvenance } from "@pulse/renderer";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@/ui";
import { announce } from "../../a11y/index.js";
import { provenanceRef } from "./provenance.js";

/** Props for {@link ProvenanceChip}. Renders one entity's declared source location. */
export interface ProvenanceChipProps {
  /** The entity's declared location (00 §2). */
  readonly provenance: WebProvenance;
  /** Politeness of the post-copy confirmation announcement. Default "polite". */
  readonly announcePoliteness?: "polite" | "assertive";
  /** Optional extra class for layout composition by the host surface. */
  readonly className?: string;
}

/**
 * Copy the entity's `file:line` location to the clipboard, then announce success.
 * Never throws and never surfaces a user-facing error (tech-spec §7): a missing Clipboard API is a
 * benign no-op; a rejected write is caught silently. Only a successful write announces.
 */
export async function copyProvenance(
  provenance: WebProvenance,
  politeness: "polite" | "assertive" = "polite",
): Promise<void> {
  const ref = provenanceRef(provenance);
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    return; // clipboard unavailable → benign no-op (REQ-PROV-02)
  }
  try {
    await clipboard.writeText(ref);
    announce(`Copied ${ref} to clipboard`, politeness);
  } catch {
    // write rejected → no-op, no user-facing error (tech-spec §7). Deliberately silent.
  }
}

/** A keyboard-operable chip showing an entity's `file:line` location; activation copies it. */
export function ProvenanceChip({
  provenance,
  announcePoliteness = "polite",
  className,
}: ProvenanceChipProps): ReactElement {
  const ref = provenanceRef(provenance);
  const onActivate = (): void => {
    void copyProvenance(provenance, announcePoliteness);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className={cn(
            "h-auto min-h-6 max-w-full min-w-0 rounded-full py-0.5 font-mono text-xs font-normal whitespace-normal text-muted-foreground hover:text-foreground",
            className,
          )}
          data-provenance-file={provenance.file}
          aria-label={`Provenance ${ref}. Activate to copy to clipboard.`}
          onClick={onActivate}
        >
          {/* Wrap rather than truncate: a clipped file:line is useless and a nowrap chip forces
              horizontal scroll at narrow widths. */}
          <span className="min-w-0 wrap-anywhere">{ref}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{`${provenance.path} — activate to copy ${ref}`}</TooltipContent>
    </Tooltip>
  );
}
