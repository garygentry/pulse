// apps/web/tests/browser/fixtures/engine-all-green.tsx — browser fixture page: the real engine view
// over ENGINE_SCENARIOS.allGreen with five 200 trend payloads (08 §2.4). Bundled by
// _harness.buildFixturePage. Also hosts the perf hook (window.__engineFixture.loadEnvelope).
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ENGINE_SCENARIOS } from "../../engine-fixtures.js";
import { mountEngineFixture } from "./engine-render.js";

mountEngineFixture({ engine: ENGINE_SCENARIOS.allGreen() });
