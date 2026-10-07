/** The fixed v1 collection-class set (CON-07) and its Zod enum
 *  (00-core-definitions.md §2, 02-inventory-schema.md §4.7). This is the canonical
 *  home for COLLECTION_CLASSES; the shape (006) and semantic (009) layers reference it. */

import { z } from "zod";

/** The fixed v1 collection classes (CON-07). Mirrors the CollectionClass model union. */
export const COLLECTION_CLASSES = [
  "managed-linux",
  "hypervisor-api",
  "nas-api",
  "probe-only",
  "excluded",
] as const;

/** Zod enum over COLLECTION_CLASSES — exported for tooling/tests. */
export const collectionClassSchema = z.enum(COLLECTION_CLASSES);
