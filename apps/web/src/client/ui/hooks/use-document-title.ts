import { useEffect } from "react";
import { formatDocumentTitle } from "@/ui/lib/document-title";

/**
 * Set `document.title` to `"{page} · Pulse"` while the calling page is mounted,
 * and restore the previous title on unmount.
 */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    const previous = document.title;
    document.title = formatDocumentTitle(page);
    return () => {
      document.title = previous;
    };
  }, [page]);
}
