// apps/web/tests/visual/freeze-clock.ts — Bun preload that freezes the dev SERVER's wall clock.
//
// `dev:web --clock` pins only the mock scenario start; the server still stamps snapshots, source
// health and Gatus results with the real wall clock, so a screenshot would show live ages. The
// visual suite launches `dev:web` with `BUN_OPTIONS="--preload <this file>"` and
// `PULSE_VISUAL_NOW=<iso>`: every Bun process in the tree loads this file, but only the dev
// composition root (`src/server/dev/entry.ts`) swaps in a Date frozen at that instant. The
// supervisor and the client build keep the real clock. Timers and `performance.now()` are left
// alone, so the refresh loop still runs. Test-only: never loaded outside the visual suite.

const iso = process.env["PULSE_VISUAL_NOW"];
const isDevServer = (process.argv[1] ?? "").replaceAll("\\", "/").endsWith("src/server/dev/entry.ts");

if (iso !== undefined && isDevServer) {
  const fixed = Date.parse(iso);
  if (Number.isNaN(fixed)) throw new Error(`PULSE_VISUAL_NOW is not a timestamp: ${iso}`);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}

export {};
