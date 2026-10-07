/**
 * Derive a DOM-id-safe slug from fixed, caller-chosen English text (a page or
 * section title — never entity data). Stripping to `[a-z0-9-]` keeps hostile
 * characters out of the id even defensively; an empty result falls back to
 * `fallback`.
 */
export function slugify(text: string, fallback = "section"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/** The heading id a page titled `title` uses: `"Actions"` → `"actions-heading"`. */
export function pageHeadingId(title: string): string {
  return `${slugify(title, "page")}-heading`;
}
