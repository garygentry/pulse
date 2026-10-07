// apps/web/tests/browser/fixtures/mutations-propose.tsx — browser fixture page: the real "Propose edit…"
// trigger for the managed-linux reference host `harbor-web-01`; the suites open the lazy ProposeDialog
// from it (10 §6). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ProposeEditAction } from "../../../src/client/mutations/ProposeEditAction.js";
import { REFERENCE_MODEL, mountMutationsFixture } from "./mutations-render.js";

const HOST_ID = "host:harbor-web-01";

mountMutationsFixture("Propose an estate edit", (store) => {
  const host = REFERENCE_MODEL.hosts.find((h) => h.drilldownId === HOST_ID)!;
  return <ProposeEditAction store={store} target={{ kind: "host", id: HOST_ID }} declared={host} />;
});
