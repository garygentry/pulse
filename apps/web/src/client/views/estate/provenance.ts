// src/client/views/estate/provenance.ts — the canonical `file:line` provenance reference string.

import type { WebProvenance } from "@pulse/renderer";

/** The canonical location string the chip displays and copies. */
export function provenanceRef(provenance: WebProvenance): string {
  return `${provenance.file}:${provenance.line}`;
}
