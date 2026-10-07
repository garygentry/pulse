// apps/web/tests/browser/fixtures/mutations-badges.tsx — browser fixture page: the three action-state
// badges (acked / pending / failed) and the primary / secondary / danger ActionButton variants, for the
// axe, grayscale and contrast checks (10 §6; REQ-UX-04, REQ-A11Y-04). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ActionButton } from "../../../src/client/mutations/ActionButton.js";
import { StateBadge } from "../../../src/client/mutations/StateBadge.js";
import { mountMutationsFixture } from "./mutations-render.js";

mountMutationsFixture("Action states", () => (
  <>
    <ul className="fixture-mutations__badges" aria-label="Action states">
      <li><StateBadge state="acked" /></li>
      <li><StateBadge state="pending" /></li>
      <li><StateBadge state="failed" /></li>
    </ul>
    <p className="fixture-mutations__buttons">
      <ActionButton variant="primary" onClick={() => undefined}>Primary action</ActionButton>{" "}
      <ActionButton onClick={() => undefined}>Secondary action</ActionButton>{" "}
      <ActionButton variant="danger" onClick={() => undefined}>Danger action</ActionButton>
    </p>
  </>
));
