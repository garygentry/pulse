// apps/web/tests/mutations-registry.test.ts — the append-only, POST-only, proxy-header-only mutation
// registry (mutation-foundation 03-mutation-dispatcher.md §2; 10-testing-strategy.md §3.2).
//
// Pure unit suite: no router, no DOM, no port. Proves REQ-SEAM-02 (no registry outside proxy-header mode)
// and REQ-SEAM-07 (POST-only, exact /api/mutations/ grammar, append-only, frozen ordered list).

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { MUTATION_PATH_PREFIX } from "../src/server/mutations/constants.js";
import {
  createMutationRegistry,
  MUTATION_ACTIONS,
  MutationRegistrationError,
  type MutationDefinition,
} from "../src/server/mutations/registry.js";
import { WebAppError } from "../src/shared/errors.js";

const body = z.object({ note: z.string().max(16) }).strict();
type Body = z.infer<typeof body>;

/** A minimal valid definition; `path` overridable. Omits the optional `validate` hook (00 §4.1). */
function def(path: string = "/api/mutations/acks"): MutationDefinition<Body, { readonly ok: true }> {
  return {
    method: "POST",
    path: path as `/api/mutations/${string}`,
    capability: "ack",
    action: "ack.set",
    body,
    auditTarget: (b) => `stub:${b.note}`,
    auditDetails: () => ({}),
    handler: async () => ({ outcome: "succeeded", status: 200, result: { ok: true } }),
  };
}

/** Run `fn`, returning the thrown value (or undefined). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("createMutationRegistry: proxy-header only (REQ-SEAM-02)", () => {
  test("auth mode none throws auth-mode AT CONSTRUCTION, path null, code MUTATION_REGISTRATION", () => {
    const err = thrownBy(() => createMutationRegistry("none"));
    expect(err).toBeInstanceOf(MutationRegistrationError);
    expect(err).toBeInstanceOf(WebAppError);
    const e = err as MutationRegistrationError;
    expect(e.rule).toBe("auth-mode");
    expect(e.path).toBeNull();
    expect(e.code).toBe("MUTATION_REGISTRATION");
    expect(e.name).toBe("MutationRegistrationError");
  });

  test("an unknown mode (JS caller / cast) also throws auth-mode", () => {
    const err = thrownBy(() => createMutationRegistry("anything" as unknown as "none"));
    expect((err as MutationRegistrationError).rule).toBe("auth-mode");
    expect((err as MutationRegistrationError).path).toBeNull();
  });

  test("proxy-header constructs a registry with exactly register/match/list and no removal member", () => {
    const registry = createMutationRegistry("proxy-header");
    expect(Object.keys(registry).sort()).toEqual(["list", "match", "register"]);
    for (const member of ["remove", "unregister", "delete", "clear"]) expect(member in registry).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

describe("register: POST-only (REQ-SEAM-07)", () => {
  test("a non-POST definition smuggled past the type (cast) throws rule method with the path", () => {
    const registry = createMutationRegistry("proxy-header");
    for (const verb of ["PUT", "PATCH", "DELETE", "GET", "post"]) {
      const bad = { ...def(), method: verb } as unknown as MutationDefinition<Body, { readonly ok: true }>;
      const err = thrownBy(() => registry.register(bad));
      expect(err).toBeInstanceOf(MutationRegistrationError);
      expect((err as MutationRegistrationError).rule).toBe("method");
      expect((err as MutationRegistrationError).path).toBe("/api/mutations/acks");
    }
    expect(registry.list()).toEqual([]);
  });
});

describe("register: exact /api/mutations/ path grammar (REQ-SEAM-07)", () => {
  test("the prefix constant is /api/mutations/", () => {
    expect(MUTATION_PATH_PREFIX).toBe("/api/mutations/");
  });

  test("the five 01 §3.4 paths register", () => {
    const registry = createMutationRegistry("proxy-header");
    const paths = [
      "/api/mutations/silences",
      "/api/mutations/silences/expire",
      "/api/mutations/acks",
      "/api/mutations/acks/remove",
      "/api/mutations/proposals",
    ];
    for (const p of paths) registry.register(def(p));
    expect(registry.list().map((d): string => d.path)).toEqual(paths);
  });

  test("off-prefix or ungrammatical paths throw rule path-prefix with the offending path", () => {
    const bad = [
      "/api/__stub", // wrong prefix
      "/api/mutation/acks", // near-miss prefix
      "/api/mutations/", // bare prefix
      "/api/mutations/acks/", // trailing slash
      "/api/mutations//acks", // empty segment
      "/api/mutations/Acks", // uppercase
      "/api/mutations/acks?x=1", // query
      "/api/mutations/ac%6bs", // percent-encoding
      "/api/mutations/-acks", // leading separator
      "/api/mutations/acks-", // trailing separator
      "/api/mutations/__stub", // underscore is outside [a-z0-9]
      "/API/MUTATIONS/acks",
    ];
    const registry = createMutationRegistry("proxy-header");
    for (const p of bad) {
      const err = thrownBy(() => registry.register(def(p)));
      expect(err, p).toBeInstanceOf(MutationRegistrationError);
      expect((err as MutationRegistrationError).rule, p).toBe("path-prefix");
      expect((err as MutationRegistrationError).path, p).toBe(p);
    }
    expect(registry.list()).toEqual([]);
  });
});

describe("register: append-only (REQ-SEAM-02, REQ-SEAM-07)", () => {
  test("a duplicate path throws rule duplicate-path and leaves the first definition in place", () => {
    const registry = createMutationRegistry("proxy-header");
    const first = def("/api/mutations/acks");
    registry.register(first);
    const err = thrownBy(() => registry.register({ ...def("/api/mutations/acks"), action: "ack.remove" }));
    expect((err as MutationRegistrationError).rule).toBe("duplicate-path");
    expect((err as MutationRegistrationError).path).toBe("/api/mutations/acks");
    expect(registry.list()).toHaveLength(1);
    expect(registry.match("/api/mutations/acks")?.action).toBe("ack.set");
  });

  test("list() is a frozen snapshot in registration order; later registrations do not mutate it", () => {
    const registry = createMutationRegistry("proxy-header");
    registry.register(def("/api/mutations/silences"));
    registry.register(def("/api/mutations/acks"));
    const snap = registry.list();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap.map((d): string => d.path)).toEqual(["/api/mutations/silences", "/api/mutations/acks"]);
    expect(() => (snap as unknown as unknown[]).push(def("/api/mutations/proposals"))).toThrow();
    registry.register(def("/api/mutations/proposals"));
    expect(snap).toHaveLength(2);
    expect(registry.list().map((d): string => d.path)).toEqual([
      "/api/mutations/silences",
      "/api/mutations/acks",
      "/api/mutations/proposals",
    ]);
  });

  test("each registered definition is frozen (cannot be swapped out later)", () => {
    const registry = createMutationRegistry("proxy-header");
    registry.register(def("/api/mutations/acks"));
    const stored = registry.match("/api/mutations/acks");
    expect(stored).toBeDefined();
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as unknown as { path: string }).path = "/api/mutations/other";
    }).toThrow();
  });

  test("a failed registration leaves no trace (list and match unchanged)", () => {
    const registry = createMutationRegistry("proxy-header");
    registry.register(def("/api/mutations/acks"));
    thrownBy(() => registry.register(def("/api/other")));
    thrownBy(() => registry.register({ ...def("/api/mutations/silences"), method: "PUT" } as unknown as MutationDefinition<Body, { readonly ok: true }>));
    thrownBy(() => registry.register(def("/api/mutations/acks")));
    expect(registry.list().map((d): string => d.path)).toEqual(["/api/mutations/acks"]);
    expect(registry.match("/api/mutations/silences")).toBeUndefined();
    expect(registry.match("/api/other")).toBeUndefined();
  });
});

describe("match: exact pathname equality (REQ-SEAM-07, REQ-COMPAT-03)", () => {
  test("only the exact registered string matches; variants miss (→ router M1 405)", () => {
    const registry = createMutationRegistry("proxy-header");
    registry.register(def("/api/mutations/acks"));
    registry.register(def("/api/mutations/acks/remove"));
    expect(registry.match("/api/mutations/acks")?.path).toBe("/api/mutations/acks");
    expect(registry.match("/api/mutations/acks/remove")?.path).toBe("/api/mutations/acks/remove");
    for (const miss of [
      "/api/mutations/acks/",
      "/api/mutations/ACKS",
      "/api/mutations/ac%6bs",
      "/api/mutations/acks?x=1",
      "/api/mutations/ack",
      "/api/mutations",
      "/api/mutations/",
      "/api/overview",
      "",
    ]) {
      expect(registry.match(miss), miss).toBeUndefined();
    }
  });
});

describe("MUTATION_ACTIONS (REQ-AUD-01)", () => {
  test("is the closed five-action set", () => {
    expect([...MUTATION_ACTIONS]).toEqual(["silence.create", "silence.expire", "ack.set", "ack.remove", "proposal.create"]);
  });
});
