import {
  ALERT_SEVERITY,
  FRESHNESS_STATUS,
  FreshnessBadge,
  MUTATION_STATE,
  TARGET_STATUS,
  HealthPill,
  RelativeTime,
  StatusBadge,
  TONES,
  defineStatusMap,
  type IconName,
  type Tone,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed clock: the workbench renders deterministically (visual baselines).
const NOW = Date.parse("2026-01-15T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TONE_ICON: Record<Tone, IconName> = {
  ok: "circle-check",
  warn: "triangle-alert",
  danger: "circle-x",
  info: "info",
  pending: "hourglass",
  neutral: "circle-minus",
};

const TONE_LABEL: Record<Tone, string> = {
  ok: "Healthy",
  warn: "Degraded",
  danger: "Down",
  info: "Info",
  pending: "Pending",
  neutral: "Unknown",
};

const DEMO_MAP = defineStatusMap<"running" | "stopped" | "unknown">({
  running: { tone: "ok", icon: "circle-play", label: "Running" },
  stopped: { tone: "danger", icon: "circle-stop", label: "Stopped" },
  unknown: { tone: "neutral", icon: "circle-help", label: "Unknown" },
});

function ToneRow({ variant, size = "sm" }: { variant: "soft" | "outline" | "dot"; size?: "sm" | "md" }) {
  return (
    <>
      {TONES.map((tone) => (
        <StatusBadge
          key={tone}
          tone={tone}
          icon={TONE_ICON[tone]}
          label={TONE_LABEL[tone]}
          variant={variant}
          size={size}
        />
      ))}
    </>
  );
}

function Status() {
  return (
    <>
      <Specimen label="StatusBadge — soft, sm (default), every tone">
        <ToneRow variant="soft" />
      </Specimen>
      <Specimen label="StatusBadge — soft, md">
        <ToneRow variant="soft" size="md" />
      </Specimen>
      <Specimen label="StatusBadge — outline">
        <ToneRow variant="outline" />
      </Specimen>
      <Specimen label="StatusBadge — dot (tinted icon, plain text)">
        <ToneRow variant="dot" />
      </Specimen>
      <Specimen label="StatusBadge — detail suffix, tooltip (focusable), truncation">
        <StatusBadge tone="ok" icon="circle-check" label="Fresh" detail="as of 58s ago" />
        <StatusBadge tone="warn" icon="clock-alert" label="Stale" detail="as of 2h ago" size="md" />
        <StatusBadge
          tone="info"
          icon="info"
          label="Waived"
          title="Waived until 2026-02-01 by ops: planned migration window"
        />
        <span className="w-32">
          <StatusBadge
            tone="danger"
            icon="octagon-alert"
            label="Critical: disk usage above threshold on every volume"
          />
        </span>
      </Specimen>
      <Specimen label="StatusBadge.fromMap — a feature map bound to a state">
        {(Object.keys(DEMO_MAP) as (keyof typeof DEMO_MAP)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(DEMO_MAP, state)}</span>
        ))}
        {StatusBadge.fromMap(DEMO_MAP, "running", { variant: "outline", detail: "3 containers" })}
      </Specimen>
      <Specimen label="TARGET_STATUS — every target status (suppressed: outline, distinct icon)">
        {(Object.keys(TARGET_STATUS) as (keyof typeof TARGET_STATUS)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(TARGET_STATUS, state)}</span>
        ))}
      </Specimen>
      <Specimen label="TARGET_STATUS — md size, dot variant">
        {(Object.keys(TARGET_STATUS) as (keyof typeof TARGET_STATUS)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(TARGET_STATUS, state, { size: "md" })}</span>
        ))}
        {(Object.keys(TARGET_STATUS) as (keyof typeof TARGET_STATUS)[]).map((state) => (
          <span key={`dot-${state}`}>{StatusBadge.fromMap(TARGET_STATUS, state, { variant: "dot" })}</span>
        ))}
      </Specimen>
      <Specimen label="ALERT_SEVERITY — every severity (info uses the info tone)">
        {(Object.keys(ALERT_SEVERITY) as (keyof typeof ALERT_SEVERITY)[]).map((severity) => (
          <span key={severity}>{StatusBadge.fromMap(ALERT_SEVERITY, severity)}</span>
        ))}
      </Specimen>
      <Specimen label="MUTATION_STATE — every action and proposal state">
        {(Object.keys(MUTATION_STATE) as (keyof typeof MUTATION_STATE)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(MUTATION_STATE, state)}</span>
        ))}
      </Specimen>
      <Specimen label="FRESHNESS_STATUS — the map FreshnessBadge reads">
        {(Object.keys(FRESHNESS_STATUS) as (keyof typeof FRESHNESS_STATUS)[]).map((state) => (
          <span key={state}>{StatusBadge.fromMap(FRESHNESS_STATUS, state)}</span>
        ))}
      </Specimen>
      <Specimen label="FreshnessBadge — every state (fixed now)">
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "fresh", observedAt: ago(42 * SECOND), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "stale", observedAt: ago(6 * MINUTE), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "unreachable", observedAt: ago(3 * HOUR), ageMs: null, ttlMs: 60_000 }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "unreachable", observedAt: null, ageMs: null, ttlMs: null }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "static", observedAt: null, ageMs: null, ttlMs: null }}
        />
        <FreshnessBadge
          now={NOW}
          freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
        />
      </Specimen>
      <Specimen label="RelativeTime — absolute time in tooltip; invalid input verbatim">
        {[5 * SECOND, 42 * SECOND, 6 * MINUTE, 3 * HOUR, 8 * DAY].map((ms) => (
          <span key={ms} className="text-sm">
            <RelativeTime value={ago(ms)} now={NOW} />
          </span>
        ))}
        <span className="text-sm">
          <RelativeTime value="not-a-date" now={NOW} />
        </span>
      </Specimen>
      <Specimen label="HealthPill — tones, counts, freshness meta, truncation">
        <HealthPill tone="ok" icon="circle-check" label="Endpoints OK" href="#status" />
        <HealthPill
          tone="warn"
          icon="triangle-alert"
          label="Drift"
          count={3}
          countLabel="3 active findings"
          href="#status"
        />
        <HealthPill tone="danger" icon="octagon-alert" label="Alerts" count={12} href="#status" />
        <HealthPill
          tone="pending"
          icon="hourglass"
          label="Metrics"
          href="#status"
          meta={
            <FreshnessBadge
              tooltip={false}
              variant="dot"
              freshness={{ state: "pending", observedAt: null, ageMs: null, ttlMs: null }}
            />
          }
        />
        <HealthPill
          tone="ok"
          icon="circle-check"
          label="Monitoring"
          href="#status"
          meta={
            <FreshnessBadge
              now={NOW}
              tooltip={false}
              variant="dot"
              freshness={{ state: "fresh", observedAt: ago(58 * SECOND), ageMs: null, ttlMs: null }}
            />
          }
        />
        <HealthPill
          tone="warn"
          icon="triangle-alert"
          label="Two endpoints degraded across the lab and backup hosts"
          count={2}
          href="#status"
        />
      </Specimen>
    </>
  );
}

export const status: WorkbenchSectionDef = {
  id: "status",
  title: "Status",
  catalogue: "B",
  Demo: Status,
};
