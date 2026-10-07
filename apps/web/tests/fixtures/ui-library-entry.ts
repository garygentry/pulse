// Bundle entry for ui-tailwind-classes.test.ts: the global stylesheet plus the whole `@/ui` barrel,
// so Tailwind sees every class the vendored library uses (the app imports only part of it).
import "../../src/client/styles/app.css";

export * from "../../src/client/ui/index.js";
