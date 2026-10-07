// sync-architecture.mjs — prebuild aggregation for docs/architecture/**.
//
// docs/architecture/** is generated architecture docs: READ-ONLY here, possibly absent, and
// authored for GitHub rendering — it carries no Starlight frontmatter (so it has
// no `title`, which Starlight's content schema requires) and uses relative
// `./foo.md` links. The operator/runbooks docs, by contrast, are authored for
// this site (frontmatter + root-absolute slug links) and are aggregated directly
// via committed symlinks; architecture cannot be, so this step materializes a
// conforming COPY under src/content/docs/architecture/ (git-ignored) at build
// time. The source tree is never mutated.
//
// It tolerates absence (OQ-03): if docs/architecture/ is missing, it emits
// nothing and the additive Architecture sidebar group is simply empty — never a
// build error. A sibling that ships only a partial doc set contributes exactly
// what exists.
//
// stdlib-only ESM; runs identically under `bun` and `node`.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PKG_DIR, "..", "..");
const SRC = join(REPO_ROOT, "docs", "architecture");
const DEST = join(PKG_DIR, "src", "content", "docs", "architecture");

// Always start from a clean generated tree so a removed source doc never lingers.
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });

if (!existsSync(SRC)) {
  console.log(
    "sync-architecture: docs/architecture/ absent — Architecture group will be empty (OQ-03).",
  );
  process.exit(0);
}

/** All Markdown files under `dir`, as paths relative to SRC (POSIX-ish). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (/\.mdx?$/.test(entry.name)) out.push(relative(SRC, abs));
  }
  return out;
}

/** "web-app" -> "Web App"; "api-reference" -> "Api Reference". */
function titleize(segment) {
  return segment
    .split(/[-_]/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Split leading `---\n...\n---` frontmatter (if any) from the body. */
function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) return { fm: null, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fm: null, body: text };
  const nl = text.indexOf("\n", end + 1);
  return {
    fm: text.slice(4, end),
    body: nl === -1 ? "" : text.slice(nl + 1),
  };
}

/** Map a source-relative markdown path to its site slug (README -> dir index). */
function slugFor(relPath) {
  const noExt = relPath.replace(/\.mdx?$/, "");
  const segs = noExt.split(/[/\\]/);
  const last = segs[segs.length - 1];
  if (last.toLowerCase() === "readme") segs.pop(); // dir index
  return ["architecture", ...segs].join("/");
}

/**
 * Best-effort rewrite of relative `./x.md` / `../y.md` links (with optional
 * `#anchor`) to root-absolute site slugs, so the aggregated pages navigate on
 * the site. Anchors are preserved but NOT validated — architecture pages are
 * excluded from the link gate (astro.config.mjs) precisely because they are
 * read-only external content this feature cannot fix.
 */
function rewriteLinks(body, ownSlug) {
  const ownDir = ownSlug.split("/").slice(0, -1).join("/");
  return body.replace(
    /\]\((\.\.?\/[^)\s#]+?\.mdx?)(#[^)\s]*)?\)/g,
    (_m, rel, anchor = "") => {
      const parts = ownDir.split("/");
      for (const seg of rel.replace(/\.mdx?$/, "").split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      if (parts[parts.length - 1]?.toLowerCase() === "readme") parts.pop();
      return `](/${parts.join("/")}/${anchor})`;
    },
  );
}

let count = 0;
for (const relPath of walk(SRC)) {
  const raw = readFileSync(join(SRC, relPath), "utf8");
  const { fm, body } = splitFrontmatter(raw);

  // Derive a title: existing frontmatter title wins; else the first H1; else the
  // titleized filename. Drop the promoted H1 from the body so the page has one.
  let title = null;
  if (fm) {
    const m = fm.match(/^\s*title\s*:\s*(.+?)\s*$/m);
    if (m) title = m[1].replace(/^["']|["']$/g, "");
  }
  let outBody = body;
  if (!title) {
    const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
    if (h1) {
      title = h1[1].trim();
      outBody = body.replace(/^\s*#\s+.+?\s*$/m, "").replace(/^\n+/, "");
    }
  }
  if (!title) {
    const base = relPath.replace(/\.mdx?$/, "").split(/[/\\]/).pop();
    title = titleize(base.toLowerCase() === "readme" ? "overview" : base);
  }

  const slug = slugFor(relPath);
  outBody = rewriteLinks(outBody, slug);

  // Destination path: README -> index.md so the feature dir has a landing page.
  const destRel = /(^|[/\\])readme\.mdx?$/i.test(relPath)
    ? relPath.replace(/readme\.mdx?$/i, "index.md")
    : relPath;
  const destAbs = join(DEST, destRel);
  mkdirSync(dirname(destAbs), { recursive: true });

  const safeTitle = `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  writeFileSync(destAbs, `---\ntitle: ${safeTitle}\n---\n\n${outBody}`);
  count++;
}

console.log(`sync-architecture: materialized ${count} architecture page(s).`);
