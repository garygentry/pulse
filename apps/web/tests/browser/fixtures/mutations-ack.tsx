// apps/web/tests/browser/fixtures/mutations-ack.tsx — browser fixture page: the real ack slot
// (actions/ack.tsx) for the ALREADY-ACKED `fp-disk-full` alert, so the lazy AckDialog shows AckInfo plus
// Replace / Remove (10 §6). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { AckAction } from "../../../src/client/views/alerts/actions/ack.js";
import { FIXTURE_FINGERPRINTS } from "../../alerts-fixtures.js";
import { mountMutationsFixture } from "./mutations-render.js";

mountMutationsFixture("Acknowledge an alert", (store) => {
  const alert = store.alerts.value!.alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.diskFull)!;
  return <AckAction alert={alert} store={store} />;
});
