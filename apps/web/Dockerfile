# apps/web/Dockerfile — built with context = repo root.
#
# Multi-stage image for @pulse/web (01-architecture-layout.md §5, REQ-PKG-01/03, CON-01(e), CON-08).
# The single-dir apps/web context cannot reach the sibling workspace packages @pulse/core /
# @pulse/renderer the app imports, so the slot builds it with the repo root as context
# ({ context: ../../, dockerfile: apps/web/Dockerfile } — 07-slot-reconciliation.md). Follows the
# agent/prober precedent: pinned Bun base (never :latest), USER bun, deterministic CMD. The image
# bakes no estate value (REQ-PKG-03) — everything arrives via slot env + the read-only rendered mount.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3.9 AS build
WORKDIR /app
# Copy the minimal workspace slice needed to install + build (repo-root context). The root
# package.json globs workspaces `packages/*` + `apps/*` + `agent-kit`, so EVERY member's manifest
# must be present for `--frozen-lockfile` to resolve without drift — hence apps/cli/package.json and
# agent-kit/package.json (manifest only; their source is not needed to build @pulse/web).
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY agent-kit/package.json agent-kit/package.json
COPY packages/core packages/core
COPY packages/renderer packages/renderer
# @pulse/web-data is a workspace member (root globs `packages/*`) that apps/web depends on
# (`workspace:*`), so its manifest must be present for `--frozen-lockfile` to resolve and its source
# is copied whole (like core/renderer). The app server now imports it at runtime (05 ServerContext
# v2: the source clients + history service), so it is compiled to dist/ below before the app bundle.
COPY packages/web-data packages/web-data
COPY apps/web apps/web
# `--ignore-scripts`: the root `postinstall` (scripts/link-alerting-deps.ts) links @pulse/* into
# stack/alerting, which is not part of this image; skipping it avoids copying scripts/ for a step
# irrelevant to the web runtime.
RUN bun install --frozen-lockfile --ignore-scripts
# Build the workspace deps' dist/ first: @pulse/core, @pulse/renderer, and @pulse/web-data expose
# their `./dist/*.js` via package.json `exports`, and `Bun.build` resolves the app's imports through
# those entries — it does NOT compile workspace deps from source. `tsc -b packages/web-data` builds
# the whole reference chain (core → renderer → web-data) in order. (dist/ + .tsbuildinfo are excluded
# by .dockerignore, so host outputs are never present in the build context.) This explicit layer is
# a cacheable checkpoint; scripts/build.ts also compiles the graph first (02 §8), so a package
# compile failure there fails the build before any client/server bundle is published.
RUN bunx tsc -b packages/web-data
RUN cd apps/web && bun run scripts/build.ts        # → apps/web/dist/{client,server}

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM oven/bun:1.3.9-slim AS runtime
WORKDIR /app
# Slot healthcheck executes IN-CONTAINER (CON-08) — a distroless base is not viable.
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/web/dist ./dist
EXPOSE 8080
# Writable write-path volume root (audit, acks, proposals). A fresh named volume mounted at /data
# inherits this ownership, so the non-root `bun` user can write it. /rendered stays read-only.
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "dist/server/index.js"]
