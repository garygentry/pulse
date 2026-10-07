// src/client/css.d.ts — ambient module declaration for side-effect CSS imports.
//
// `main.tsx` imports `styles.css` for its side effect (the build bundles it into dist/client/); tsc
// needs this stub to resolve the `.css` module under `verbatimModuleSyntax`. No CSS tooling — the
// stylesheet is plain CSS served static; this only satisfies the type checker.

declare module "*.css" {
  const url: string;
  export default url;
}

// Font files imported from JS (styles/fonts.ts) are emitted as hashed assets; the import is the URL.
declare module "*.woff2" {
  const url: string;
  export default url;
}
