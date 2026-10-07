// apps/web/tests/browser/fixtures/engine-loading.tsx — browser fixture page: the real engine view
// before its first payload — engine null, delivery "initial" (08 §2.4, 04 §2.6: the aria-busy
// loading layout). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { mountEngineFixture } from "./engine-render.js";

mountEngineFixture({ engine: null, deliveryPhase: "initial" });
