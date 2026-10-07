/** schema.test.ts — strict Zod shape layer (02-inventory-schema.md, 07 §3.1 schema).
 *
 *  Asserts: `.strict()` rejects an unknown key (unrecognized_keys); the host
 *  discriminatedUnion accepts each of the five classes with its required fields and rejects a
 *  class-specific field on the wrong arm; `schema_version` is required inside `estate`; a
 *  well-formed valid-min document safeParses with success:true; the five arm literals equal
 *  COLLECTION_CLASSES. */

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { inventorySchema, estateSchema, channelSchema } from "../src/schema/index.js";
import { hostSchema } from "../src/schema/host.js";
import { deepHealthProbeSchema } from "../src/schema/service.js";
import { COLLECTION_CLASSES } from "../src/schema/collection-class.js";
import type { Host } from "../src/model/index.js";

const FIXTURES = join(import.meta.dir, "fixtures");

// A minimal compile-time assertion helper (07 §1). Runs as a no-op at runtime; it exists so a
// contract *type* is stated where it must hold — e.g. that a Host arm's class-specific field is
// present only on its class (00 §3.2).
function assertType<_T>(_v: _T): void {
  /* type-level only */
}

describe("schema — .strict() unknown-key rejection", () => {
  test("an unknown top-level key yields unrecognized_keys", () => {
    const r = inventorySchema.safeParse({ hostz: [] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const codes = r.error.issues.map((i) => i.code);
    expect(codes).toContain("unrecognized_keys");
    const unk = r.error.issues.find((i) => i.code === "unrecognized_keys");
    expect((unk as { keys: string[] }).keys).toEqual(["hostz"]);
  });

  test("an unknown nested key on a host arm yields unrecognized_keys", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "compose",
      bogus_field: true,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
  });
});

describe("schema — channel kinds + options (issue #2)", () => {
  test("accepts kind: telegram with a non-secret options.chat_id", () => {
    const r = channelSchema.safeParse({
      name: "ops-telegram",
      kind: "telegram",
      credential: "${TELEGRAM_BOT_TOKEN}",
      options: { chat_id: -1002001002003 },
    });
    expect(r.success).toBe(true);
  });

  test("options accepts string/number/boolean scalar values", () => {
    const r = channelSchema.safeParse({
      name: "c",
      kind: "telegram",
      credential: "${T}",
      options: { chat_id: "@my_channel", message_thread_id: 42, disable_notification: true },
    });
    expect(r.success).toBe(true);
  });

  test(".strict() still rejects a typo'd top-level channel key", () => {
    const r = channelSchema.safeParse({
      name: "c",
      kind: "chat",
      credential: "${T}",
      optionz: { chat_id: 1 },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
  });
});

describe("schema — host discriminatedUnion accepts each class with its required fields", () => {
  const valid: Record<string, unknown> = {
    "managed-linux": {
      name: "web-01",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "compose",
    },
    "hypervisor-api": {
      name: "vc-01",
      collection_class: "hypervisor-api",
      addresses: ["10.0.0.2"],
      api_endpoint: "https://vc",
      credential: "op://v/i/f",
    },
    "nas-api": {
      name: "nas-01",
      collection_class: "nas-api",
      addresses: ["10.0.0.3"],
      api_endpoint: "https://nas",
      credential: "${NAS_TOKEN}",
    },
    "probe-only": {
      name: "probe-01",
      collection_class: "probe-only",
      addresses: ["10.0.0.4"],
      probe: { kind: "tcp", target: "10.0.0.4:443" },
    },
    excluded: {
      name: "old-01",
      collection_class: "excluded",
      addresses: ["10.0.0.5"],
      suppressed: { class: "excluded", rationale: "Decommissioned." },
    },
  };

  for (const cls of COLLECTION_CLASSES) {
    test(`accepts a well-formed ${cls} host`, () => {
      const r = hostSchema.safeParse(valid[cls]);
      expect(r.success).toBe(true);
    });
  }
});

describe("schema — host arm rejects wrong-arm / missing class fields", () => {
  test("a managed-linux host carrying api_endpoint (a hypervisor field) → unrecognized_keys", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "compose",
      api_endpoint: "https://x",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const unk = r.error.issues.find((i) => i.code === "unrecognized_keys");
    expect(unk).toBeDefined();
    expect((unk as { keys: string[] }).keys).toContain("api_endpoint");
  });

  test("a nas-api host parses with NO api_endpoint/credential (node_exporter default, issue #4)", () => {
    const r = hostSchema.safeParse({
      name: "nas",
      collection_class: "nas-api",
      addresses: ["10.0.0.6"],
    });
    expect(r.success).toBe(true);
  });

  test("a nas-api host still parses WITH api_endpoint + credential (opt-in override, issue #4)", () => {
    const r = hostSchema.safeParse({
      name: "nas",
      collection_class: "nas-api",
      addresses: ["10.0.0.6"],
      api_endpoint: "https://nas/api",
      credential: "${NAS_TOKEN}",
    });
    expect(r.success).toBe(true);
  });

  test("a nas-api host with only one override field parses at the SHAPE layer (both-or-neither is semantic, issue #4)", () => {
    // The both-or-neither rule is enforced by checkNasApiCompleteness (semantic), not the Zod
    // shape — a discriminatedUnion arm cannot carry a cross-field refine. So a partial host is
    // shape-valid here; the semantic layer is what rejects it (see validate.test.ts).
    const r = hostSchema.safeParse({
      name: "nas",
      collection_class: "nas-api",
      addresses: ["10.0.0.6"],
      api_endpoint: "https://nas/api",
    });
    expect(r.success).toBe(true);
  });

  test("a managed-linux host defaults cadvisor to false", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "systemd",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    if (r.data.collection_class !== "managed-linux") throw new Error("expected a managed-linux host");
    expect(r.data.cadvisor).toBe(false);
    expect(r.data.delivery_form).toBe("systemd");
  });

  test("a managed-linux host defaults heartbeat to true (issue #30)", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "systemd",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    if (r.data.collection_class !== "managed-linux") throw new Error("expected a managed-linux host");
    expect(r.data.heartbeat).toBe(true);
  });

  test("a managed-linux host accepts an explicit heartbeat opt-out (issue #30)", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      heartbeat: false,
      delivery_form: "systemd",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    if (r.data.collection_class !== "managed-linux") throw new Error("expected a managed-linux host");
    expect(r.data.heartbeat).toBe(false);
  });

  test("a managed-linux host accepts an explicit cadvisor opt-in", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      cadvisor: true,
      delivery_form: "compose",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    if (r.data.collection_class !== "managed-linux") throw new Error("expected a managed-linux host");
    expect(r.data.cadvisor).toBe(true);
    expect(r.data.delivery_form).toBe("compose");
  });

  test("a managed-linux host requires delivery_form", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.find((i) => i.path.join(".") === "delivery_form")?.code).toBe(
      "invalid_type",
    );
  });

  test("a managed-linux host rejects an unsupported delivery_form", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      exporter_ports: [9100],
      delivery_form: "containerd",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.find((i) => i.path.join(".") === "delivery_form")?.code).toBe(
      "invalid_enum_value",
    );
  });

  test("a managed-linux host missing exporter_ports → invalid_type (received undefined)", () => {
    const r = hostSchema.safeParse({
      name: "a",
      collection_class: "managed-linux",
      addresses: ["10.0.0.1"],
      delivery_form: "compose",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const iss = r.error.issues.find((i) => i.path.join(".") === "exporter_ports");
    expect(iss?.code).toBe("invalid_type");
    expect((iss as { received: string }).received).toBe("undefined");
  });

  test("an unknown/absent discriminant → invalid_union_discriminator", () => {
    const r = hostSchema.safeParse({ name: "a", collection_class: "not-a-class", addresses: ["1"] });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.code)).toContain("invalid_union_discriminator");
  });
});

describe("schema — deep-health credential references", () => {
  const probe = {
    endpoint: "/healthz",
    response_mapping: { status: "$.status" },
    alert_expression: "status != 1",
  };

  test("accepts absent, ${ENV}, and op:// credentials", () => {
    expect(deepHealthProbeSchema.safeParse(probe).success).toBe(true);
    expect(deepHealthProbeSchema.safeParse({ ...probe, credential: "${HEALTH_TOKEN}" }).success).toBe(
      true,
    );
    expect(
      deepHealthProbeSchema.safeParse({ ...probe, credential: "op://infra/health/token" }).success,
    ).toBe(true);
  });
});

describe("schema — estate requires schema_version", () => {
  test("estate without schema_version → invalid_type (received undefined) at schema_version", () => {
    const r = estateSchema.safeParse({
      name: "acme",
      domains: ["acme.internal"],
      timezone: "UTC",
      deadman_hook: "${DEADMAN}",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const iss = r.error.issues.find((i) => i.path.join(".") === "schema_version");
    expect(iss?.code).toBe("invalid_type");
    expect((iss as { received: string }).received).toBe("undefined");
  });
});

describe("schema — estate DNS resolver", () => {
  const estate = {
    schema_version: 1,
    name: "acme",
    domains: ["acme.internal"],
    timezone: "UTC",
    deadman_hook: "${DEADMAN}",
  };

  test("accepts an optional non-empty dns_resolver", () => {
    expect(estateSchema.safeParse({ ...estate, dns_resolver: "10.0.0.53" }).success).toBe(true);
    expect(estateSchema.safeParse(estate).success).toBe(true);
  });

  test("rejects empty and non-string dns_resolver values at the field", () => {
    for (const dns_resolver of ["", 53]) {
      const r = estateSchema.safeParse({ ...estate, dns_resolver });
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.some((i) => i.path.join(".") === "dns_resolver")).toBe(true);
    }
  });
});

describe("schema — valid-min document safeParses", () => {
  test("the committed valid-min document → success:true", () => {
    const doc = parse(readFileSync(join(FIXTURES, "valid-min/estate.yaml"), "utf8"));
    const r = inventorySchema.safeParse(doc);
    expect(r.success).toBe(true);
  });
});

describe("schema — the five arm literals equal COLLECTION_CLASSES", () => {
  test("hostSchema's discriminant literals match COLLECTION_CLASSES set-for-set", () => {
    const options = (hostSchema as unknown as {
      options: Array<{ shape: { collection_class: { value: string } } }>;
    }).options;
    const literals = options.map((o) => o.shape.collection_class.value);
    expect(new Set(literals)).toEqual(new Set(COLLECTION_CLASSES));
    expect(literals.length).toBe(COLLECTION_CLASSES.length);
  });

  test("[type] the excluded arm's `suppressed` field lives only on the excluded arm", () => {
    // If `h` is narrowed to the excluded arm, `suppressed` is present; on other arms it is not.
    const h = {
      name: "x",
      collectionClass: "excluded",
      addresses: [],
      suppressed: { class: "excluded", rationale: "r" },
      provenance: { file: "f", path: "p", line: 1, col: 1 },
    } as unknown as Host;
    if (h.collectionClass === "excluded") {
      assertType<{ class: string; rationale: string }>(h.suppressed);
    }
    expect(true).toBe(true);
  });
});
