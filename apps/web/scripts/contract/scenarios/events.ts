// Event-stream fixtures: live tick bodies, raw `/api/events` transcripts framed by the server's own frame
// functions, and the forward-compatibility variants a client must tolerate.

import type { CycleObservation, HashId, LiveTick, SourceId, SourceObservation, ViewId } from "@pulse/web-data/wire";

import { transcript } from "../sse-transcript.js";
import type { ScenarioFixture } from "../types.js";
import { typicalAlertsBody } from "./alerts.js";
import { APP_VERSION, GENERATION, jsonFixture, jsonObject } from "./common.js";
import { typicalEstateBody } from "./estate.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";
import { typicalOverviewBody } from "./overview.js";
import { typicalTimelineBody } from "./timeline.js";

/** Seconds between two published cycles in the transcripts. */
const CYCLE_SECONDS = 10;

/** Every fixed source, freshly acquired at `observedAt`. */
function currentSources(observedAt: string): CycleObservation["sources"] {
  // One object per source, so an edit to one source's copy never shows up in the others.
  const current = (): SourceObservation => ({ state: "current", lastAttemptAt: observedAt, lastSuccess: observedAt });
  return {
    "victoriametrics-signals": current(),
    "victoriametrics-targets": current(),
    "victoriametrics-buildinfo": current(),
    "alertmanager-alerts": current(),
    "alertmanager-silences": current(),
    "alertmanager-status": current(),
    "alertmanager-receivers": current(),
    "vmalert-rules": current(),
    "gatus-statuses": current(),
    "grafana-health": current(),
  } satisfies Record<SourceId, SourceObservation>;
}

/** The tick for the first cycle: each view identity is the hash of that view's typical body. */
async function firstIdentities(ctx: ScenarioContext): Promise<Record<ViewId, HashId>> {
  return {
    overview: await ctx.hash(await typicalOverviewBody(ctx)),
    alerts: await ctx.hash(await typicalAlertsBody(ctx)),
    estate: await ctx.hash(await typicalEstateBody(ctx)),
    engine: await ctx.hash({ view: "engine" }),
    timeline: await ctx.hash(await typicalTimelineBody(ctx)),
  };
}

/** Identities of a later cycle: every view changed, each to its own value. */
async function laterIdentities(ctx: ScenarioContext, seq: number): Promise<Record<ViewId, HashId>> {
  return {
    overview: await ctx.hash({ seed: seq, view: "overview" }),
    alerts: await ctx.hash({ seed: seq, view: "alerts" }),
    estate: await ctx.hash({ seed: seq, view: "estate" }),
    engine: await ctx.hash({ seed: seq, view: "engine" }),
    timeline: await ctx.hash({ seed: seq, view: "timeline" }),
  };
}

/** The tick published by cycle `seq` (1-based), one cycle interval after the previous one. */
async function tickAt(ctx: ScenarioContext, seq: number): Promise<LiveTick> {
  const observedAt = ctx.at(CYCLE_SECONDS * (seq - 1));
  return {
    observation: {
      generation: GENERATION,
      seq,
      observedAt,
      appVersion: APP_VERSION,
      sources: currentSources(observedAt),
    },
    identities: seq === 1 ? await firstIdentities(ctx) : await laterIdentities(ctx, seq),
  } satisfies LiveTick;
}

const FUTURE_FIELD = { nested: true } as const;

export const eventScenarios: ScenarioModule = {
  group: "events",
  operation: "SSE /api/events",
  async build(ctx) {
    const first = await tickAt(ctx, 1);
    const second = await tickAt(ctx, 2);

    // A view this client does not know yet: one more identity key.
    const unknownView = jsonObject(structuredClone(first), "events/tick-unknown-view");
    jsonObject(unknownView.identities, "events/tick-unknown-view")["future-view"] = first.identities.overview;

    // Members this client does not know yet, at three depths.
    const unknownFields = jsonObject(structuredClone(first), "events/tick-unknown-fields");
    const observation = jsonObject(unknownFields.observation, "events/tick-unknown-fields");
    const sources = jsonObject(observation.sources, "events/tick-unknown-fields");
    unknownFields.futureField = FUTURE_FIELD;
    observation.futureField = FUTURE_FIELD;
    jsonObject(sources["alertmanager-alerts"], "events/tick-unknown-fields").futureField = FUTURE_FIELD;

    const stream = (scenario: string, sse: string): ScenarioFixture => ({
      entry: {
        group: this.group,
        operation: this.operation,
        scenario,
        kind: "stream",
        status: null,
        expect: "accept",
        webValidator: null,
      },
      body: { sse },
    });

    return [
      jsonFixture(this, "tick-typical", "event", null, first, { webValidator: "tick" }),
      jsonFixture(this, "tick-unknown-view", "event", null, unknownView),
      jsonFixture(this, "tick-unknown-fields", "event", null, unknownFields),
      // A fresh connection: the retry hint, the current tick, then heartbeats around the next cycle's tick.
      stream(
        "stream-typical",
        transcript([
          { type: "retry" },
          { type: "tick", tick: first },
          { type: "heartbeat" },
          { type: "tick", tick: second },
          { type: "heartbeat" },
        ]),
      ),
      // A reconnect whose last event id is the current cycle: no tick until the next cycle publishes.
      stream(
        "stream-resume-match",
        transcript([{ type: "retry" }, { type: "heartbeat" }, { type: "tick", tick: second }]),
      ),
      // An event type the client does not know, between two ticks; it must be ignored.
      stream(
        "stream-unknown-event",
        transcript([
          { type: "retry" },
          { type: "tick", tick: first },
          { type: "unknown-event", id: `${GENERATION}:1`, event: "future-event", data: '{"future":true}' },
          { type: "heartbeat" },
          { type: "tick", tick: second },
        ]),
      ),
    ];
  },
};
