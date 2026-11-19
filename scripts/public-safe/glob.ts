/**
 * Path globs for exception entries. Globs match whole repo-relative paths with `/` separators:
 * `**` as a whole segment is zero or more whole segments, `*` is any run of characters except `/`,
 * `?` is exactly one character except `/`, and anything else is literal. A pattern with no `*` or `?`
 * is an exact path.
 */

const GLOBSTAR = Symbol("globstar");

/** Compile a repo-relative path or glob to an anchored RegExp. Pure. */
export function globToRegExp(glob: string): RegExp {
  const segments = glob.split("/").map((segment) =>
    segment === "**"
      ? GLOBSTAR
      : segment
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]"),
  );
  let body = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === GLOBSTAR) {
      body += last ? ".*" : "(?:[^/]+/)*";
    } else {
      body += last ? segment : `${segment}/`;
    }
  });
  return new RegExp(`^${body}$`);
}

/** True when repo-relative `path` matches `glob`. */
export function pathMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
