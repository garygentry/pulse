// apps/web/src/client/views/connect/push/revoke-dialog.tsx — the destructive confirmation before a paired device is
// revoked: an alertdialog whose initial focus is Cancel, with an inline error when the revoke fails.
import { useState, type ReactElement } from "react";
import type { DeviceSummary } from "@pulse/web-data/wire";
import { Callout } from "@/ui";

import { ActionButton } from "../../../mutations/ActionButton.js";
import { displayText } from "../../../mutations/client.js";
import { MutationDialogFrame } from "../../../mutations/dialog-frame.js";
import { pushErrorText, revokeDevice, type PushClientError } from "./push-api.js";

/** Props for {@link RevokeDialog}. */
export interface RevokeDialogProps {
  /** The device to revoke. */
  readonly device: DeviceSummary;
  /** Close without revoking (Cancel, Esc, or after success). */
  readonly onClose: () => void;
  /** Called after a successful revoke, before the dialog closes (the container refetches status). */
  readonly onRevoked: () => Promise<unknown>;
  /** The fetch used for the revoke request. */
  readonly fetchImpl: typeof fetch;
}

const CONSEQUENCE = "The device stops receiving notifications immediately and must be paired again to resume.";

/** Confirm, then revoke one device. A device that is already gone counts as revoked. */
export function RevokeDialog({ device, onClose, onRevoked, fetchImpl }: RevokeDialogProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushClientError | null>(null);
  const name = displayText(device.displayName);

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    void revokeDevice(device.id, fetchImpl).then(async (result) => {
      if (result.ok || result.error === "not-found") {
        await onRevoked();
        onClose();
        return;
      }
      setBusy(false);
      setError(result.error);
    });
  };

  return (
    <MutationDialogFrame
      open
      role="alertdialog"
      dismissable={!busy}
      onClose={onClose}
      title={`Revoke ${name}?`}
      description={CONSEQUENCE}
      actions={
        <>
          <ActionButton onClick={onClose}>Cancel</ActionButton>
          <ActionButton variant="danger" icon="trash-2" busy={busy} onClick={confirm}>
            Revoke device
          </ActionButton>
        </>
      }
    >
      <div data-slot="connect-push-revoke" className="flex flex-col gap-3">
        <p className="text-sm">The device stops receiving notifications immediately and must be paired again.</p>
        {error !== null ? (
          <Callout tone="danger" compact title="Could not revoke the device">
            {pushErrorText(error)}
          </Callout>
        ) : null}
      </div>
    </MutationDialogFrame>
  );
}
