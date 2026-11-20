// apps/web/src/client/views/connect/push/devices-section.tsx — the "Paired devices" section on /connect: one row
// per device (name, times, environment, muted severities, last delivery) with a Revoke action.
import { useState, type ReactElement } from "react";
import type { DeviceSummary, PushEnvironment, PushPreferences } from "@pulse/web-data/wire";
import { Callout, EmptyState, Icon, List, ListItem, RelativeTime, Section, StatusBadge, formatTimestamp } from "@/ui";

import { ActionButton } from "../../../mutations/ActionButton.js";
import { displayText } from "../../../mutations/client.js";
import { RevokeDialog } from "./revoke-dialog.js";
import { DELIVERY_OUTCOME, deliveryStateOf } from "./status-maps.js";

/** Props for {@link DevicesSection}. */
export interface DevicesSectionProps {
  /** The paired devices, in the server's order (pairedAt ascending). */
  readonly devices: readonly DeviceSummary[];
  /** The server's device limit. */
  readonly maxDevices: number;
  /** Called after a successful revoke (the container refetches status). */
  readonly onRevoked: () => Promise<unknown>;
  /** The fetch used for revoke requests. */
  readonly fetchImpl: typeof fetch;
}

/** Operator-facing name of a device's push environment. */
function envText(environment: PushEnvironment | null): string {
  if (environment === "production") return "Production";
  if (environment === "sandbox") return "Sandbox (development build)";
  return "Not registered yet";
}

const SEVERITIES = ["critical", "warning", "info"] as const;

/** "Muted: …" for the severities a device turned off; null when none is muted. */
function mutedText(preferences: PushPreferences): string | null {
  const muted = SEVERITIES.filter((key) => !preferences[key]);
  if (muted.length === 0) return null;
  if (muted.length === SEVERITIES.length) return "Muted: all severities";
  return `Muted: ${muted.join(", ")}`;
}

/** The paired-device list with revoke, the device count and the cap warning. */
export function DevicesSection({ devices, maxDevices, onRevoked, fetchImpl }: DevicesSectionProps): ReactElement {
  const [target, setTarget] = useState<DeviceSummary | null>(null);
  const atCap = devices.length >= maxDevices;

  return (
    <Section data-slot="connect-push-devices" title="Paired devices" description={`${devices.length} of ${maxDevices} devices`}>
      {atCap ? (
        <Callout tone="warn" title="Device limit reached">
          {`This server already has ${devices.length} paired devices. Revoke one before pairing another.`}
        </Callout>
      ) : null}
      {devices.length === 0 ? (
        <EmptyState icon="bell-ring" title="No devices paired" description="Pair a device to send alert notifications to it." />
      ) : (
        <List variant="divided" aria-label="Paired devices">
          {devices.map((device) => {
            const name = displayText(device.displayName);
            const muted = mutedText(device.preferences);
            const last = device.lastDelivery;
            return (
              <ListItem
                key={device.id}
                // Narrow screens: the name and description take the row; badge and Revoke wrap below it,
                // Revoke still at the row end.
                className="max-sm:flex-wrap max-sm:[&>div:last-child]:ms-auto max-sm:[&>div:nth-child(2)]:basis-[calc(100%-2.25rem)] max-sm:[&>div:nth-child(3)]:ms-7"
                leading={<Icon name="smartphone" />}
                title={<span className="block truncate">{name}</span>}
                description={
                  <span className="flex flex-wrap gap-x-1">
                    <span>
                      Paired <RelativeTime value={device.pairedAt} />
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Seen <RelativeTime value={device.seenAt} />
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{envText(device.environment)}</span>
                  </span>
                }
                meta={StatusBadge.fromMap(DELIVERY_OUTCOME, deliveryStateOf(device), {
                  ...(last !== null ? { title: formatTimestamp(last.at) } : {}),
                  ...(last !== null && last.reason !== null ? { detail: last.reason } : {}),
                })}
                actions={
                  <ActionButton variant="danger" icon="trash-2" label={`Revoke ${name}`} onClick={() => setTarget(device)}>
                    Revoke
                  </ActionButton>
                }
              >
                {muted !== null ? <span className="text-muted-foreground">{muted}</span> : null}
              </ListItem>
            );
          })}
        </List>
      )}
      {target !== null ? (
        <RevokeDialog device={target} onClose={() => setTarget(null)} onRevoked={onRevoked} fetchImpl={fetchImpl} />
      ) : null}
    </Section>
  );
}
