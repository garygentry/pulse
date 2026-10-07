// Keeps the alerts client's millisecond range mirror aligned with the web-data query catalog.

import { expect, test } from "bun:test";

import { RANGE_MS } from "../src/client/views/alerts/detail/history-model.js";
import { RANGE_IDS, RANGE_SECONDS } from "../../../packages/web-data/src/queries/ranges.js";

test("RANGE_MS mirrors every web-data range in milliseconds", () => {
  for (const id of RANGE_IDS) expect(RANGE_MS[id]).toBe(RANGE_SECONDS[id] * 1000);
});
