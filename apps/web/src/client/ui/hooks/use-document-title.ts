import { useEffect } from "react";
import { APP_TITLE, formatDocumentTitle } from "@/ui/lib/document-title";

/**
 * Set `document.title` to `"{page} · {app}"` (`app` defaults to "Pulse") while the calling
 * page is mounted, and restore the previous title on unmount.
 */
export function useDocumentTitle(page: string | null | undefined, app: string = APP_TITLE): void {
  useEffect(() => {
    const previous = document.title;
    document.title = formatDocumentTitle(page, app);
    return () => {
      document.title = previous;
    };
  }, [page, app]);
}
