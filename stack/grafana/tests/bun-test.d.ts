/**
 * Ambient type surface for Bun's built-in `bun:test` module.
 *
 * The repo installs no `bun-types`/`@types/bun`, yet `stack/grafana/tests/*.test.ts` IS
 * typechecked by `tsc -b` (the `stack/grafana` project ref includes the tests directory). Bun
 * provides the real `bun:test` at runtime; this declares only the minimal surface the dashboards
 * guard suites use so `tsc -b` resolves the import. Pulled in via a `/// <reference>` from each
 * test file (mirrors stack/alerting/tests/bun-test.d.ts).
 *
 * This file has NO top-level import/export, so it is a global script and `declare module`
 * below is an ambient module declaration (not an augmentation of a non-existent module).
 */

/** Bun: absolute path of the directory containing the current module (used for fixture paths). */
interface ImportMeta {
  readonly dir: string;
}

declare module "bun:test" {
  interface Matcher {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toContain(expected: unknown): void;
    toHaveProperty(key: string): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    readonly not: Matcher;
  }
  interface TestFn {
    (name: string, fn: () => void | Promise<void>, timeout?: number): void;
    skip(name: string, fn?: () => void | Promise<void>, timeout?: number): void;
    skipIf(condition: boolean): (name: string, fn: () => void | Promise<void>, timeout?: number) => void;
  }
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
