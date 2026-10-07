# core-contract (`@pulse/core`)

`core-contract` is the single seam every other Pulse capability hangs off. It defines a
versioned, schema-validated vocabulary for declaring an estate (hosts, services, channels,
what's suppressed and why), a typed in-memory model of that estate, and a loader that turns
a directory of consumer YAML into either that model **or** a list of precisely-located
findings an AI agent can act on directly — file, field, and fix path.

Nothing downstream re-parses raw YAML. `pulse-cli`, `host-agent`, `web-app`, and the rest of
the stack build against the one typed model this package produces.

## Quick Start

`@pulse/core` is a workspace package; depend on it from another package in the monorepo:

```jsonc
// package.json
{
  "dependencies": {
    "@pulse/core": "workspace:*"
  }
}
```

Load a directory of estate YAML and act on the result:

```typescript
import { loadAndValidate, formatFindings, ConfigIoError } from "@pulse/core";

try {
  const result = loadAndValidate("./estate");

  if (result.ok) {
    // A fully-typed EstateModel. Warnings/info may still be present.
    console.log(`Loaded "${result.model.estate.name}" — ${result.model.hosts.length} hosts.`);
    if (result.findings.length > 0) console.warn(formatFindings(result.findings));
  } else {
    // No model was produced; every problem is an agent-actionable finding.
    console.error(formatFindings(result.findings));
    process.exit(1);
  }
} catch (err) {
  // Thrown ONLY for usage failures (missing dir, unreadable path), never for bad config.
  if (err instanceof ConfigIoError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
```

The two-outcome shape is the whole contract: a directory of YAML goes in, and a typed
`EstateModel` **or** a complete `Finding[]` comes out. There is no third "partial model plus
errors" state — when any `error`-severity finding is produced, `result.ok` is `false` and
there is no model.

## Key Concepts

**The estate model is the shared vocabulary.** `EstateModel` is a thin-normalized,
camelCase, types-only description of an estate: its metadata, hosts, services, channels,
routing overrides, and suppressions. It is *estate-agnostic by construction* — it encodes
structure, never a specific estate's identity — so every downstream feature consumes the same
shape regardless of whose estate it describes.

**Findings are the product, not an error channel.** A `Finding` names a `file`, a snake_case
YAML `path`, a stable machine `code`, a human `message`, and a `fix` path. The primary author
of estate config is an AI agent, so validation output is designed to be actioned in one pass
without a human explaining the schema. A typo'd field (`ingres_url`) surfaces as a finding
rather than becoming a silent, unmonitored gap.

**Two failure modes, deliberately separated.** Problems in the *config* an operator authored
are always findings. Problems in *how the loader was called* (the directory doesn't exist, a
file can't be read, a non-string argument) throw a `ConfigIoError`. Malformed YAML is config,
not usage — it is a finding, never a throw. See [Architecture](./architecture.md#the-findings-vs-exceptions-boundary).

**Secrets are references, never values.** Credentials are declared as `${ENV_VAR}` or
`op://vault/item/field` references. `@pulse/core` validates the reference *syntax* and never
reads an environment variable, contacts 1Password, or resolves a value. A literal pasted into
a credential slot is a `secret_literal` finding, so no secret material lands in git.

**Determinism is a contract.** The same input directory always produces byte-identical output
— the same model and the same findings in the same order. Output carries no absolute paths,
timestamps, or PIDs; findings sort by a fixed key; the directory read order is the one
determinism seam everything else derives from.

**Versioning gates the whole run.** Every estate declares an integer `schema_version`. It is
read *before* the body is validated: an absent or unsupported version emits exactly one
finding and short-circuits — you cannot validate a body against a schema you don't have.

## Package Export

`@pulse/core` exposes a single entry point. Import everything from the package root; there are
no subpath exports.

| Entry Point | Description |
|-------------|-------------|
| `@pulse/core` | The loader (`loadAndValidate`), the `EstateModel` type family, `Finding` / `FINDING_CODES` / `formatFindings`, the version constants, and `inventorySchema` (exported for tooling and tests only). |

## Further Reading

- [Architecture](./architecture.md) — The load→validate pipeline, its layers, and determinism
- [API Reference](./api-reference.md) — Every exported function, value, and type
- [Integration Guide](./guides/integration.md) — Consuming the model from a downstream package
