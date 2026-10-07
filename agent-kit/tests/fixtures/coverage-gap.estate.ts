// agent-kit/tests/fixtures/coverage-gap.estate.ts
// Scripted "explain a coverage finding" estate variant (06-testing-and-eval.md §4.2, REQ-EVAL-01).
//
// Unlike add-host/add-probe (which produce a clean, monitored estate), this fixture INTRODUCES a
// known declared-but-unmonitored service so `pulse coverage` reports a deterministic gap. It
// appends a managed http service with NO monitoring artifact (no ingress/deep_health/backup), so
// coverage buckets it as an unmonitored `service` gap named `<host>/<service>` and exits 1 — the
// oracle the deterministic explain-coverage assertion reads. Secret-safe: no credential written.

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { EstatePatch } from "./estate.js";
import { estateYamlPath } from "./estate.js";

/** The host the orphan service is declared on (an existing managed-linux host). */
export const GAP_HOST = "harbor-web-01";
/** The declared-but-unmonitored service — asserted present in coverage's data.gaps. */
const GAP_SERVICE = "orphan-svc";

export const coverageGapPatch: EstatePatch = {
  task: "explain-coverage",
  subject: GAP_SERVICE,
  apply(estateDir: string): void {
    const p = estateYamlPath(estateDir);
    const doc = parse(readFileSync(p, "utf8")) as { services: unknown[] };
    // A managed http service with no ingress_url / deep_health / backup_freshness → an
    // unmonitored coverage gap (declared, but nothing actually watches it).
    doc.services.push({
      name: GAP_SERVICE,
      host: GAP_HOST,
      kind: "http",
      managed: true,
    });
    writeFileSync(p, stringify(doc), "utf8");
  },
};
