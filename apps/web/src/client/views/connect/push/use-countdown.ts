// apps/web/src/client/views/connect/push/use-countdown.ts — the pairing code's remaining validity: a 1 s visual
// "m:ss" tick plus a minute-granular text for a polite live region.
import { useEffect, useRef } from "react";
import { useNow } from "@/ui";

/** The countdown as rendered. */
export interface Countdown {
  /** Whole seconds left, clamped at 0. */
  readonly remainingSeconds: number;
  /** "m:ss", e.g. "9:05". */
  readonly text: string;
  /** True once no time is left (or the expiry is unparseable). */
  readonly expired: boolean;
  /** Text for the polite live region; changes only on whole-minute boundaries (see announcementFor). */
  readonly announcement: string;
}

/** "m:ss" for whole seconds ≥ 0 (negative or non-finite input counts as 0). Pure. */
export function formatRemaining(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

/**
 * Minute-granular announcement. Pure. remaining > 60 s → "Pairing code expires in N minutes" with
 * N = ceil(remaining / 60); 1–60 s → "Pairing code expires in 1 minute"; 0 → "" (expiry is announced by the
 * expired callout).
 */
export function announcementFor(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds <= 60) return "Pairing code expires in 1 minute";
  return `Pairing code expires in ${Math.ceil(seconds / 60)} minutes`;
}

/**
 * 1 s visual tick while `expiresAt` is non-null. An unparseable expiresAt counts as expired. `onExpire` fires
 * once per expiry value when remaining reaches 0.
 */
export function useCountdown(expiresAt: string | null, onExpire?: () => void): Countdown {
  const now = useNow(1000, expiresAt !== null);
  const expiresMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  const remainingSeconds = Number.isFinite(expiresMs) ? Math.max(0, Math.ceil((expiresMs - now) / 1000)) : 0;
  const expired = remainingSeconds === 0;

  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (expiresAt === null || !expired) return;
    if (firedFor.current === expiresAt) return;
    firedFor.current = expiresAt;
    onExpireRef.current?.();
  }, [expiresAt, expired]);

  return {
    remainingSeconds,
    text: formatRemaining(remainingSeconds),
    expired,
    announcement: announcementFor(remainingSeconds),
  };
}
