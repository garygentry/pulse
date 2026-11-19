// apps/web/tests/contract/web-validators.test.ts — the web client's own validators accept every fixture
// whose index entry names one.

import { expect, test } from "bun:test";

import { validateLiveTick, validateOverviewSnapshotV2 } from "@pulse/web-data/wire";

import type { WebValidatorId } from "../../scripts/contract/types.js";
import { fixtureIndex, generatedText, GENERATION_TIMEOUT } from "./generated.js";

/** Why the named validator refuses the value, or null when it accepts. */
function refusal(validator: Exclude<WebValidatorId, null>, value: unknown): string | null {
  if (validator === "overview") {
    const result = validateOverviewSnapshotV2(value);
    return result.ok ? null : result.message;
  }
  return validateLiveTick(value) === null ? "not a valid live tick" : null;
}

test("every accepted fixture that names a web validator passes it", async () => {
  const index = await fixtureIndex();
  const named = index.fixtures.filter((entry) => entry.expect === "accept" && entry.webValidator !== null);
  const failures: string[] = [];
  for (const entry of named) {
    const reason = refusal(entry.webValidator!, JSON.parse(await generatedText(`contract/${entry.path}`)));
    if (reason !== null) failures.push(`${entry.path}: ${entry.webValidator} validator: ${reason}`);
  }
  expect(failures).toEqual([]);

  // Never vacuous: each validator has at least one fixture.
  expect(new Set(named.map((entry) => entry.webValidator))).toEqual(new Set(["overview", "tick"]));
  expect(named.map((entry) => entry.path)).toEqual([
    "fixtures/events/tick-typical.json",
    "fixtures/overview/all-optional.json",
    "fixtures/overview/empty.json",
    "fixtures/overview/max-size.json",
    "fixtures/overview/typical.json",
  ]);
}, GENERATION_TIMEOUT);

test("the validators are not trivially accepting", () => {
  expect(refusal("overview", {})).not.toBeNull();
  expect(refusal("tick", {})).not.toBeNull();
});

test("every data line of the typical and resume transcripts is a valid live tick", async () => {
  for (const name of ["stream-typical", "stream-resume-match"]) {
    const text = await generatedText(`contract/fixtures/events/${name}.sse`);
    const data = text.split("\n").filter((line) => line.startsWith("data: "));
    expect(data.length).toBeGreaterThan(0);
    for (const line of data) {
      expect(validateLiveTick(JSON.parse(line.slice("data: ".length)))).not.toBeNull();
    }
  }
}, GENERATION_TIMEOUT);
