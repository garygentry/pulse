// agent-kit/tests/error-surface.test.ts
// Error-surface locks (06-testing-and-eval.md §7, §9.1; 00-core-definitions.md §6).
//
// The generation/emit path is a stated-throws surface: a malformed unit, an unregistered
// ecosystem, or a slot the content depends on that is not supplied must THROW rather than emit
// degraded content. `pack-scaffold.test.ts` already locks the fourth class (SecretLiteralError);
// this suite covers the remaining three by driving each throw site with a deliberately invalid
// input and asserting the concrete subclass and its stable `.code`.

import { describe, expect, test } from "bun:test";

import {
  ContentValidationError,
  UnknownEcosystemError,
  SlotMismatchError,
} from "../src/emit/errors.js";
import { claudeEmitter } from "../src/emit/claude.js";
import { emitterFor } from "../src/emit/registry.js";
import { buildInventoryVocab } from "../src/slots/inventory-vocab.js";
import { buildSlots } from "../src/slots/index.js";
import type { ContentUnit, Ecosystem } from "../src/emit/types.js";

describe("error surface (00 §6 throwing assertions)", () => {
  test("a unit rendering no sections throws ContentValidationError through the emit path", () => {
    const slots = buildSlots();
    // A well-typed unit whose render() yields an empty body — the malformed-content case the
    // emitter's requireBody guard rejects (claude.ts) rather than emitting a blank file.
    const emptyUnit: ContentUnit = {
      id: "empty-body",
      kind: "guidance",
      frontmatter: { name: "Empty Body", description: "A unit that renders no sections." },
      targets: ["claude"],
      requirements: [],
      render: () => [],
    };
    let thrown: unknown;
    try {
      claudeEmitter.emit({ units: [emptyUnit] }, slots);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContentValidationError);
    expect((thrown as ContentValidationError).code).toBe("CONTENT_INVALID");
    expect((thrown as ContentValidationError).unitId).toBe("empty-body");
  });

  test("resolving an unregistered ecosystem throws UnknownEcosystemError", () => {
    // The registry is exhaustive by type, so an out-of-union ecosystem can only arrive via a cast
    // (e.g. a stale/invalid target string reaching emitterFor at runtime).
    const bogus = "nonexistent" as Ecosystem;
    let thrown: unknown;
    try {
      emitterFor(bogus);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownEcosystemError);
    expect((thrown as UnknownEcosystemError).code).toBe("UNKNOWN_ECOSYSTEM");
    expect((thrown as UnknownEcosystemError).ecosystem).toBe("nonexistent");
  });

  test("building the inventory vocab with a missing section summary throws SlotMismatchError", () => {
    // buildInventoryVocab derives its sections from the live schema; an empty summaries map leaves
    // a derived section with no authored prose — the drift the slot builder must fail loudly on.
    let thrown: unknown;
    try {
      buildInventoryVocab({});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlotMismatchError);
    expect((thrown as SlotMismatchError).code).toBe("SLOT_MISMATCH");
    expect((thrown as SlotMismatchError).slot).toBe("inventoryVocab");
  });
});
