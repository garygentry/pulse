// agent-kit/tests/fixtures/add-probe.patch.ts
// Scripted "add a deep-health probe" operator mutation (06-testing-and-eval.md §4.2, REQ-EVAL-01).
//
// Adds a managed http service carrying a deep_health probe spec to an existing host. The rendered
// prober config gains a `deep-health` probe named `svc:<host>/<service>`, and the deep_health
// block (endpoint) lands in estate.yaml — the two post-conditions the deterministic gate asserts.
// The probe's credential is a ${ENV} SecretRef, never a literal (secret-safe, REQ-SEC-01).

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { EstatePatch } from "./estate.js";
import { estateYamlPath } from "./estate.js";

/** The host the new probed service attaches to (an existing managed-linux host). */
export const PROBE_HOST = "harbor-app-02";
/** The new service name carrying the deep-health probe — asserted in estate.yaml + prober config. */
const PROBE_SERVICE = "portal-api";

export const addProbePatch: EstatePatch = {
  task: "add-probe",
  subject: PROBE_SERVICE,
  apply(estateDir: string): void {
    const p = estateYamlPath(estateDir);
    const doc = parse(readFileSync(p, "utf8")) as { services: unknown[] };
    doc.services.push({
      name: PROBE_SERVICE,
      host: PROBE_HOST,
      kind: "http",
      managed: true,
      ingress_url: "https://portal-api.aurora.example",
      deep_health: {
        endpoint: "https://portal-api.aurora.example/api/health",
        response_mapping: { status: "$.status" },
        alert_expression: "pulse_deep_health_status == 0",
        credential: "${WEB_HEALTH_TOKEN}", // env SecretRef — never a literal
      },
    });
    writeFileSync(p, stringify(doc), "utf8");
  },
};
