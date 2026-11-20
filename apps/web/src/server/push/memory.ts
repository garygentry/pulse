// Per-device notified memory: which fingerprints were notified as firing, with the generation of each mark.

import { PUSH_LIMITS } from "./constants.js";
import { PushInvariantError } from "./refusal.js";

/** A mark set in the notified memory, with its generation. */
export interface MarkRef {
  /** Alert fingerprint (`AM_FINGERPRINT_PATTERN`). */
  readonly fingerprint: string;
  /** Memory generation of the mark, from 1 upward. */
  readonly generation: number;
}

/**
 * Per-device set of fingerprints notified as firing, each with the generation of the mark.
 * In memory only. Each device's map is capped, evicting in insertion order.
 * Generations come from one monotonic counter per memory instance, starting at 1.
 */
export interface NotifiedMemory {
  /** Whether the device has a current mark for the fingerprint. */
  isMarked(deviceId: string, fingerprint: string): boolean;
  /** Mark (or re-mark) and return the new ref. Re-marking moves the entry to the newest position. */
  mark(deviceId: string, fingerprint: string): MarkRef;
  /** Unconditional removal (used on a resolution). */
  unmark(deviceId: string, fingerprint: string): void;
  /** Remove each fingerprint only if its stored generation equals the ref's (unmark-on-drop). */
  unmarkIfCurrent(deviceId: string, refs: readonly MarkRef[]): void;
  /** Forget every mark for a device (device removed). */
  dropDevice(deviceId: string): void;
  /** Number of marks held for a device; 0 when it has none. */
  size(deviceId: string): number;
}

/**
 * Create a per-device notified memory: Map<deviceId, Map<fingerprint, generation>>. In process only.
 *
 * @param capPerDevice - Max fingerprints per device. Default PUSH_LIMITS.memoryMaxPerDevice.
 * @returns A NotifiedMemory with its own generation counter starting at 1.
 * @throws {PushInvariantError} if capPerDevice is not a positive safe integer (programmer error).
 */
export function createNotifiedMemory(capPerDevice: number = PUSH_LIMITS.memoryMaxPerDevice): NotifiedMemory {
  if (!Number.isSafeInteger(capPerDevice) || capPerDevice <= 0) {
    throw new PushInvariantError("notified memory cap must be a positive safe integer");
  }
  const devices = new Map<string, Map<string, number>>();
  let counter = 0;

  const deleteMark = (deviceId: string, marks: Map<string, number>, fingerprint: string): void => {
    marks.delete(fingerprint);
    if (marks.size === 0) devices.delete(deviceId);
  };

  return Object.freeze({
    isMarked(deviceId: string, fingerprint: string): boolean {
      return devices.get(deviceId)?.has(fingerprint) === true;
    },
    mark(deviceId: string, fingerprint: string): MarkRef {
      const generation = ++counter;
      let marks = devices.get(deviceId);
      if (marks === undefined) {
        marks = new Map();
        devices.set(deviceId, marks);
      }
      marks.delete(fingerprint);
      marks.set(fingerprint, generation);
      while (marks.size > capPerDevice) {
        const oldest = marks.keys().next();
        if (oldest.done === true) break;
        marks.delete(oldest.value);
      }
      return Object.freeze({ fingerprint, generation });
    },
    unmark(deviceId: string, fingerprint: string): void {
      const marks = devices.get(deviceId);
      if (marks !== undefined) deleteMark(deviceId, marks, fingerprint);
    },
    unmarkIfCurrent(deviceId: string, refs: readonly MarkRef[]): void {
      for (const ref of refs) {
        const marks = devices.get(deviceId);
        if (marks === undefined) return;
        if (marks.get(ref.fingerprint) === ref.generation) deleteMark(deviceId, marks, ref.fingerprint);
      }
    },
    dropDevice(deviceId: string): void {
      devices.delete(deviceId);
    },
    size(deviceId: string): number {
      return devices.get(deviceId)?.size ?? 0;
    },
  });
}
