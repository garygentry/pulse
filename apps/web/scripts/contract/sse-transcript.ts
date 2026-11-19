// Builds raw `/api/events` transcripts from the server's own frame functions, so a transcript holds
// exactly the bytes the stream registry enqueues.

import type { CycleState } from "@pulse/web-data/cycle";
import type { LiveTick } from "@pulse/web-data/wire";

import { frameTick, HEARTBEAT_FRAME, RETRY_FRAME } from "../../src/server/events/stream.js";
import { ContractToolError } from "./errors.js";

/** One transcript step. */
export type TranscriptStep =
  /** The `retry:` frame sent once when a connection opens. */
  | { readonly type: "retry" }
  /** The comment heartbeat frame. */
  | { readonly type: "heartbeat" }
  /** A `tick` event framed by the server's `frameTick`. */
  | { readonly type: "tick"; readonly tick: LiveTick }
  /** An event the server does not send today; the only synthesised frame. */
  | { readonly type: "unknown-event"; readonly id: string; readonly event: string; readonly data: string };

/**
 * A `CycleState`-shaped object carrying only what the tick projection reads: the observation and the
 * identity of each view. Everything else a real cycle holds is absent, hence the cast.
 */
export function tickCycle(tick: LiveTick): CycleState {
  const { identities } = tick;
  return {
    observation: tick.observation,
    overview: { identity: identities.overview },
    alerts: { identity: identities.alerts },
    estate: { identity: identities.estate },
    engine: { identity: identities.engine },
    timeline: { identity: identities.timeline },
  } as unknown as CycleState;
}

/**
 * Concatenate frames into transcript text.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when a tick fails the server's tick validation, or an
 *   unknown-event step holds a line break
 */
export function transcript(steps: readonly TranscriptStep[]): string {
  const decoder = new TextDecoder();
  let text = "";
  for (const step of steps) {
    switch (step.type) {
      case "retry":
        text += decoder.decode(RETRY_FRAME);
        break;
      case "heartbeat":
        text += decoder.decode(HEARTBEAT_FRAME);
        break;
      case "tick": {
        const frame = frameTick(tickCycle(step.tick));
        if (frame === null) {
          throw new ContractToolError("SCENARIO_INVALID", "tick", "transcript tick fails live tick validation");
        }
        text += decoder.decode(frame);
        break;
      }
      case "unknown-event":
        if (/[\r\n]/.test(step.id + step.event + step.data)) {
          throw new ContractToolError("SCENARIO_INVALID", step.event, "an event field holds a line break");
        }
        text += `id: ${step.id}\nevent: ${step.event}\ndata: ${step.data}\n\n`;
        break;
    }
  }
  return text;
}
