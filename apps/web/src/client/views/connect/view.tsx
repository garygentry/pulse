// apps/web/src/client/views/connect/view.tsx — the `/connect` page: a connect link for the phone app as a
// scannable code and as copyable text, or the reason no link can be shown.
import { useMemo, useState, type ReactElement } from "react";
import { CONNECT_LINK_MAX_LENGTH, encodeQrMatrix, type QrMatrix } from "@pulse/web-data/contract";
import { Callout, CodeBlock, ErrorState, LoadingState, PageHeader, Section } from "@/ui";

import type { ViewProps } from "../../../shared/registry.js";
import { isKiosk } from "../../shell/kiosk.js";
import { PushSections, type PairingLinkOverride } from "./push/push-sections.js";
import { QrCode } from "./qr-code.js";
import { useConnectLink, type ConnectLinkState } from "./use-connect-link.js";

type RefusedState = Extract<ConnectLinkState, { kind: "refused" }>;
type UsableState = Extract<ConnectLinkState, { kind: "usable" }>;

const ENV_VAR = "PULSE_WEB_EXTERNAL_URL";

/** What the shell hands every view, plus the two seams the test suite injects. The page reads no store
 *  signals. */
export interface ConnectViewProps extends Partial<ViewProps> {
  /** Replaces `fetch` for the connect-link request. Must be stable across renders. */
  readonly fetchImpl?: typeof fetch;
  /** Replaces `window.location.origin` as the address being browsed. */
  readonly origin?: string;
  /**
   * Replaces `fetch` for the push routes. Defaults to the global `fetch` only when `fetchImpl` is also
   * undefined (production); when a test injects `fetchImpl` alone it defaults to `null` (no push request).
   * `null` disables push explicitly.
   */
  readonly pushFetchImpl?: typeof fetch | null;
}

/** Copy for the refused state: the title names the cause, the body says how to fix it. The refused
 *  address itself is never shown. Pure; exported for the test suite. */
export function refusalCopy(state: RefusedState): { readonly title: string; readonly body: string } {
  if (state.cause === "config") {
    switch (state.reason) {
      case "loopback":
        return {
          title: `No connect link: ${ENV_VAR} is a loopback address`,
          body: `A phone cannot reach a loopback address. Set ${ENV_VAR} to the server's https address and restart Pulse.`,
        };
      case "too-long":
        return {
          title: `No connect link: ${ENV_VAR} is too long`,
          body: `The link would be longer than ${CONNECT_LINK_MAX_LENGTH} characters and could not be scanned. Use a shorter https address for ${ENV_VAR}.`,
        };
      // The server refuses to start on an unreadable address or one with credentials, so for a
      // configured address those reasons cannot arrive; they get the general fix.
      case "not-https":
      case "unparseable":
      case "credentials":
        return {
          title: `No connect link: ${ENV_VAR} does not use HTTPS`,
          body: `Set ${ENV_VAR} to the server's https address and restart Pulse.`,
        };
    }
  }
  switch (state.reason) {
    case "not-https":
      return {
        title: "No connect link: you are browsing Pulse over http",
        body: `Browse Pulse by its https address, or set ${ENV_VAR} to the server's https address.`,
      };
    case "loopback":
      return {
        title: "No connect link: you are browsing Pulse on a loopback address",
        body: `A phone cannot reach this address. Browse Pulse by its https address, or set ${ENV_VAR}.`,
      };
    case "too-long":
      return {
        title: "No connect link: this address is too long",
        body: `Set ${ENV_VAR} to a shorter https address.`,
      };
    case "unparseable":
      return {
        title: "No connect link: this address could not be read",
        body: `Set ${ENV_VAR} to the server's https address.`,
      };
    case "credentials":
      return {
        title: "No connect link: this address carries credentials",
        body: `Set ${ENV_VAR} to the server's https address, without a user name or password.`,
      };
  }
}

/** Where the usable link's address came from, and for a browsing address how to pin it. */
function sourceCaption(state: UsableState): string {
  return state.source === "configured"
    ? `Address from ${ENV_VAR}: ${state.baseUrl}`
    : `Address you are browsing: ${state.baseUrl}. Set ${ENV_VAR} so every operator gets the same link.`;
}

function Refused({ state }: { readonly state: RefusedState }): ReactElement {
  const copy = refusalCopy(state);
  return (
    <Callout data-slot="connect-refused" tone="danger" title={copy.title}>
      {copy.body}
    </Callout>
  );
}

function Usable({
  state,
  pairing,
}: {
  readonly state: UsableState;
  readonly pairing: PairingLinkOverride | null;
}): ReactElement {
  // While a pairing code is outstanding the page shows its link instead of the plain connect link.
  const link = pairing?.link ?? state.link;
  // Encoding is the expensive part; a link too long for a scannable code has no matrix.
  const matrix = useMemo((): QrMatrix | null => {
    try {
      return encodeQrMatrix(link, { ecc: "M" });
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }, [link]);

  if (matrix === null) {
    return (
      <Refused
        state={{ kind: "refused", reason: "too-long", cause: state.source === "configured" ? "config" : "browsing" }}
      />
    );
  }
  return (
    <Section title="Connect link" description={pairing?.caption ?? sourceCaption(state)}>
      <div data-slot="connect-link" className="flex flex-col items-center gap-4 md:flex-row md:items-start">
        {/* Holds the code at its full size beside the link: without it the row shrinks both. */}
        <div className="w-full max-w-64 shrink-0 md:w-72 md:max-w-72">
          <QrCode matrix={matrix} label={link} />
        </div>
        <CodeBlock code={link} copy wrap className="w-full min-w-0" />
      </div>
    </Section>
  );
}

/** The `/connect` page. Anyone who can load the web UI can see it; it has no gate of its own. */
export function ConnectView({ router, fetchImpl, origin, pushFetchImpl }: ConnectViewProps): ReactElement {
  const { state, retry } = useConnectLink(fetchImpl, origin);
  const [pairing, setPairing] = useState<PairingLinkOverride | null>(null);
  // Kiosk drops the shell's outlet padding, so the page brings its own gutter there. The page is in
  // no rotation, so the flag is read once per render rather than subscribed to.
  const kiosk = router !== undefined && isKiosk(router.current().query);
  // A kiosk is a shared wallboard: no pairing code and no device list there.
  const resolvedPushFetch = kiosk ? null : pushFetchImpl !== undefined ? pushFetchImpl : fetchImpl === undefined ? fetch : null;

  return (
    <div
      data-slot="connect-page"
      data-region={state.kind}
      data-kiosk={kiosk ? "1" : "0"}
      className={kiosk ? "flex min-w-0 flex-col gap-6 p-4" : "flex min-w-0 flex-col gap-6"}
    >
      <PageHeader title="Connect a phone" description="Scan this code with the Pulse app, or copy the link into it." />
      {state.kind === "loading" ? <LoadingState label="Loading the connect link" /> : null}
      {state.kind === "error" ? (
        <ErrorState title="Could not load the connect link" message={state.error.message} onRetry={retry} />
      ) : null}
      {state.kind === "refused" ? <Refused state={state} /> : null}
      {state.kind === "usable" ? <Usable state={state} pairing={pairing} /> : null}
      <PushSections fetchImpl={resolvedPushFetch} linkUsable={state.kind === "usable"} onLinkChange={setPairing} />
    </div>
  );
}
