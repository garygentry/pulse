# agent/prober/Dockerfile — the central deep-health prober image.
#
# Placed by 01-architecture-layout.md §3.2; runtime behavior in 02-deep-health-prober.md.
# Pinned Bun base (PINNED.proberBase, agent/contract/constants.ts §3) — never latest/floating,
# never a placeholder. One image per stack, wired into stack-core's reserved `prober` slot
# (05-config-schema-and-integration.md §5.2); NOT part of the per-host install surface (01 §4).
#
# Build context is the `agent/` tree (docker build agent -f agent/prober/Dockerfile) so both the
# importable `contract/` boundary and `prober/src/` land under /app, preserving the prober's
# `../../contract/*.js` relative specifiers (prober/src → ../../contract). The entrypoint is
# deterministic: Bun runs src/index.ts, which parses no argv — it reads its config path from
# PULSE_RENDERED_DIR (default /rendered/prober/config.yaml) and serves /metrics on :9120 (02 §2/§7).

FROM oven/bun:1.3.9

WORKDIR /app

# Exact-pinned runtime deps — the SAME versions the root workspace resolves (yaml@2.9.0,
# jsonpath-plus@10.3.0, bun.lock), so local `tsc -b` / `bun test` and the container run identical
# code (REQ-DET-01). Exact tags, no `^`/range, no floating install.
RUN bun add yaml@2.9.0 jsonpath-plus@10.3.0

# The importable contract boundary (constants/types) + the prober sources. The two-dir layout keeps
# the prober's ../../contract/*.js relative imports resolvable (contract is a sibling of prober/).
COPY contract ./contract
COPY prober/src ./prober/src

# In-network scrape port (PROBER_PORT, 00 §3). Documented only — the compose slot uses `expose`,
# never `ports:`, so 9120 is never published to the host (REQ-SEC-02, 05 §5.2).
EXPOSE 9120

# Drop privileges — the oven/bun base ships a non-root `bun` user; 9120 (>1024) binds fine unprivileged.
USER bun

# Deterministic entrypoint. No CMD flags: config path + port come from the shared constants/env
# (02 §2/§7), so the process needs no argv. `import.meta.main` is true when run as the entrypoint,
# so this starts the server (agent/prober/src/index.ts §main).
CMD ["bun", "run", "/app/prober/src/index.ts"]
