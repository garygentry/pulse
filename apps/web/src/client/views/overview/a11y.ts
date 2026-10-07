// views/overview/a11y.ts — shim: canonical home is the shared a11y surface (client/a11y/index.ts).
// A pure re-export so any remaining overview-relative import keeps resolving; no local label map.
export { STATUS_LABEL, cellLabel, serviceLabel } from "../../a11y/index.js";
