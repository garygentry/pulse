// apps/web/tests/browser/fixtures/mutations-expire.tsx — browser fixture page: the real ExpireButton row
// action for the `silence-backup-window` silence; the suites open the lazy ExpireDialog from it (10 §6).
// Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ExpireButton } from "../../../src/client/mutations/ExpireButton.js";
import { FIXTURE_SILENCE_IDS } from "../../alerts-fixtures.js";
import { mountMutationsFixture } from "./mutations-render.js";

mountMutationsFixture("Expire a silence", (store) => {
  const silence = store.alerts.value!.silences.find((s) => s.id === FIXTURE_SILENCE_IDS.backup)!;
  return <ExpireButton silence={silence} store={store} />;
});
