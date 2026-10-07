// apps/web/tests/browser/fixtures/alerts-am-down.tsx — browser fixture page: the real alerts view over
// the `am-down` scenario. Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { mountAlertsFixture } from "./alerts-render.js";

mountAlertsFixture({ scenario: "am-down" });
