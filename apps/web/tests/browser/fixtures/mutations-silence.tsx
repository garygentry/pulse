// apps/web/tests/browser/fixtures/mutations-silence.tsx — browser fixture page: the real "Silence…" slot
// (actions/silence.tsx) for the firing `fp-host-down` alert; the suites open the lazy SilenceDialog from
// it (10 §6). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { SilenceAction } from "../../../src/client/views/alerts/actions/silence.js";
import { FIXTURE_FINGERPRINTS } from "../../alerts-fixtures.js";
import { mountMutationsFixture } from "./mutations-render.js";

mountMutationsFixture("Silence an alert", (store) => {
  const alert = store.alerts.value!.alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.hostDown)!;
  return <SilenceAction alert={alert} store={store} />;
});
