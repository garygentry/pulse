# agent/command-exporter/Dockerfile — the per-host command-exporter image (issue #3/#1).
#
# Pinned Bun base (PINNED.commandExporterBase, agent/contract/constants.ts §3) — never latest/
# floating, never a placeholder. A managed-linux host runs this ONLY when it declares ≥1 command
# signal; the compose fragment gates it behind the `command-exporter` profile and the systemd unit
# is installed only for such hosts (deploy-toolkit). It serves /metrics + /healthz on :9130.
#
# Build context is the `agent/` tree (docker build agent -f agent/command-exporter/Dockerfile) so
# both the importable `contract/` boundary and `command-exporter/src/` land under /app, preserving
# the `../../contract/*.js` relative specifiers. The entrypoint parses no argv: it reads its config
# path from PULSE_RENDERED_DIR (default /rendered/command-exporter/config.yaml) and its timeout from
# PULSE_COMMAND_TIMEOUT_MS.
#
# NOTE: the SIGNAL COMMANDS run INSIDE this container. Making a specific command available
# (nvidia-smi for the GPU signal, a backup-age helper, …) is a DEPLOY-TIME concern — mount the
# host-provided scripts/binaries (and, for nvidia-smi, use the NVIDIA container runtime + devices).
# See docs/operator/command-exporter.md. The image itself is estate-agnostic and command-agnostic.

FROM oven/bun:1.3.9

WORKDIR /app

# Exact-pinned runtime deps — the SAME version the root workspace resolves (yaml@2.9.0, bun.lock),
# so local `tsc -b` / `bun test` and the container run identical code (REQ-DET-01).
RUN bun add yaml@2.9.0

# The importable contract boundary (constants/types) + the command-exporter sources. The two-dir
# layout keeps the `../../contract/*.js` relative imports resolvable (contract is a sibling).
COPY contract ./contract
COPY command-exporter/src ./command-exporter/src

# Local scrape port (COMMAND_EXPORTER_PORT, 00 §3). Documented only — the compose fragment maps it.
EXPOSE 9130

# Drop privileges — the oven/bun base ships a non-root `bun` user; 9130 (>1024) binds unprivileged.
# NOTE: a signal command that needs elevated access (device nodes, privileged host paths) is granted
# it by the deploy-time runtime config, not by running the exporter itself as root.
USER bun

# Deterministic entrypoint. No CMD flags: config path + port + timeout come from constants/env.
CMD ["bun", "run", "/app/command-exporter/src/index.ts"]
