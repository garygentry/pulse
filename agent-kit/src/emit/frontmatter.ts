// agent-kit/src/emit/frontmatter.ts
// Shared runnable-skill frontmatter renderer (REQ-SKILL-06).
//
// Runnable ecosystems (Claude, Pi) prefix a skill/agent file with a YAML frontmatter block
// carrying `name` / `description` / optional `argument-hint`. One helper renders it so the key
// order is fixed and stable across ecosystems.

import type { ContentFrontmatter } from "./types.js";

/**
 * Render a runnable-skill YAML frontmatter block with a fixed key order
 * (`name`, `description`, then optional `argument-hint`). Values are JSON-stringified so a
 * value containing `:` or a newline cannot break the YAML (determinism). Always emits
 * the leading/trailing `---` fences and a trailing `\n`.
 *
 * @param fm - the unit's frontmatter (`ContentFrontmatter`)
 */
export function renderFrontmatter(fm: ContentFrontmatter): string {
  const lines: string[] = ["---", `name: ${JSON.stringify(fm.name)}`,
    `description: ${JSON.stringify(fm.description)}`];
  if (fm.argumentHint !== undefined) {
    lines.push(`argument-hint: ${JSON.stringify(fm.argumentHint)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}
