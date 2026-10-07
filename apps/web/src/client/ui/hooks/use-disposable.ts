import { useEffect, useRef } from "react";

/**
 * A per-mount resource that needs disposing (a controller, an axis with its own effects): created
 * on first render, disposed on unmount. Disposal waits a microtask, so StrictMode's
 * development-only unmount-and-remount (which re-runs effects synchronously) revives the same
 * resource instead of replacing it. Mount-once effects that captured it on the first render
 * (`useSignalEffect`, `[]`-dependency handlers) therefore never hold a disposed copy.
 */
export function useDisposable<T>(create: () => T, dispose: (value: T) => void): T {
  const slot = useRef<{ value: T; live: boolean } | null>(null);
  if (slot.current === null) slot.current = { value: create(), live: true };
  useEffect(() => {
    const owned = slot.current!;
    owned.live = true;
    return () => {
      owned.live = false;
      queueMicrotask(() => {
        if (!owned.live) dispose(owned.value);
      });
    };
    // Created once per mount: later renders' create/dispose closures are not consulted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return slot.current.value;
}
