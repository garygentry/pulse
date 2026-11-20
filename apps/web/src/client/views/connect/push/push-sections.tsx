// apps/web/src/client/views/connect/push/push-sections.tsx — the push additions to /connect. Renders nothing
// unless the server reports push as configured, so the page is unchanged where push is unavailable.
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Callout } from "@/ui";

import { DevicesSection } from "./devices-section.js";
import { PairSection } from "./pair-section.js";
import { pushErrorText } from "./push-api.js";
import { usePushStatus } from "./use-push-status.js";

/** The code link the page shows instead of the plain connect link. */
export interface PairingLinkOverride {
  readonly link: string;
  readonly caption: "Includes a one-time pairing code — don't share this screen";
}

/** Props for {@link PushSections}. */
export interface PushSectionsProps {
  /** null: never fetch, render nothing (test seam and kiosk). */
  readonly fetchImpl: typeof fetch | null;
  /** Whether the connect-link state is usable (the pair section is shown only then). */
  readonly linkUsable: boolean;
  /** Lifted state: report the override to the page. */
  readonly onLinkChange: (override: PairingLinkOverride | null) => void;
}

/** The pair and device sections, or null while loading or when push is not available. */
export function PushSections({ fetchImpl, linkUsable, onLinkChange }: PushSectionsProps): ReactElement | null {
  const [poll, setPoll] = useState(false);
  const { state, refresh } = usePushStatus(fetchImpl, poll);
  const report = useRef(onLinkChange);
  report.current = onLinkChange;

  const ready = state.kind === "ready";
  // Push went away (or never came): no override and no poll. On unmount the override is dropped too.
  useEffect(() => {
    if (!ready) {
      report.current(null);
      setPoll(false);
    }
  }, [ready]);
  useEffect(() => () => report.current(null), []);

  if (state.kind !== "ready" || fetchImpl === null) return null;
  const { status, refreshError } = state;

  return (
    <>
      {refreshError !== null ? (
        <Callout tone="warn" compact title="Push status could not be refreshed">
          {pushErrorText(refreshError)}
        </Callout>
      ) : null}
      <PairSection
        status={status}
        linkUsable={linkUsable}
        onLinkChange={onLinkChange}
        onPollChange={setPoll}
        refresh={refresh}
        fetchImpl={fetchImpl}
      />
      <DevicesSection devices={status.devices} maxDevices={status.maxDevices} onRevoked={refresh} fetchImpl={fetchImpl} />
    </>
  );
}
