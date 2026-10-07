import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  FragmentBoundary,
  Icon,
  LoadingState,
  PageErrorBoundary,
  PageHeader,
  Section,
  TONES,
  type LoadingPreset,
  type Tone,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Heading levels: the workbench page owns the only h1 and this group is an h2,
// so every PageHeader / page-level demo here passes `level={3}` (and Sections
// `level={3}`). The demos keep their real structure without adding a second h1
// to the document outline. Each demo also gets its own title (or explicit id)
// so derived heading ids stay unique on the page.

const PRESETS: readonly LoadingPreset[] = ["lines", "table", "cards", "detail"];

const TONE_COPY: Record<Tone, { title: string; body: string }> = {
  ok: { title: "All clear", body: "Every target is up across 12 hosts." },
  warn: { title: "Output truncated", body: "Showing the first 500 lines of 2,048." },
  danger: { title: "Run failed", body: "The action exited with status 1." },
  info: { title: "Read-only", body: "Actions are disabled in this deployment." },
  pending: { title: "Collecting", body: "Waiting for the first inventory snapshot." },
  neutral: { title: "Binary file", body: "This file can't be previewed." },
};

/** Always throws: drives the boundaries' failed state deterministically. */
function Throws(): never {
  throw new Error("workbench: simulated render failure");
}

/** A boundary child that renders until "Break" is pressed. */
function Breakable({ label }: { label: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) Throws();
  return (
    <div className="flex items-center gap-3 text-sm">
      <span>{label}</span>
      <Button size="sm" variant="outline" onClick={() => setBroken(true)}>
        Break
      </Button>
    </div>
  );
}

function DismissibleCallout() {
  const [open, setOpen] = useState(true);
  return open ? (
    <Callout tone="info" title="New: keyboard navigation" onDismiss={() => setOpen(false)} className="w-full">
      <p>
        Press <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> to move between rows.
      </p>
    </Callout>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      Show the dismissed callout again
    </Button>
  );
}

function Scaffolding() {
  return (
    <>
      <Specimen label="PageHeader: title only (level 3 demo)">
        <PageHeader level={3} title="Hosts" className="w-full" />
      </Specimen>
      <Specimen label="PageHeader: breadcrumbs, meta, description, actions">
        <PageHeader
          level={3}
          className="w-full"
          title="nas-01"
          breadcrumbs={[{ label: "Hosts", href: "#scaffolding" }, { label: "nas-01" }]}
          meta={
            <Badge variant="outline">
              <Icon name="circle-check" /> Observed
            </Badge>
          }
          description="Targets, services and alerts for this host."
          actions={
            <>
              <Button size="sm" variant="outline">
                Refresh
              </Button>
              <Button size="sm">Open console</Button>
            </>
          }
        />
      </Specimen>
      <Specimen label="PageHeader: long title wraps, actions drop below">
        <PageHeader
          level={3}
          className="w-full"
          title="A deliberately long page title that has to wrap on narrow screens"
          actions={<Button size="sm">Action</Button>}
        />
      </Specimen>

      <Specimen label="Section: plain and card, with description and actions">
        <div className="flex w-full flex-col gap-4">
          <Section level={3} id="wb-section-plain" title="Addresses" description="Scrape targets on this host.">
            <p className="text-sm">Section body.</p>
          </Section>
          <Section
            level={3}
            id="wb-section-card"
            variant="card"
            title="Services"
            actions={
              <Button size="sm" variant="outline">
                View all
              </Button>
            }
          >
            <p className="text-sm">Section body on a card surface.</p>
          </Section>
        </div>
      </Specimen>

      <Specimen label="EmptyState: default, with description + action, custom icon">
        <div className="grid w-full gap-4 md:grid-cols-3">
          <EmptyState title="No documents to show" />
          <EmptyState
            title="No services declared"
            description="Declare services in estate.yaml to monitor them."
            action={
              <Button size="sm" variant="outline">
                Read the docs
              </Button>
            }
          />
          <EmptyState icon="search-x" title="No matches" description="Try a different search or clear filters." />
        </div>
      </Specimen>
      <Specimen label="EmptyState compact (in-table / in-list)">
        <div className="flex w-full flex-col divide-y rounded-lg border px-3">
          <EmptyState compact title="No services on this host." />
          <EmptyState
            compact
            icon="search-x"
            title="No matching hosts."
            description="3 hidden by filters."
            action={
              <Button size="sm" variant="link" className="h-auto p-0">
                Clear filters
              </Button>
            }
          />
        </div>
      </Specimen>

      <Specimen label="ErrorState: title only, message + retry, details, compact">
        <div className="grid w-full items-start gap-4 md:grid-cols-2">
          <ErrorState title="This source could not be loaded" />
          <ErrorState title="This source could not be loaded" message="The git remote did not respond." onRetry={() => {}} />
          <ErrorState
            title="Failed to load configuration"
            message="GET /api/config → 503"
            details="upstream: estate-config reader timed out after 5000ms"
            onRetry={() => {}}
          />
          <ErrorState compact title="Metrics unavailable" onRetry={() => {}} retryLabel="Retry metrics" />
        </div>
      </Specimen>

      {PRESETS.map((preset) => (
        <Specimen key={preset} label={`LoadingState preset="${preset}"`}>
          <LoadingState preset={preset} label={`Loading ${preset}…`} />
        </Specimen>
      ))}
      <Specimen label="LoadingState with a visually hidden label">
        <LoadingState hideLabel rows={2} label="Loading hosts…" />
      </Specimen>

      <Specimen label="Callout: every tone (role: danger → alert; warn/ok/pending → status; info/neutral → note)">
        <div className="grid w-full gap-3 md:grid-cols-2">
          {TONES.map((tone) => (
            <Callout key={tone} tone={tone} title={TONE_COPY[tone].title}>
              {TONE_COPY[tone].body}
            </Callout>
          ))}
        </div>
      </Specimen>
      <Specimen label="Callout: body only, with action, compact, dismissible (caller-owned)">
        <div className="flex w-full flex-col gap-3">
          <Callout tone="warn">Showing cached data; the last refresh failed.</Callout>
          <Callout
            tone="danger"
            title="Host not found"
            action={
              <Button size="sm" variant="outline">
                Back to hosts
              </Button>
            }
          >
            No host named “nas-99” is declared or observed.
          </Callout>
          <Callout compact tone="ok">
            Waiver applied.
          </Callout>
          <DismissibleCallout />
        </div>
      </Specimen>

      <Specimen label="PageErrorBoundary: failed (render threw) — header + ErrorState + Retry">
        <div className="w-full">
          <PageErrorBoundary level={3} title="Alerts view could not be displayed">
            <Throws />
          </PageErrorBoundary>
        </div>
      </Specimen>
      <Specimen label="PageErrorBoundary: healthy (press Break to fail, Retry to remount)">
        <div className="w-full">
          <PageErrorBoundary level={3} title="Estate view could not be displayed" retryLabel="Retry estate view">
            <Breakable label="Page content renders normally." />
          </PageErrorBoundary>
        </div>
      </Specimen>

      <Specimen label="FragmentBoundary: failed with href, failed without, custom fallback, healthy">
        <div className="flex w-full flex-col gap-3">
          <FragmentBoundary label="Alerts summary" href="#scaffolding">
            <Throws />
          </FragmentBoundary>
          <FragmentBoundary label="Evidence field">
            <Throws />
          </FragmentBoundary>
          <FragmentBoundary
            label="Metrics summary"
            fallback={<span className="text-sm text-muted-foreground">Metrics: —</span>}
          >
            <Throws />
          </FragmentBoundary>
          <FragmentBoundary label="Coverage fragment">
            <Breakable label="Fragment renders normally." />
          </FragmentBoundary>
        </div>
      </Specimen>

    </>
  );
}

export const scaffolding: WorkbenchSectionDef = {
  id: "scaffolding",
  title: "Page scaffolding & feedback",
  catalogue: "C",
  Demo: Scaffolding,
};
