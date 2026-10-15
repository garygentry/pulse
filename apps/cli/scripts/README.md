# `pulse` release — compiled-binary build

`build-bin.ts` produces the shipped artifacts: two musl-static single binaries and a
`SHA256SUMS` manifest over them. It is the **producing** half of the distribution contract;
the fetch/verify/install script lives downstream in `deploy-toolkit`.

## What it does

```bash
# bakes apps/cli/package.json's version (0.2.0 on the v0.2.0 tag):
bun run build:bin

# or bake an explicit version:
bun run build:bin 0.2.0
#   or:  PULSE_BUILD_VERSION=0.2.0 bun run build:bin
```

1. Regenerates `src/version.ts` deterministically (`export const PULSE_VERSION = "<version>";`).
   The version is the first argument, else `PULSE_BUILD_VERSION`, else `apps/cli/package.json`'s
   `version`.
2. Compiles each arch target with `bun build --compile`:
   - `pulse-linux-x64`   — `--target=bun-linux-x64-musl`
   - `pulse-linux-arm64` — `--target=bun-linux-arm64-musl`
3. Emits `SHA256SUMS` over the produced binaries.
4. Restores `src/version.ts` to the `0.0.0-dev` sentinel — the committed source is never left
   carrying an injected version.

Outputs land in `apps/cli/dist/build/` (gitignored), never in the repo tree.

The binaries target musl (`bun-linux-*-musl`) but are **not fully static**: they are
dynamically linked against the musl loader (`/lib/ld-musl-*.so.1`), `libstdc++` and `libgcc`.
They run on Alpine with `apk add libstdc++`; on a glibc host the kernel cannot find the loader
and the shell reports `no such file or directory`. `@pulse/core` and `@pulse/renderer` are
bundled by `--compile`, so the supported schema majors travel inside the binary
(`pulse --version`).

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

This script stops at producing + checksumming the artifacts. Publishing the GitHub release is
a deliberate release-time action, performed by a human — never by the autonomous loop or this
script:

```bash
# on the release tag, from the repo root:
bun install --frozen-lockfile
(cd apps/cli && PULSE_BUILD_VERSION=0.2.0 bun run build:bin)
(cd apps/cli/dist/build && sha256sum -c SHA256SUMS)   # both lines must print OK
gh release upload v0.2.0 --repo garygentry/pulse \
  apps/cli/dist/build/pulse-linux-x64 apps/cli/dist/build/pulse-linux-arm64 \
  apps/cli/dist/build/SHA256SUMS
```

The release assets are exactly those two binaries plus `SHA256SUMS` (`<sha256>  <file>` lines,
`sha256sum -c` format). The bootstrap runbook downloads and verifies them by these names.
