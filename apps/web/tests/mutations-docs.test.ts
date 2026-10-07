/**
 * mutations-docs.test.ts — the operator write-path doc (04 §9.2; REQ-AUD-04, SC-08).
 *
 * Protects: docs/operator/write-path.md exists with Starlight frontmatter, states the audit location,
 * that the app does no in-app rotation, a growth estimate and backup guidance, covers the forward-auth
 * prerequisite, env table, degraded reasons and the five write-path metric families, and is
 * self-contained (no `specs/` reference).
 * Non-goals: prose quality, link checking, the rendered docs site (docs:build covers that).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOC = readFileSync(resolve(import.meta.dir, "../../../docs/operator/write-path.md"), "utf8");

describe("operator write-path doc (REQ-AUD-04, SC-08)", () => {
  test("has Starlight frontmatter (title, description, slug)", () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(DOC);
    expect(fm, "frontmatter block").not.toBeNull();
    expect(fm![1]).toMatch(/^title: \S/m);
    expect(fm![1]).toMatch(/^description: \S/m);
    expect(fm![1]).toMatch(/^slug: write-path$/m);
  });

  test("states the audit location, no in-app rotation, a growth estimate and backup guidance (REQ-AUD-04)", () => {
    expect(DOC).toContain("/data/audit/audit.jsonl");
    expect(DOC).toContain("PULSE_WEB_AUDIT_PATH");
    expect(DOC).toMatch(/no in-app rotation/i);
    expect(DOC).toMatch(/400 KB\/day/);
    expect(DOC).toMatch(/150 MB\/year/);
    expect(DOC).toMatch(/35 MB\/year/);
    expect(DOC).toMatch(/^## Backups$/m);
    expect(DOC).toMatch(/Back up `\/data`/);
  });

  test("covers forward-auth, env, volume layout, secret, degraded reasons and health (SC-08)", () => {
    expect(DOC).toMatch(/preserve `Host`/);
    for (const env of [
      "PULSE_WEB_AUTH_MODE",
      "PULSE_WEB_AUTH_HEADER",
      "PULSE_WEB_TRUSTED_PROXIES",
      "PULSE_WEB_DATA_DIR",
      "PULSE_WEB_ACK_STORE_PATH",
      "PULSE_WEB_PROPOSALS_DIR",
      "PULSE_PROPOSAL_SECRET",
    ]) {
      expect(DOC, env).toContain(env);
    }
    expect(DOC).toContain("pulse-web-data");
    expect(DOC).toMatch(/single replica/i);
    expect(DOC).toContain("openssl rand -base64 48");
    for (const reason of [
      "not-configured",
      "missing",
      "unwritable",
      "corrupt",
      "secret-missing",
      "secret-too-short",
      "write-failed",
      "auth-mode-none",
    ]) {
      expect(DOC, reason).toContain(`\`${reason}\``);
    }
    for (const fam of [
      "pulse_web_write_path_status",
      "pulse_web_mutations_total",
      "pulse_web_mutation_refusals_total",
      "pulse_web_audit_write_failures_total",
      "pulse_web_ack_auto_clears_total",
    ]) {
      expect(DOC, fam).toContain(fam);
    }
    expect(DOC).toContain("/healthz");
  });

  test("is self-contained: no specs/ reference (REQ-AUD-04, SC-08)", () => {
    expect(DOC).not.toContain("specs/");
  });
});
