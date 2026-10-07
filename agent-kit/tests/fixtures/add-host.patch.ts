// agent-kit/tests/fixtures/add-host.patch.ts
// Scripted "add a host" operator mutation (06-testing-and-eval.md §4.2, REQ-EVAL-01).
//
// Appends a new managed-linux host (a valid collection_class from the reference estate) to the
// copied estate.yaml. A managed-linux host renders a per-host agent config `agent/<host>.yaml`,
// so the new host id appears verbatim in `render`'s filesWritten — the post-condition the
// deterministic gate asserts. Credentials: none needed here; node_exporter scrape only, so the
// patch introduces no literal (secret-safe by construction, REQ-SEC-01).

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { EstatePatch } from "./estate.js";
import { estateYamlPath } from "./estate.js";

/** The new host id — asserted present in estate.yaml and in render's filesWritten. */
const NEW_HOST = "harbor-web-03";

export const addHostPatch: EstatePatch = {
  task: "add-host",
  subject: NEW_HOST,
  apply(estateDir: string): void {
    const p = estateYamlPath(estateDir);
    const doc = parse(readFileSync(p, "utf8")) as { hosts: unknown[] };
    doc.hosts.push({
      name: NEW_HOST,
      collection_class: "managed-linux",
      delivery_form: "systemd",
      addresses: ["10.20.0.33"],
      exporter_ports: [9100], // node_exporter — a real scrape target, so the host is monitored
    });
    writeFileSync(p, stringify(doc), "utf8");
  },
};
