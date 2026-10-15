// Pulse: APP_TITLE is "Pulse" (deck: "Deck").

/** The app name that ends every document title unless the shell is branded otherwise. */
export const APP_TITLE = "Pulse";

/** `"{page} · {app}"`, or just `"{app}"` when there is no page title; `app` defaults to "Pulse". */
export function formatDocumentTitle(page?: string | null, app: string = APP_TITLE): string {
  const trimmed = page?.trim() ?? "";
  return trimmed === "" ? app : `${trimmed} · ${app}`;
}
