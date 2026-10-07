// apps/web/src/client/views/engine/group-header.tsx — the header row shared by scrape jobs and rule
// groups: an h3 holding the disclosure button (named by the label alone), then the status badge and
// meta text outside the button, so they never become part of its accessible name.
import type { ReactElement, ReactNode } from "react";
import { Button, Icon } from "@/ui";

/** Props for {@link GroupHeader}. */
export interface GroupHeaderProps {
  /** Visible job/group label; it is the button's whole name. */ readonly label: string;
  /** Whether the body is shown. */ readonly expanded: boolean;
  /** Id of the body element the button controls. */ readonly bodyId: string;
  /** Toggle handler; null renders a non-interactive heading (kiosk). */ readonly onToggle: (() => void) | null;
  /** Status badge and meta text, rendered after the heading. */ readonly children: ReactNode;
}

/** One disclosure header: heading + button (desk) or plain heading (kiosk), then badge and meta. */
export function GroupHeader({ label, expanded, bodyId, onToggle, children }: GroupHeaderProps): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-group-header="">
      <h3 className="m-0 max-w-full shrink-0 text-sm font-medium">
        {onToggle === null ? (
          <span className="break-words">{label}</span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-auto max-w-full justify-start py-1 text-left whitespace-normal"
            aria-expanded={expanded ? "true" : "false"}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <Icon name={expanded ? "chevron-down" : "chevron-right"} aria-hidden="true" className="shrink-0" />
            <span className="break-words">{label}</span>
          </Button>
        )}
      </h3>
      {children}
    </div>
  );
}
