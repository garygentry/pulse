// apps/web/tests/browser/fixtures/timeline-history-errors.tsx — browser fixture page: the real
// timeline view with every history region failing per cause (08 §2.4): alerts 502
// HISTORY_LIMIT_EXCEEDED (too-many), the coverage probe 503 NOT_READY, and a selected host whose
// memory chart answers 502 SOURCE_UNAVAILABLE while its other three charts render.
// Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { TIMELINE_INCIDENT } from "../../timeline-fixtures.js";
import { mountTimelineFixture } from "./timeline-render.js";

const selected = `host:${TIMELINE_INCIDENT.snapshot.hosts[0]!.drilldownId}`;

mountTimelineFixture({
  scenario: TIMELINE_INCIDENT,
  query: `range=24h&sel=${encodeURIComponent(selected)}`,
  alertsFailure: { status: 502, code: "HISTORY_LIMIT_EXCEEDED" },
  probeFailure: { status: 503, code: "NOT_READY" },
  chartFailures: { "host.memory.utilization": { status: 502, code: "SOURCE_UNAVAILABLE" } },
});
