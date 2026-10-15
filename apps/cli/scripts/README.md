# `pulse` release — compiled-binary build

`build-bin.ts` produces the shipped artifacts: four single-file binaries (glibc and musl, x64
and arm64) and a `SHA256SUMS` manifest over them. It is the **producing** half of the
distribution contract; the fetch/verify/install script lives downstream in `deploy-toolkit`.

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
2. Compiles each target with `bun build --compile`:

   | Asset | Target | Runs on |
   |---|---|---|
   | `pulse-linux-x64` | `bun-linux-x64` | glibc x86-64 (Debian, Ubuntu, Fedora, …) — the default |
   | `pulse-linux-arm64` | `bun-linux-arm64` | glibc AArch64 — the default |
   | `pulse-linux-x64-musl` | `bun-linux-x64-musl` | musl x86-64 (Alpine) with `libstdc++` and `libgcc` |
   | `pulse-linux-arm64-musl` | `bun-linux-arm64-musl` | musl AArch64 (Alpine) with `libstdc++` and `libgcc` |

3. Emits `SHA256SUMS` over the produced binaries.
4. Restores `src/version.ts` to the `0.0.0-dev` sentinel — the committed source is never left
   carrying an injected version.

Outputs land in `apps/cli/dist/build/` (gitignored), never in the repo tree.

None of the binaries is fully static. The glibc ones use the system glibc loader. The musl ones
are dynamically linked against the musl loader (`/lib/ld-musl-*.so.1`), `libstdc++` and
`libgcc`: on Alpine run `apk add libstdc++` first, and on a glibc host the shell reports
`no such file or directory` for them. `@pulse/core` and `@pulse/renderer` are bundled by
`--compile`, so the supported schema majors travel inside the binary (`pulse --version`).

## Targets

Linux only; macOS/Windows are out of scope. Cross-compiling a target other than the host's
downloads that target's Bun runtime on first use, so a build host without network for that
download produces only some artifacts. `build-bin.ts` records a per-target failure rather than
aborting, so the binaries that built and a `SHA256SUMS` over them are still written, but a real
release must ship **all four** (the CLI entry exits non-zero if any target fails). A glibc x64
build host can run `pulse-linux-x64 --version` directly as a smoke check.

## Publishing is a MANUAL, human-gated step

This script stops at producing + checksumming the artifacts. Publishing the GitHub release is
a deliberate release-time action, performed by a human — never by the autonomous loop or this
script:

```bash
# on the release tag, from the repo root:
bun install --frozen-lockfile
(cd apps/cli && PULSE_BUILD_VERSION=0.2.0 bun run build:bin)
(cd apps/cli/dist/build && sha256sum -c SHA256SUMS)   # all four lines must print OK
apps/cli/dist/build/pulse-linux-x64 --version          # on a glibc x64 host: pulse 0.2.0
gh release upload v0.2.0 --repo garygentry/pulse \
  apps/cli/dist/build/pulse-linux-x64 apps/cli/dist/build/pulse-linux-arm64 \
  apps/cli/dist/build/pulse-linux-x64-musl apps/cli/dist/build/pulse-linux-arm64-musl \
  apps/cli/dist/build/SHA256SUMS
```

The release assets are exactly those four binaries plus `SHA256SUMS` (`<sha256>  <file>` lines,
`sha256sum -c` format). The bootstrap runbook downloads and verifies them by these names.
