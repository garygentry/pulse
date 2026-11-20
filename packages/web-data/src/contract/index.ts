// packages/web-data/src/contract/index.ts — barrel for the browser-safe client API contract runtime
// (`@pulse/web-data/contract`). No Node built-ins; nothing from ../cycle or ../sources.

export { CONTRACT_VERSION, CONTRACT_VERSION_PATTERN, decideCompatibility, formatContractVersion, parseContractVersion } from "./version.js";
export type { ClientRequirement, CompatibilityOutcome, ContractVersion } from "./version.js";
export { KNOWN_SERVER_CAPABILITIES, SERVER_CAPABILITY_PATTERN, currentServerCapabilities, registerCapabilityProvider, unregisterCapabilityProvider, __resetCapabilityProvidersForTest } from "./capabilities.js";
export type { CapabilityProvider, ServerCapability } from "./capabilities.js";
export { CONTRACT_LIMITS, capList, truncateUtf8 } from "./limits.js";
export type { ContractLimits, OverviewLimits } from "./limits.js";
export { ENUM_FALLBACKS } from "./enums.js";
export type { EnumFallback, EnumFallbackEntry } from "./enums.js";
export { CLIENT_HEADER, CLIENT_NAME_PATTERN, CONTRACT_HEADER, KNOWN_CLIENTS, handshakeLabels, parseClientAnnouncement } from "./announcement.js";
export type { ClientAnnouncement, HandshakeClientLabel, HandshakeLabels, HandshakeOutcomeLabel, KnownClient } from "./announcement.js";
export {
  CONNECT_LINK_FORMAT_VERSION, CONNECT_LINK_HOST, CONNECT_LINK_MAX_LENGTH, CONNECT_LINK_SCHEME, KNOWN_LINK_PARAMS,
  LINK_PARAM_NAME_PATTERN, RESERVED_LINK_PARAMS, buildConnectLink, isLoopbackHost, normaliseBaseUrl, parseConnectLink,
} from "./connect-link.js";
export type { ConnectLinkBuildResult, ConnectLinkParseResult, ConnectLinkRefusal, ConnectLinkRejection, NormaliseResult } from "./connect-link.js";
export { encodeQrMatrix } from "./qr.js";
export type { QrEcc, QrMatrix } from "./qr.js";
export {
  APNS_TOKEN_PATTERN, BEARER_CREDENTIAL_PATTERN, DEVICE_CREDENTIAL_PATTERN, DEVICE_ID_PATTERN, DISPLAY_NAME_PATTERN,
  PAIR_LINK_PARAM, PAIR_TOKEN_PATTERN, PUSH_CAPABILITY, PUSH_CATEGORIES,
} from "./push.js";
export { ContractError } from "./errors.js";
export type { ContractErrorCode } from "./errors.js";
