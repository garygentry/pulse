import type { WorkbenchSectionDef } from "../kit.js";
import { collections } from "./collections.js";
import { content } from "./content.js";
import { filtering } from "./filtering.js";
import { foundations } from "./foundations.js";
import { hooks } from "./hooks.js";
import { overlays } from "./overlays.js";
import { palette } from "./palette.js";
import { primitives } from "./primitives.js";
import { scaffolding } from "./scaffolding.js";
import { status } from "./status.js";
import { viz } from "./viz.js";

/**
 * Workbench sections in page order. Each component family owns one file, so
 * items that add components to different families never edit the same file.
 */
export const SECTIONS: readonly WorkbenchSectionDef[] = [
  primitives,
  overlays,
  foundations,
  status,
  scaffolding,
  content,
  collections,
  filtering,
  palette,
  viz,
  hooks,
];
