import { describe, expect, test } from "bun:test";
import { classifyShapeDiff, requiredVersionBump, shapeRootOf } from "../../scripts/contract/classify-shape-diff.js";
import type { ShapeChange, ShapeNode, ShapeSnapshot } from "../../scripts/contract/shape-types.js";

const VERSION = { major: 1, minor: 0 } as const;

function node(path: string, kind: ShapeNode["kind"], extra: Partial<Omit<ShapeNode, "path" | "kind">> = {}): ShapeNode {
  return { path, kind, optional: false, nullable: false, ...extra };
}

function snapshot(roots: Record<string, readonly ShapeNode[]>): ShapeSnapshot {
  return { version: VERSION, roots };
}

/** A small payload with one node of every kind the classifier treats specially. */
const BASE: readonly ShapeNode[] = [
  node("Payload", "object"),
  node("Payload.id", "string"),
  node("Payload.count", "number"),
  node("Payload.note", "string", { optional: true }),
  node("Payload.endedAt", "string", { nullable: true }),
  node("Payload.formatVersion", "literal", { members: ["2"] }),
  node("Payload.state", "literal-union", { members: ["failed", "ok"] }),
  node("Payload.value", "scalar-union", { members: ["number", "string"] }),
  node("Payload.hosts", "array"),
  node("Payload.hosts[]", "object"),
  node("Payload.hosts[].collectionClass", "literal-union", { members: ["managed-linux", "probe-only"] }),
  node("Payload.hosts[](collectionClass=managed-linux).detail", "object"),
  node("Payload.hosts[](collectionClass=managed-linux).detail.heartbeat", "boolean"),
  node("Payload.hosts[](collectionClass=probe-only).detail", "object"),
  node("Payload.hosts[](collectionClass=probe-only).detail.target", "string"),
];

/** Apply an edit to a copy of BASE and classify the result against BASE. */
function diffAfter(edit: (nodes: ShapeNode[]) => ShapeNode[]) {
  return classifyShapeDiff(snapshot({ Payload: BASE }), snapshot({ Payload: edit([...BASE]) }));
}

function replace(path: string, next: ShapeNode): (nodes: ShapeNode[]) => ShapeNode[] {
  return (nodes) => {
    expect(nodes.some((n) => n.path === path)).toBe(true);
    return nodes.map((n) => (n.path === path ? next : n));
  };
}

function remove(prefix: string): (nodes: ShapeNode[]) => ShapeNode[] {
  return (nodes) => nodes.filter((n) => n.path !== prefix && !n.path.startsWith(prefix));
}

interface Row {
  readonly name: string;
  readonly edit: (nodes: ShapeNode[]) => ShapeNode[];
  readonly changes: readonly ShapeChange[];
  readonly class: "additive" | "breaking";
}

const ROWS: readonly Row[] = [
  {
    name: "an optional field is added",
    edit: (nodes) => [...nodes, node("Payload.hint", "string", { optional: true })],
    changes: [{ path: "Payload.hint", change: "field-added", class: "additive" }],
    class: "additive",
  },
  {
    name: "a required field is added",
    edit: (nodes) => [...nodes, node("Payload.owner", "string")],
    changes: [{ path: "Payload.owner", change: "field-added", class: "additive" }],
    class: "additive",
  },
  {
    name: "a field is removed",
    edit: remove("Payload.count"),
    changes: [{ path: "Payload.count", change: "field-removed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a field is renamed (remove + add)",
    edit: (nodes) => [...remove("Payload.count")(nodes), node("Payload.total", "number")],
    changes: [
      { path: "Payload.count", change: "field-removed", class: "breaking" },
      { path: "Payload.total", change: "field-added", class: "additive" },
    ],
    class: "breaking",
  },
  {
    name: "a field is retyped",
    edit: replace("Payload.count", node("Payload.count", "string")),
    changes: [{ path: "Payload.count", change: "kind-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a literal union is widened to its primitive",
    edit: replace("Payload.state", node("Payload.state", "string")),
    changes: [{ path: "Payload.state", change: "kind-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "an optional field becomes required",
    edit: replace("Payload.note", node("Payload.note", "string")),
    changes: [{ path: "Payload.note", change: "optional-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a required field becomes optional",
    edit: replace("Payload.id", node("Payload.id", "string", { optional: true })),
    changes: [{ path: "Payload.id", change: "optional-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a field becomes nullable",
    edit: replace("Payload.id", node("Payload.id", "string", { nullable: true })),
    changes: [{ path: "Payload.id", change: "nullable-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a field stops being nullable",
    edit: replace("Payload.endedAt", node("Payload.endedAt", "string")),
    changes: [{ path: "Payload.endedAt", change: "nullable-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a literal union gains a member",
    edit: replace("Payload.state", node("Payload.state", "literal-union", { members: ["failed", "ok", "stale"] })),
    changes: [{ path: "Payload.state", change: "member-added", class: "additive" }],
    class: "additive",
  },
  {
    name: "a literal union loses a member",
    edit: replace("Payload.state", node("Payload.state", "literal", { members: ["ok"] })),
    changes: [{ path: "Payload.state", change: "member-removed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a literal becomes a literal union (not a kind change)",
    edit: replace("Payload.formatVersion", node("Payload.formatVersion", "literal-union", { members: ["2", "3"] })),
    changes: [{ path: "Payload.formatVersion", change: "member-added", class: "additive" }],
    class: "additive",
  },
  {
    name: "a literal changes its value",
    edit: replace("Payload.formatVersion", node("Payload.formatVersion", "literal", { members: ["3"] })),
    changes: [
      { path: "Payload.formatVersion", change: "member-added", class: "additive" },
      { path: "Payload.formatVersion", change: "member-removed", class: "breaking" },
    ],
    class: "breaking",
  },
  {
    name: "a scalar union gains a member",
    edit: replace("Payload.value", node("Payload.value", "scalar-union", { members: ["boolean", "number", "string"] })),
    changes: [{ path: "Payload.value", change: "member-added", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a scalar union loses a member",
    edit: replace("Payload.value", node("Payload.value", "scalar-union", { members: ["number", "string"].slice(1) })),
    changes: [{ path: "Payload.value", change: "member-removed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a scalar union narrows to one primitive",
    edit: replace("Payload.value", node("Payload.value", "string")),
    changes: [{ path: "Payload.value", change: "kind-changed", class: "breaking" }],
    class: "breaking",
  },
  {
    name: "a discriminated union gains a variant subtree",
    edit: (nodes) => [
      ...replace(
        "Payload.hosts[].collectionClass",
        node("Payload.hosts[].collectionClass", "literal-union", { members: ["managed-linux", "nas-api", "probe-only"] }),
      )(nodes),
      node("Payload.hosts[](collectionClass=nas-api).detail", "object"),
      node("Payload.hosts[](collectionClass=nas-api).detail.apiEndpoint", "string", { nullable: true }),
    ],
    changes: [
      { path: "Payload.hosts[](collectionClass=nas-api).detail", change: "field-added", class: "additive" },
      { path: "Payload.hosts[](collectionClass=nas-api).detail.apiEndpoint", change: "field-added", class: "additive" },
      { path: "Payload.hosts[].collectionClass", change: "member-added", class: "additive" },
    ],
    class: "additive",
  },
  {
    name: "a discriminated union loses a variant subtree",
    edit: (nodes) =>
      replace(
        "Payload.hosts[].collectionClass",
        node("Payload.hosts[].collectionClass", "literal", { members: ["managed-linux"] }),
      )(remove("Payload.hosts[](collectionClass=probe-only)")(nodes)),
    changes: [
      { path: "Payload.hosts[](collectionClass=probe-only).detail", change: "field-removed", class: "breaking" },
      { path: "Payload.hosts[](collectionClass=probe-only).detail.target", change: "field-removed", class: "breaking" },
      { path: "Payload.hosts[].collectionClass", change: "member-removed", class: "breaking" },
    ],
    class: "breaking",
  },
  {
    name: "a field inside one variant is retyped",
    edit: replace(
      "Payload.hosts[](collectionClass=managed-linux).detail.heartbeat",
      node("Payload.hosts[](collectionClass=managed-linux).detail.heartbeat", "string"),
    ),
    changes: [
      {
        path: "Payload.hosts[](collectionClass=managed-linux).detail.heartbeat",
        change: "kind-changed",
        class: "breaking",
      },
    ],
    class: "breaking",
  },
  {
    name: "an optional field is added inside one variant",
    edit: (nodes) => [
      ...nodes,
      node("Payload.hosts[](collectionClass=probe-only).detail.expect", "string", { optional: true }),
    ],
    changes: [
      { path: "Payload.hosts[](collectionClass=probe-only).detail.expect", change: "field-added", class: "additive" },
    ],
    class: "additive",
  },
];

describe("classifyShapeDiff", () => {
  test("identical snapshots have no changes", () => {
    const diff = diffAfter((nodes) => nodes);
    expect(diff).toEqual({ class: "none", changes: [] });
    expect(requiredVersionBump(diff)).toBe("none");
  });

  test("node order does not matter", () => {
    expect(diffAfter((nodes) => nodes.reverse())).toEqual({ class: "none", changes: [] });
  });

  for (const row of ROWS) {
    test(`${row.name} → ${row.class}`, () => {
      const diff = diffAfter(row.edit);
      expect(diff.changes).toEqual([...row.changes]);
      expect(diff.class).toBe(row.class);
      expect(requiredVersionBump(diff)).toBe(row.class === "breaking" ? "major" : "minor");
    });
  }

  test("a root only in current is root-added, additive", () => {
    const diff = classifyShapeDiff(snapshot({ Payload: BASE }), snapshot({ Payload: BASE, Extra: [node("Extra", "object")] }));
    expect(diff).toEqual({ class: "additive", changes: [{ path: "Extra", change: "root-added", class: "additive" }] });
  });

  test("a root only in previous is root-removed, breaking", () => {
    const diff = classifyShapeDiff(snapshot({ Payload: BASE, Extra: [node("Extra", "object")] }), snapshot({ Payload: BASE }));
    expect(diff).toEqual({ class: "breaking", changes: [{ path: "Extra", change: "root-removed", class: "breaking" }] });
  });

  test("a removed subtree reports its children too", () => {
    const diff = diffAfter(remove("Payload.hosts"));
    expect(diff.class).toBe("breaking");
    expect(diff.changes.map((c) => c.path)).toEqual(
      BASE.filter((n) => n.path.startsWith("Payload.hosts")).map((n) => n.path).sort(),
    );
    expect(diff.changes.every((c) => c.change === "field-removed" && c.class === "breaking")).toBe(true);
  });

  test("several changes on one node are each reported, sorted by path then change", () => {
    const diff = diffAfter((nodes) => [
      node("Payload.zeta", "string", { optional: true }),
      ...replace("Payload.id", node("Payload.id", "number", { optional: true, nullable: true }))(nodes),
    ]);
    expect(diff.changes).toEqual([
      { path: "Payload.id", change: "kind-changed", class: "breaking" },
      { path: "Payload.id", change: "nullable-changed", class: "breaking" },
      { path: "Payload.id", change: "optional-changed", class: "breaking" },
      { path: "Payload.zeta", change: "field-added", class: "additive" },
    ]);
    expect(diff.class).toBe("breaking");
  });

  test("breaking outranks additive, and additive outranks none", () => {
    const additive = diffAfter((nodes) => [...nodes, node("Payload.hint", "string", { optional: true })]);
    const mixed = diffAfter((nodes) => [...remove("Payload.count")(nodes), node("Payload.hint", "string", { optional: true })]);
    expect(requiredVersionBump(additive)).toBe("minor");
    expect(requiredVersionBump(mixed)).toBe("major");
  });

  test("a root named like an Object.prototype member is compared as data", () => {
    const diff = classifyShapeDiff(snapshot({}), snapshot({ constructor: [node("constructor", "object")] }));
    expect(diff.changes).toEqual([{ path: "constructor", change: "root-added", class: "additive" }]);
  });

  test("every ShapeChange kind is exercised by this file", () => {
    const seen = new Set<string>(["root-added", "root-removed"]);
    for (const row of ROWS) for (const change of row.changes) seen.add(change.change);
    const all: readonly ShapeChange["change"][] = [
      "root-added",
      "root-removed",
      "field-added",
      "field-removed",
      "kind-changed",
      "optional-changed",
      "nullable-changed",
      "member-added",
      "member-removed",
    ];
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

describe("request roots", () => {
  /** A small request body: a required string, a literal union and an optional string. */
  const REQUEST: readonly ShapeNode[] = [
    node("Request", "object"),
    node("Request.id", "string"),
    node("Request.mode", "literal-union", { members: ["a", "b"] }),
    node("Request.note", "string", { optional: true }),
  ];
  const OPTIONS = { requestRoots: new Set(["Request"]) } as const;

  /** Apply an edit to a copy of REQUEST and classify it with `Request` as a request root. */
  function requestDiff(edit: (nodes: ShapeNode[]) => ShapeNode[], options?: typeof OPTIONS) {
    return classifyShapeDiff(snapshot({ Request: REQUEST }), snapshot({ Request: edit([...REQUEST]) }), options);
  }

  const RULES: readonly Row[] = [
    {
      name: "an optional field is added",
      edit: (nodes) => [...nodes, node("Request.hint", "string", { optional: true })],
      changes: [{ path: "Request.hint", change: "field-added", class: "additive" }],
      class: "additive",
    },
    {
      name: "a required field is added",
      edit: (nodes) => [...nodes, node("Request.owner", "string")],
      changes: [{ path: "Request.owner", change: "field-added", class: "breaking" }],
      class: "breaking",
    },
    {
      name: "a field becomes required",
      edit: replace("Request.note", node("Request.note", "string")),
      changes: [{ path: "Request.note", change: "optional-changed", class: "breaking" }],
      class: "breaking",
    },
    {
      name: "a field becomes optional",
      edit: replace("Request.id", node("Request.id", "string", { optional: true })),
      changes: [{ path: "Request.id", change: "optional-changed", class: "additive" }],
      class: "additive",
    },
    {
      name: "a literal member is removed",
      edit: replace("Request.mode", node("Request.mode", "literal-union", { members: ["a"] })),
      changes: [{ path: "Request.mode", change: "member-removed", class: "breaking" }],
      class: "breaking",
    },
    {
      name: "a literal member is added",
      edit: replace("Request.mode", node("Request.mode", "literal-union", { members: ["a", "b", "c"] })),
      changes: [{ path: "Request.mode", change: "member-added", class: "additive" }],
      class: "additive",
    },
  ];

  for (const row of RULES) {
    test(`${row.name}: ${row.class}`, () => {
      const diff = requestDiff(row.edit, OPTIONS);
      expect(diff.changes).toEqual([...row.changes]);
      expect(diff.class).toBe(row.class);
    });
  }

  test("without options the same edits classify exactly as on a response root", () => {
    for (const row of RULES) {
      const asRequest = requestDiff(row.edit);
      const rename = (path: string): string => path.replace(/^Request/, "Payload");
      const asPayload = classifyShapeDiff(
        snapshot({ Payload: REQUEST.map((n) => ({ ...n, path: rename(n.path) })) }),
        snapshot({ Payload: row.edit([...REQUEST]).map((n) => ({ ...n, path: rename(n.path) })) }),
      );
      expect(asRequest.class).toBe(asPayload.class);
      expect(asRequest.changes.map((c) => ({ ...c, path: rename(c.path) }))).toEqual([...asPayload.changes]);
    }
    expect(requestDiff(RULES[1]!.edit).changes).toEqual([
      { path: "Request.owner", change: "field-added", class: "additive" },
    ]);
  });

  test("rules are per root: a required field added under a response root stays additive", () => {
    const diff = classifyShapeDiff(
      snapshot({ Payload: BASE, Request: REQUEST }),
      snapshot({ Payload: [...BASE, node("Payload.owner", "string")], Request: REQUEST }),
      OPTIONS,
    );
    expect(diff.changes).toEqual([{ path: "Payload.owner", change: "field-added", class: "additive" }]);
    expect(diff.class).toBe("additive");
  });

  test("shapeRootOf takes the prefix before the first delimiter, or the whole bare root", () => {
    expect(shapeRootOf("DeviceRegistrationRequest.preferences.info")).toBe("DeviceRegistrationRequest");
    expect(shapeRootOf("Payload.hosts[].detail")).toBe("Payload");
    expect(shapeRootOf("Payload[]")).toBe("Payload");
    expect(shapeRootOf("Labels{}.value")).toBe("Labels");
    expect(shapeRootOf("PushPayload(screen=alert).fingerprint")).toBe("PushPayload");
    expect(shapeRootOf("PushPayload.pulse.target(screen=alert).fingerprint")).toBe("PushPayload");
    expect(shapeRootOf("SessionPayload")).toBe("SessionPayload");
  });
});
