// apps/web/tests/browser/fixtures/timeline-incident.tsx — browser fixture page: the real timeline view
// over TIMELINE_INCIDENT (six overlapping criticals, an unmatched lane, an info lane and an unknown
// severity lane), with one host selected through ?sel=<targetKey> (its four curated charts render
// through the REAL lazy uPlot chart), a second host expanded by clicking its twisty (08 §2.4), and the
// Domains group expanded so its DNS-check rows are on the page (09 §3).
// Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { TIMELINE_INCIDENT } from "../../timeline-fixtures.js";
import { mountTimelineFixture, waitFor } from "./timeline-render.js";

const hosts = TIMELINE_INCIDENT.snapshot.hosts;
const selected = `host:${hosts[0]!.drilldownId}`;
const expanded = `host:${hosts[1]!.drilldownId}`;

mountTimelineFixture({
  scenario: TIMELINE_INCIDENT,
  query: `range=24h&sel=${encodeURIComponent(selected)}`,
  afterRender: async () => {
    const twisty = await waitFor<HTMLElement>(
      `[data-tree-row][data-lane-key="${expanded}"] [data-slot="timeline-lane-twisty"]`,
    );
    twisty.click();
    await waitFor(`[data-tree-row][data-lane-key="${expanded}"][aria-expanded="true"]`);
    const domains = await waitFor<HTMLElement>('[data-tree-row][data-lane-key="domains"] [data-slot="timeline-lane-twisty"]');
    domains.click();
    await waitFor('[data-tree-row][data-lane-key^="endpoint:dns:"]');
  },
});
