// ui/lib/style-nonce.ts — the CSP style nonce for primitives that render their own <style> element.
//
// The server's shell policy (`src/server/security-headers.ts`) allows a runtime <style> element only
// when it carries the response's nonce. `main.tsx` reads the nonce from the shell and hands it to
// `get-nonce` before the first render; react-remove-scroll reads it there by itself, while the Radix
// Select and ScrollArea viewports take it as a `nonce` prop, which their wrappers pass from here.
import { getNonce } from "get-nonce";

/** The current CSP style nonce, or `undefined` outside a nonce-carrying shell (tests, fixtures). */
export function styleNonce(): string | undefined {
  return getNonce();
}

/** `{ nonce }` to spread onto a Radix part that renders a `<style>`; `{}` when there is no nonce
 *  (so the prop is omitted rather than `undefined` under `exactOptionalPropertyTypes`). */
export function styleNonceProps(): { nonce?: string } {
  const nonce = styleNonce();
  return nonce === undefined ? {} : { nonce };
}
