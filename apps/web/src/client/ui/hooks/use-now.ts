import { useEffect, useState } from "react";

/**
 * The current time (epoch ms), re-read every `intervalMs` so relative wording
 * ("6m ago") keeps ticking. Pass `enabled: false` when the caller supplies an
 * explicit `now` (the workbench and tests do, so they stay deterministic): no
 * timer runs and the returned value is the mount-time clock.
 */
export function useNow(intervalMs = 15_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
