// apps/web/src/client/views/overview/grid/evidence.ts — bounded target-evidence text shared by host
// cells and service chips. Re-exported from HostCell.tsx, its spec home, and
// kept in a leaf module so ServiceChip can use it without an import cycle through HostCell.

import type { DataAvailability } from "@pulse/web-data/wire";

/** Return bounded target evidence text for visible and assistive presentation. */
export function lastGoodText(availability: DataAvailability): string {
  return availability.lastGoodAt === null
    ? "No successful observation"
    : `Last good observation: ${availability.lastGoodAt}`;
}
