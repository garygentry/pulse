// apps/web/tests/browser/fixtures/engine-degraded.tsx — browser fixture page: the real engine view
// over ENGINE_SCENARIOS.degraded (08 §2.4), with one trend failing HISTORY_OVERLOADED (503,
// Retry-After) and one SOURCE_TIMEOUT (504). Gatus reads "unknown" and Grafana "not-configured" on
// top of the degraded vmalert, so all four component states are on the page for the grayscale suite
// (08 §4.3). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ENGINE_SCENARIOS } from "../../engine-fixtures.js";
import { mountEngineFixture } from "./engine-render.js";

const degraded = ENGINE_SCENARIOS.degraded();

mountEngineFixture({
  engine: {
    ...degraded,
    components: degraded.components.map((c) =>
      c.id === "gatus" ? { ...c, state: "unknown" as const }
        : c.id === "grafana" ? { ...c, state: "not-configured" as const }
        : c,
    ),
  },
  trendFailures: {
    "engine.ingestion-rate": { status: 503, code: "HISTORY_OVERLOADED", retryAfter: 30 },
    "engine.disk-usage": { status: 504, code: "SOURCE_TIMEOUT" },
  },
});
