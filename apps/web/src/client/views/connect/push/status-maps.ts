// apps/web/src/client/views/connect/push/status-maps.ts — tone/icon/text for the pair flow's callout and for a
// device's last-delivery badge. Feature-owned maps (defineStatusMap), never colours.
import type { DeliveryOutcome, DeviceSummary } from "@pulse/web-data/wire";
import { defineStatusMap } from "@/ui";

/** The presentational state of the pair flow's callout. */
export type PairingState = "outstanding" | "expired" | "paired" | "cancelled";

/** Pair-flow callout presentation per state; the settled states announce themselves (role status). */
export const PAIRING_STATE = defineStatusMap<PairingState>({
  outstanding: { tone: "info", icon: "clock", label: "Pairing code active" },
  expired: { tone: "warn", icon: "clock-alert", label: "Pairing code expired", role: "status" },
  paired: { tone: "ok", icon: "circle-check", label: "Device paired", role: "status" },
  cancelled: { tone: "neutral", icon: "ban", label: "Pairing code cancelled", role: "status" },
});

/** A device's last-delivery badge state. "none" = no delivery attempted yet. A device whose token was rejected is
 *  removed from the registry, so there is no token-removed state. */
export type DeliveryBadgeState = DeliveryOutcome | "none";

/** Last-delivery badge presentation. No role: a list renders many badges at once. */
export const DELIVERY_OUTCOME = defineStatusMap<DeliveryBadgeState>({
  delivered: { tone: "ok", icon: "circle-check", label: "Delivered" },
  failed: { tone: "danger", icon: "circle-x", label: "Failed" },
  dropped: { tone: "warn", icon: "triangle-alert", label: "Dropped" },
  none: { tone: "pending", icon: "circle-dashed", label: "No delivery yet" },
});

/** The badge state of a device: its last delivery outcome, or "none". */
export function deliveryStateOf(device: DeviceSummary): DeliveryBadgeState {
  return device.lastDelivery?.outcome ?? "none";
}
