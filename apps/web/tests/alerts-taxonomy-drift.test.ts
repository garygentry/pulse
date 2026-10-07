// apps/web/tests/alerts-taxonomy-drift.test.ts — the vendored SEVERITY_TAXONOMY must stay an exact
// full mirror of stack/alerting/contract/severity-taxonomy.json (CON-08, 00 §5.1). The source lives
// outside the bun workspace, so only this test reads it (by relative path: tests/ → apps/web →
// apps → repo root). ENOENT means the path anchor is wrong, not a real drift.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_HISTORY_RANGE, SEVERITY_TAXONOMY } from "../src/client/views/alerts/taxonomy.js";
import { INTERVAL_STATUS, severityToStatus, stateToStatus } from "../src/client/status/target-status.js";
import { ACTION_SLOTS } from "../src/client/views/alerts/constants.js";

const SOURCE_PATH = fileURLToPath(
  new URL("../../../stack/alerting/contract/severity-taxonomy.json", import.meta.url),
);

describe("alerts severity taxonomy", () => {
  test("vendored SEVERITY_TAXONOMY equals the source contract exactly", () => {
    const src: unknown = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
    expect(SEVERITY_TAXONOMY).toEqual(src as typeof SEVERITY_TAXONOMY);
  });

  test("taxonomy.ts never reads or imports the stack/ source at runtime", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../src/client/views/alerts/taxonomy.ts", import.meta.url)),
      "utf8",
    );
    expect(text).not.toMatch(/from\s+["'][^"']*stack\//);
    expect(text).not.toMatch(/readFileSync|node:fs/);
  });

  test("severityToStatus is total with an unknown fallback", () => {
    expect(severityToStatus("critical")).toBe("critical");
    expect(severityToStatus("warning")).toBe("warning");
    expect(severityToStatus("info")).toBe("unknown");
    expect(severityToStatus("page-me")).toBe("unknown");
    expect(severityToStatus("")).toBe("unknown");
    expect(severityToStatus("toString")).toBe("unknown");
  });

  test("stateToStatus maps firing via severity and suppression to suppressed", () => {
    expect(stateToStatus("firing", "critical")).toBe("critical");
    expect(stateToStatus("firing", "bogus")).toBe("unknown");
    expect(stateToStatus("silenced", "critical")).toBe("suppressed");
    expect(stateToStatus("inhibited", "warning")).toBe("suppressed");
  });

  test("INTERVAL_STATUS covers both interval states; history default is 24h", () => {
    expect(INTERVAL_STATUS).toEqual({ firing: "critical", failed: "warning" });
    expect(DEFAULT_HISTORY_RANGE).toBe("24h");
    expect(ACTION_SLOTS).toEqual(["silence", "ack"]);
  });
});
