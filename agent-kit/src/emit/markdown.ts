// agent-kit/src/emit/markdown.ts
// Shared markdown-composition helpers.
//
// All emitters render Section[] → Markdown through this one pure module so composition is
// identical across ecosystems — the single point of determinism control. No template
// engine, no ambient inputs, `\n` line endings only.

import type { Section, CodeBlock } from "./types.js";

/** Render one fenced code block. `lang` may be "" (no tag). Always `\n`-terminated. */
function renderCodeBlock(block: CodeBlock): string {
  const fence = "```";
  // Body is embedded verbatim; the emitter never mutates authored code (determinism §2).
  return `${fence}${block.lang}\n${block.body}${block.body.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

/**
 * Render a single section to Markdown: a heading at the given level, the prose body, then
 * any code blocks in order. Blank lines separate blocks. Pure and deterministic.
 */
export function renderSection(section: Section): string {
  const hashes = "#".repeat(section.level ?? 2);
  const parts: string[] = [`${hashes} ${section.heading}\n`];
  if (section.text.trim().length > 0) parts.push(`\n${section.text.trimEnd()}\n`);
  for (const code of section.code ?? []) parts.push(`\n${renderCodeBlock(code)}`);
  return parts.join("");
}

/**
 * Render an ordered section list to a Markdown body. Sections are separated by exactly one
 * blank line; the result ends with a single trailing `\n`.
 */
export function renderSections(sections: readonly Section[]): string {
  return sections.map(renderSection).join("\n").replace(/\n+$/, "\n");
}
