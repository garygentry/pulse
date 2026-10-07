# Integration Guide

This guide is for authors of downstream Pulse packages — `pulse-cli`, `host-agent`,
`web-app`, `stack-core`, `alerting`, `dashboards`, and the rest of the stack. It shows how to
consume `@pulse/core` as your single input vocabulary so you build against one contract rather
than re-parsing raw YAML.

## Depend on the package

`@pulse/core` is a workspace package. Add it as a dependency:

```jsonc
// package.json
{
  "dependencies": {
    "@pulse/core": "workspace:*"
  }
}
```

Import from the root — there are no subpath exports:

```typescript
import { loadAndValidate } from "@pulse/core";
import type { EstateModel, Host, Service } from "@pulse/core";
```

## The one pattern: load, branch, consume

Call `loadAndValidate` once, branch on `result.ok`, and consume the typed model. Wrap the call
in a `try/catch` for `ConfigIoError` — that's your invocation being wrong (bad path), distinct
from the config being wrong (findings).

```typescript
import { loadAndValidate, formatFindings, ConfigIoError } from "@pulse/core";
import type { EstateModel } from "@pulse/core";

export function loadEstate(dir: string): EstateModel {
  let result;
  try {
    result = loadAndValidate(dir);
  } catch (err) {
    if (err instanceof ConfigIoError) {
      throw new Error(`Cannot read estate at ${dir}: ${err.code}`);
    }
    throw err;
  }

  if (!result.ok) {
    throw new Error(`Estate config is invalid:\n${formatFindings(result.findings)}`);
  }

  // result.findings here are warning/info only — surface them, don't fail on them.
  return result.model;
}
```

Whether you exit non-zero, render findings in a UI, or throw is your package's decision.
`@pulse/core` maps nothing to exit codes — the `severity` → exit-code convention is owned by
`pulse-cli`.

## Consuming the model

The model is the shared vocabulary. Narrow on discriminants; never re-parse.

**Hosts** are discriminated on `collectionClass` — narrow before reaching class-specific
fields:

```typescript
import type { EstateModel } from "@pulse/core";

function scrapeTargets(model: EstateModel): string[] {
  const targets: string[] = [];
  for (const host of model.hosts) {
    if (host.collectionClass === "managed-linux") {
      for (const port of host.exporterPorts) {
        targets.push(`${host.addresses[0]}:${port}`);
      }
    }
  }
  return targets;
}
```

**Services** resolve their `host` against `model.hosts` at load time, so an
`unresolved_host` never reaches you — a service you receive names a host that exists:

```typescript
function servicesByHost(model: EstateModel): Map<string, string[]> {
  const byHost = new Map<string, string[]>();
  for (const svc of model.services) {
    const list = byHost.get(svc.host) ?? [];
    list.push(svc.name);
    byHost.set(svc.host, list);
  }
  return byHost;
}
```

**Secret references** arrive parsed but unresolved. Resolving a `SecretRef` to a value is
*your* concern; `@pulse/core` deliberately never does it:

```typescript
import type { SecretRef } from "@pulse/core";

function resolve(ref: SecretRef): string {
  if (ref.kind === "env") {
    const value = process.env[ref.varName];
    if (value === undefined) throw new Error(`Unset env var: ${ref.varName}`);
    return value;
  }
  // ref.kind === "op" — resolve op://{ref.vault}/{ref.item}/{ref.field} via your secret backend
  return resolveOnePassword(ref.vault, ref.item, ref.field);
}
```

## What you can rely on

Because the model reaches you *only* after a clean load, these invariants already hold — you
don't re-check them:

- **Exactly one estate**, with a required, IANA-valid `timezone`.
- **Every host** has exactly one valid collection class and its class-required fields.
- **Every service's `host`** and **every routing override's channels** resolve to declared
  entities.
- **Every credential slot** is a parsed `SecretRef`, never a literal.
- **Every suppression** carries a non-empty rationale.
- **Collections are insertion-ordered** and the whole model is deterministic — the same input
  directory always produces the same model, so you can golden-test against it safely.

## Provenance for downstream findings

If your package produces its own findings (or diagnostics) about the estate, reuse the
`Provenance` on each model element to point back at the source config precisely — the same
`file` / `path` / `line` / `col` vocabulary `@pulse/core` uses. This keeps every layer's
diagnostics pointing at the operator's YAML in one consistent form:

```typescript
for (const svc of model.services) {
  if (svc.ingressUrl === undefined && svc.managed) {
    const at = svc.provenance;
    console.warn(`${at.file}:${at.line}: managed service "${svc.name}" has no ingressUrl`);
  }
}
```

## When to use `@pulse/core`

**Use it** whenever you need estate facts — hosts, services, channels, routing, suppressions,
metadata. It is the root dependency of the stack; every capability derived from an estate
description consumes this model.

**Don't** re-parse the estate YAML yourself, and **don't** reach past the public export into
`@pulse/core`'s internals (the loader phases, the schema modules, the Zod issue mapper). They
are implementation detail and not part of the contract. If you find the public surface missing
something you need, that's a change to the contract — raise it against `core-contract` rather
than working around it.

**Don't** ask `@pulse/core` to resolve secrets, reach the network, or write files. It reads a
directory and returns data; every side effect beyond that belongs to your package.
