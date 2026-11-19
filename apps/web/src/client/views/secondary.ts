// apps/web/src/client/views/secondary.ts — views reached from the command palette or by URL only.

import type { ViewDefinition } from "../../shared/registry.js";
import { connectView } from "./connect/index.js";

/**
 * Views that are routable, hosted by the outlet and listed in the command palette, but have no sidebar
 * entry and no kiosk rotation. Each entry omits `nav`. VIEWS, VIEW_IDS, live-state's VIEW_IDS, the
 * sidebar and kiosk rotation never read this list.
 */
export const SECONDARY_VIEWS: readonly ViewDefinition[] = [connectView];
