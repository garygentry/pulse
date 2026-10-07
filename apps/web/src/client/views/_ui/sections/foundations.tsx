import { ExternalLink, ICONS, Icon, SafeRouteLink, VisuallyHidden, type IconName } from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Literal class names so Tailwind generates every tone utility.
const TONES = [
  { tone: "ok", className: "border-status-ok-border bg-status-ok-bg text-status-ok-fg" },
  { tone: "warn", className: "border-status-warn-border bg-status-warn-bg text-status-warn-fg" },
  {
    tone: "danger",
    className: "border-status-danger-border bg-status-danger-bg text-status-danger-fg",
  },
  { tone: "info", className: "border-status-info-border bg-status-info-bg text-status-info-fg" },
  {
    tone: "pending",
    className: "border-status-pending-border bg-status-pending-bg text-status-pending-fg",
  },
  {
    tone: "neutral",
    className: "border-status-neutral-border bg-status-neutral-bg text-status-neutral-fg",
  },
] as const;

const SURFACES = [
  { name: "background", className: "bg-background text-foreground" },
  { name: "card", className: "bg-card text-card-foreground" },
  { name: "muted", className: "bg-muted text-muted-foreground" },
  { name: "secondary", className: "bg-secondary text-secondary-foreground" },
  { name: "accent", className: "bg-accent text-accent-foreground" },
  { name: "primary", className: "bg-primary text-primary-foreground" },
  { name: "destructive", className: "bg-destructive text-destructive-foreground" },
] as const;

const hostHref = (host: string): string => `/estate/host/${encodeURIComponent(host)}`;

function Foundations() {
  return (
    <>
      <Specimen label="Status tones (fg on bg, border)">
        {TONES.map(({ tone, className }) => (
          <span key={tone} className={`rounded-md border px-3 py-1 text-sm ${className}`}>
            {tone}
          </span>
        ))}
      </Specimen>
      <Specimen label="Surfaces">
        {SURFACES.map(({ name, className }) => (
          <span key={name} className={`rounded-md border border-border px-3 py-1 text-sm ${className}`}>
            {name}
          </span>
        ))}
      </Specimen>
      <Specimen label="Type: sans, mono, tabular numbers">
        <span className="text-sm">Geist Sans — The quick brown fox</span>
        <code className="font-mono text-sm">Geist Mono — pulse render</code>
        <span className="text-sm tabular-nums">1,234.50 · 98.76</span>
      </Specimen>
      <Specimen label="Icons (curated set, including aliases)">
        <ul className="grid w-full grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
          {(Object.keys(ICONS) as IconName[]).map((name) => (
            <li key={name} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name={name} className="text-foreground" />
              <span className="truncate">{name}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="not-an-icon" className="text-foreground" />
            <span>unknown → fallback</span>
          </li>
        </ul>
      </Specimen>
      <Specimen label="SafeRouteLink — valid href; unencodable param (URIError) → marker">
        <SafeRouteLink build={() => hostHref("nas-01")}>nas-01</SafeRouteLink>
        <SafeRouteLink build={() => hostHref("\uD800")}>broken</SafeRouteLink>
      </Specimen>
      <Specimen label="ExternalLink — new tab, external glyph, sr “(opens in new tab)”">
        <ExternalLink href="https://example.com/grafana">Grafana</ExternalLink>
        <ExternalLink href="https://example.com/docs" showIcon={false}>
          Docs (no glyph)
        </ExternalLink>
      </Specimen>
      <Specimen label="VisuallyHidden — the bracketed text is sr-only">
        <span className="text-sm">
          Visible text [<VisuallyHidden>screen-reader only</VisuallyHidden>]
        </span>
      </Specimen>
    </>
  );
}

export const foundations: WorkbenchSectionDef = {
  id: "foundations",
  title: "Foundations",
  catalogue: "A",
  Demo: Foundations,
};
