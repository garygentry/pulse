// apps/web/tests/browser/fixtures/timeline-kiosk.tsx — browser fixture page: the real timeline view
// over TIMELINE_ENVELOPE with ?kiosk=1 (08 §2.4, §7). The mount creates its store with
// createAppStore({ storage: null, initialQuery: { kiosk: "1" } }), so density is wallboard and is
// mirrored onto <html data-density> as the shell would. Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { TIMELINE_ENVELOPE } from "../../timeline-fixtures.js";
import { mountTimelineFixture } from "./timeline-render.js";

mountTimelineFixture({ scenario: TIMELINE_ENVELOPE, query: "kiosk=1", delayMs: 50 });
