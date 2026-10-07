// apps/web/tests/browser/fixtures/alerts-mixed.tsx — browser fixture page: the real alerts view over
// the `mixed` scenario. Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { mountAlertsFixture } from "./alerts-render.js";

mountAlertsFixture({ scenario: "mixed" });
