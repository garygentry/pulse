// src/client/root-options.ts — options for every React root the client creates.
//
// Error boundaries report what they catch themselves: the view and history boundaries log one
// `console.error` with their own context, and the estate region boundary announces the fault to
// assistive tech. React's default `onCaughtError` would also log every caught error, so it is
// replaced with a no-op. Uncaught errors keep React's default reporting.

import type { RootOptions } from "react-dom/client";

export const ROOT_OPTIONS: RootOptions = {
  onCaughtError: () => undefined,
};
