/**
 * mutations-citations.test.ts — the write-path source is self-contained (no forge spec citations).
 *
 * Protects: comments in the write-path source (web server mutations, web client mutations, the
 * shared wire types, the CLI `proposals` commands and `@pulse/core/proposals`) do not cite
 * planning artifacts: `specs/` paths, spec section refs (`§4.2`, `05 §3`, `tech-spec §3.6`),
 * spec filenames (`06-acks-store.md`), backlog items (`item 025`), verification findings
 * (`V-012`) or charter decisions (`J58`). Those references do not resolve for a reader without the
 * specs and go stale when the specs change; a comment states the rule it relies on instead.
 * Requirement ids (`REQ-XXX-NN`) are allowed.
 * Non-goals: string literals and code (only comment text is scanned), test files, files outside
 * the five write-path locations, comment quality.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");

const TARGETS = [
  "apps/web/src/server/mutations",
  "apps/web/src/client/mutations",
  "apps/web/src/shared/mutations.ts",
  "apps/cli/src/commands/proposals",
  "packages/core/src/proposals",
];

/**
 * Forge citation tokens. `§` followed by a digit is always a section ref; `NN §` catches a spec
 * number before the section sign; `J\d{2}` is anchored to a following non-word character so hex
 * or ids such as `J58x` do not match, and `V-\d{3}` / `item \d{3}` need exactly three digits.
 */
const CITATION =
  /specs\/|§\s?\d|\b\d{2} §|\btech(-spec)? §|\bitem \d{3}\b|\bV-\d{3}\b|\bJ\d{2}\b|\b\d{2}-[a-z-]+\.md\b/;

/** Every .ts/.tsx source file (not a test) under the target locations. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) {
      out.push(p);
    }
  };
  for (const t of TARGETS) walk(join(ROOT, t));
  return out.sort();
}

/**
 * The comment text of one source file, as `[line, text]` pairs (1-based line; one entry per line a
 * comment touches). Uses the TypeScript parser's comment ranges, so string, template, regex and
 * JSX text are never mistaken for comments.
 */
function commentLines(file: string): Array<[number, string]> {
  const src = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const seen = new Set<number>();
  const out: Array<[number, string]> = [];
  const take = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      const first = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
      src
        .slice(r.pos, r.end)
        .split("\n")
        .forEach((text, k) => {
          if (text.trim() !== "") out.push([first + k, text]);
        });
    }
  };
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(src, node.pos));
    take(ts.getTrailingCommentRanges(src, node.end));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return out;
}

describe("write-path source comments are self-contained", () => {
  const files = sourceFiles();

  test("the scanner finds the target sources", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  test("no comment cites a forge spec, section, backlog item, finding or decision id", () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const [ln, text] of commentLines(file)) {
        if (CITATION.test(text)) hits.push(`${relative(ROOT, file)}:${ln}: ${text.trim()}`);
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
