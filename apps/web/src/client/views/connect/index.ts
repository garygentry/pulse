// apps/web/src/client/views/connect/index.ts — the connect view registration.

import type { ViewDefinition } from "../../../shared/registry.js";

/** `/connect`: show a connect link for the phone app. It has no `nav`, so the sidebar and kiosk
 *  rotation never list it; the palette lists it through SECONDARY_VIEWS. `load()` is the only
 *  reference to `./view.js`, so the screen and the QR encoder land in their own lazy chunk.
 *
 *  It sets no `icon`: only the side nav renders a view's icon, and this module rides the initial
 *  route, where an icon token must be one of the shell's eagerly shipped icons. */
export const connectView: ViewDefinition = {
  id: "connect",
  label: "Connect a phone",
  load: () => import("./view.js").then((m) => m.ConnectView),
};
