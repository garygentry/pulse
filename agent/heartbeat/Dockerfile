# agent/heartbeat/Dockerfile — the per-host managed-linux heartbeat exporter image.
#
# Placed by 01-architecture-layout.md §3.2; runtime behavior in 03-bundle-and-heartbeat.md §5.
# Pinned Bun base (PINNED.heartbeatBase, agent/contract/constants.ts §3) — never latest/floating,
# never a placeholder. Always-on member of the per-host bundle (03 §2.1), serving GET /metrics on
# :9110 only (REQ-SEC-02). The `host` label is NOT baked here — it is scrape-applied (03 §5.1).
#
# Build context is the `agent/` tree (docker build agent -f agent/heartbeat/Dockerfile) so both the
# importable `contract/` boundary and `heartbeat/src/` land under /app, preserving the exporter's
# `../../contract/*.js` relative specifiers (heartbeat/src → ../../contract).

FROM oven/bun:1.3.9

WORKDIR /app

# The importable contract boundary (constants/types) + the heartbeat sources. The two-dir layout
# keeps the exporter's ../../contract/*.js relative imports resolvable (contract is a sibling of
# heartbeat/).
COPY contract ./contract
COPY heartbeat/src ./heartbeat/src

# Bake the agent version into version.ts at build time (03 §5.2/§5.5). AGENT_VERSION is REQUIRED —
# a pinned, reviewable build ARG, never `latest`/floating/placeholder (REQ-BUNDLE-06, REQ-DET-01).
# The guard requires a non-empty, label-safe version token before generating TypeScript. This
# prevents shell/TypeScript injection while renderHeartbeat still defensively escapes labels.
ARG AGENT_VERSION
RUN case "${AGENT_VERSION}" in ""|*[!A-Za-z0-9._+~-]*) exit 1 ;; esac \
  && printf 'export const AGENT_VERSION = "%s" as const;\n' "${AGENT_VERSION}" > heartbeat/src/version.ts

# Heartbeat scrape port (HEARTBEAT_PORT, 00 §3). Published per host by the delivery-form templates
# (03 §8); documented here for parity.
EXPOSE 9110

# Drop privileges — the oven/bun base ships a non-root `bun` user; 9110 (>1024) binds unprivileged.
# The exporter opens no write/control surface (REQ-SEC-02).
USER bun

# Deterministic entrypoint. No CMD flags: the port comes from the shared constant (03 §5.3), so the
# process needs no argv. `import.meta.main` is true when run as the entrypoint, so this starts the
# server (agent/heartbeat/src/index.ts).
CMD ["bun", "run", "/app/heartbeat/src/index.ts"]
