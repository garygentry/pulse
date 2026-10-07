// agent/heartbeat/src/version.ts
//
// The agent build/version string carried by `pulse_agent_build_info` (REQ-HB-02, 03 §5.2).
//
// This literal is OVERWRITTEN by `agent/heartbeat/Dockerfile` at image build time from the
// pinned, required `AGENT_VERSION` build ARG (03 §5.5), so the value is fixed in the image
// layer — baked at build, NOT read from runtime env. The committed default is a dev
// placeholder; a released image never ships it.
export const AGENT_VERSION = "0.0.0-dev" as const;
