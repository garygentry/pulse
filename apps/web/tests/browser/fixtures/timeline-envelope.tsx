// apps/web/tests/browser/fixtures/timeline-envelope.tsx — browser fixture page: the real timeline view
// over TIMELINE_ENVELOPE (100 hosts × 3 services, a 12-host incident in the last 6 h) at range 24h,
// every stubbed history reply delayed 50 ms (08 §2.4, §6). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { TIMELINE_ENVELOPE } from "../../timeline-fixtures.js";
import { mountTimelineFixture } from "./timeline-render.js";

mountTimelineFixture({ scenario: TIMELINE_ENVELOPE, query: "range=24h", delayMs: 50 });
