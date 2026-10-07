// src/client/views/alerts/constants.ts — cross-cutting constants + the M1/M2 action-slot seam
// (00 §4.2, §6, §6.1). A leaf module: type-only wire import, no local imports.

import type { ActiveAlert } from "@pulse/web-data/wire";

/** DOM slot names M2 mounts into — the exposed action-slot seam (REQ-ACTION-01/03, 04 §8). */
export const ACTION_SLOTS = ["silence", "ack"] as const;
export type ActionSlotName = (typeof ACTION_SLOTS)[number];

/** Stable M1/M2 action-slot prop. mutation-foundation (M2) fills the placeholder bodies without
 *  changing this shape or the slot regions (REQ-ACTION-03). Carries no identity (REQ-SEC-02). */
export interface ActionProps {
  readonly alert: ActiveAlert;
}
