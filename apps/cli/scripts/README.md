# `pulse` release — compiled-binary build

`build-bin.ts` produces the shipped artifacts: two musl-static single binaries and a
`SHA256SUMS` manifest over them. It is the **producing** half of the distribution contract;
the fetch/verify/install script lives downstream in `deploy-toolkit`.

## What it does

```bash
# local dev build — keeps the "0.0.0-dev" sentinel:
bun run build:bin

# release build — bake the git tag as the version:
bun run build:bin 1.0.0
#   or:  PULSE_BUILD_VERSION=1.0.0 bun run build:bin
```

1. Regenerates `src/version.ts` deterministically (`export const PULSE_VERSION = "<version>";`).
2. Compiles each arch target with `bun build --compile`:
   - `pulse-linux-x64`   — `--target=bun-linux-x64-musl`
   - `pulse-linux-arm64` — `--target=bun-linux-arm64-musl`
3. Emits `SHA256SUMS` over the produced binaries.
4. Restores `src/version.ts` to the `0.0.0-dev` sentinel — the committed source is never left
   carrying an injected version.

Outputs land in `apps/cli/dist/build/` (gitignored), never in the repo tree.

The binaries are **musl-static** (no host glibc / JS-runtime dependency), so they run on an
unknown managed host. `@pulse/core` and `@pulse/renderer` are bundled by `--compile`, so the
supported schema majors travel inside the binary (`pulse --version`).

## Only two targets in v1

`bun-linux-x64-musl` and `bun-linux-arm64-musl` only. macOS/Windows are out of scope.

Cross-compiling `bun-linux-arm64-musl` downloads the target Bun runtime on first use; a build
host without network for that download can only produce the x64 artifact. `build-bin.ts`
records a per-target failure rather than aborting, so the x64 binary + a `SHA256SUMS` over it
are still produced — but a real release must ship **both** arch binaries (the CLI entry exits
non-zero if either target fails). Note also that a musl binary cannot execute on a glibc build
host; run/smoke-test the artifact on a musl host (or via the native `bun-linux-x64` target for
a local `--version` check).

## Publishing is a MANUAL, human-gated step

This script stops at producing + checksumming the artifacts. Cutting the **private** GitHub
release is a deliberate release-time action, performed by a human — never by the autonomous
loop or this script:

```bash
# after `bun run build:bin <tag>` succeeds, from apps/cli/dist/build:
gh release create <tag> --repo <org>/<private-repo> \
  pulse-linux-x64 pulse-linux-arm64 SHA256SUMS
```

The handoff to `deploy-toolkit` is exactly those two named binaries + `SHA256SUMS` attached to
a private release tag.
