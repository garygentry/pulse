// packages/web-data/src/contract/index.ts — barrel for the browser-safe client API contract runtime
// (`@pulse/web-data/contract`). No Node built-ins; nothing from ../cycle or ../sources.

export { CONTRACT_VERSION, CONTRACT_VERSION_PATTERN, decideCompatibility, formatContractVersion, parseContractVersion } from "./version.js";
export type { ClientRequirement, CompatibilityOutcome, ContractVersion } from "./version.js";
export { KNOWN_SERVER_CAPABILITIES, SERVER_CAPABILITY_PATTERN, currentServerCapabilities, registerCapabilityProvider, __resetCapabilityProvidersForTest } from "./capabilities.js";
export type { CapabilityProvider, ServerCapability } from "./capabilities.js";
export { CLIENT_HEADER, CLIENT_NAME_PATTERN, CONTRACT_HEADER, KNOWN_CLIENTS, handshakeLabels, parseClientAnnouncement } from "./announcement.js";
export type { ClientAnnouncement, HandshakeClientLabel, HandshakeLabels, HandshakeOutcomeLabel, KnownClient } from "./announcement.js";
export { ContractError } from "./errors.js";
export type { ContractErrorCode } from "./errors.js";
