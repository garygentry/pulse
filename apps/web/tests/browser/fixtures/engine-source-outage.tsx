// apps/web/tests/browser/fixtures/engine-source-outage.tsx — browser fixture page: the real engine
// view over ENGINE_SCENARIOS.sourceOutage with a persistently stale connection, so the verdict reads
// Unknown (08 §2.4, 03 §3.2 step 2). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ENGINE_SCENARIOS } from "../../engine-fixtures.js";
import { mountEngineFixture } from "./engine-render.js";

mountEngineFixture({ engine: ENGINE_SCENARIOS.sourceOutage(), deliveryPhase: "stale", connectionPhase: "stale" });
