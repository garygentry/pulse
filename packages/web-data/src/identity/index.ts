// packages/web-data/src/identity/index.ts — `/identity` barrel (02 §4).
// Re-exports the trusted-identity config/result contracts, `parseIdentityConfig`, and
// `resolveIdentity`. CIDR normalization helpers and the app env parser stay out of scope.
export * from "./config.js";
export * from "./resolve.js";
