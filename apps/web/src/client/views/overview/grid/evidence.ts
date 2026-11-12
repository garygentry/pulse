// apps/web/src/client/views/overview/grid/evidence.ts — bounded target-evidence text shared by host
// cells and service chips. Re-exported from HostCell.tsx, its spec home, and
// kept in a leaf module so ServiceChip can use it without an import cycle through HostCell.

import type { DataAvailability } from "@pulse/web-data/wire";
import type { EstateClock } from "../../../format.js";

/**
 * Return bounded target evidence text for visible and assistive presentation. With the estate clock
 * the time is in estate time like the rest of the app (F41), never a raw UTC ISO string.
 */
export function lastGoodText(availability: DataAvailability, clock?: EstateClock): string {
  if (availability.lastGoodAt === null) return "No successful observation";
  return `Last good observation: ${clock !== undefined ? clock.format(availability.lastGoodAt) : availability.lastGoodAt}`;
}
