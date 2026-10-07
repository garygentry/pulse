declare module "bun:test" {
  interface Matcher {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeInstanceOf(expected: unknown): void;
    toThrow(expected?: unknown): void;
    readonly not: Matcher;
    /** Async assertion on a rejected promise (awaitable). */
    readonly rejects: Matcher;
    /** Async assertion on a resolved promise (awaitable). */
    readonly resolves: Matcher;
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
  export function beforeEach(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterEach(fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(fn: () => void | Promise<void>, timeout?: number): void;
}

interface ImportMeta {
  readonly dir: string;
}

// The `Bun` global ambient lives in `agent/prober/src/bun-runtime.d.ts` (the single canonical
// declaration, included by both the prober and tests projects). Declaring it here too would be
// a TS2451 redeclare.
