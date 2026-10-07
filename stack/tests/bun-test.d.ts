/**
 * Ambient type surface for Bun's built-in `bun:test` module.
 *
 * The repo installs no `bun-types`/`@types/bun` (item 006), yet `stack/tests/*.test.ts` IS
 * typechecked by `tsc -b` (the `stack/tests` project ref includes `*.test.ts`, unlike the
 * `apps/cli` tests which are not typechecked). Bun provides the real `bun:test` at runtime;
 * this declares only the minimal surface the stack-core suites use so `tsc -b` resolves the
 * import. Pulled in via a `/// <reference>` from each test file (the tsconfig `include` globs
 * only `harness.ts` + `*.test.ts`, so this shim is referenced explicitly rather than globbed).
 *
 * This file has NO top-level import/export, so it is a global script and `declare module`
 * below is an ambient module declaration (not an augmentation of a non-existent module).
 */

declare module "bun:test" {
  interface Matcher {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeNull(): void;
    toContain(expected: unknown): void;
    toHaveProperty(key: string): void;
    readonly not: Matcher;
  }
  /** `test`/`it`: callable, plus `.skip` and the conditional `.skipIf` (used by item 008's
   *  Docker self-skip). */
  interface TestFn {
    (name: string, fn: () => void | Promise<void>, timeout?: number): void;
    skip(name: string, fn?: () => void | Promise<void>, timeout?: number): void;
    skipIf(condition: boolean): (name: string, fn: () => void | Promise<void>, timeout?: number) => void;
  }
  /** `describe`: callable, plus `.skip` (skips the whole group incl. its hooks — the Tier-2
   *  suite registers under this when no Docker daemon is reachable) and `.skipIf`. */
  interface DescribeFn {
    (name: string, fn: () => void): void;
    skip(name: string, fn: () => void): void;
    skipIf(condition: boolean): (name: string, fn: () => void) => void;
  }
  export const test: TestFn;
  export const it: TestFn;
  export const describe: DescribeFn;
  export function expect(actual: unknown, label?: string): Matcher;
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterEach(fn: () => void | Promise<void>, timeout?: number): void;
}
