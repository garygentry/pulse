// apps/web/tests/browser/build-fixture.ts — bundle one browser fixture entry for the browser suites.
//
// Run as a subprocess (`bun tests/browser/build-fixture.ts <entry> <outdir> [--minify]`) so the
// bundler gets a fresh resolver (see _harness.ts). The fixtures ship React's production build, as
// the client build does: `process.env.NODE_ENV` is defined as "production" and JSX compiles to the
// production runtime. The `bun build` CLI only does the latter under `--production`, which also
// mangles identifiers, so the JS API is used instead. `--minify` minifies syntax and whitespace
// only, keeping identifiers readable.

import tailwind from "bun-plugin-tailwind";

const [entry, outdir, ...flags] = process.argv.slice(2);
if (entry === undefined || outdir === undefined) {
  console.error("usage: bun build-fixture.ts <entry> <outdir> [--minify]");
  process.exit(2);
}
const minify = flags.includes("--minify");

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  naming: { entry: "[name].[ext]", asset: "[name].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "import.meta.env.DEV": "false" },
  jsx: { development: false },
  plugins: [tailwind],
  loader: { ".woff2": "file", ".woff": "file" },
  minify: minify ? { syntax: true, whitespace: true, identifiers: false } : false,
  throw: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
