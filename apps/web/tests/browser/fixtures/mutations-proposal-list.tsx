// apps/web/tests/browser/fixtures/mutations-proposal-list.tsx — browser fixture page: the real
// ProposalList disclosure for `host:harbor-web-01`, fed a pending / applied / rejected list by the stubbed
// GET /api/proposals (10 §6). Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";
import { ProposalList } from "../../../src/client/mutations/proposals/ProposalList.js";
import { mountMutationsFixture } from "./mutations-render.js";

mountMutationsFixture("Estate proposals", () => <ProposalList target={{ kind: "host", id: "host:harbor-web-01" }} />);
