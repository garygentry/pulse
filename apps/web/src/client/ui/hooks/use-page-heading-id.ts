import { useId } from "react";
import { pageHeadingId } from "@/ui/lib/dom-id";

/**
 * The id of a page's `h1`, so the page's `section` (or any other region) can
 * `aria-labelledby` it.
 *
 * - With a string title, the id is derived from it (`"Actions"` →
 *   `"actions-heading"`): `PageHeader` derives the same id from the same title,
 *   so the two agree without being wired together.
 * - Without one (a ReactNode title), a `useId`-based id is returned; pass it to
 *   `PageHeader`'s `id` prop explicitly.
 */
export function usePageHeadingId(title?: string): string {
  const generated = useId();
  return title !== undefined ? pageHeadingId(title) : `page-heading-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
