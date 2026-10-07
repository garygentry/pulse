// apps/web/tests/browser/fixtures/alerts-silences.tsx — browser fixture page: the real alerts view over
// the `mixed` scenario, deep link `?tab=silences`. Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { mountAlertsFixture } from "./alerts-render.js";

mountAlertsFixture({ scenario: "mixed", query: "tab=silences" });
