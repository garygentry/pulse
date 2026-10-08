import type { ReactNode } from "react";
import {
  CodeBlock,
  ComparisonGrid,
  Disclosure,
  EmptyValue,
  Icon,
  KeyValue,
  KeyValueList,
  LogOutput,
  NotDeclared,
  NotObserved,
  NotSupplied,
  Prose,
  ShowMore,
  ShowMoreControls,
  Meter,
  StatGrid,
  StatTile,
  formatRelative,
  useShowMore,
  type IconName,
  type ComparisonRow,
  type Tone,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed data only: the workbench is snapshotted, so nothing here may vary per render.
const NOW = Date.parse("2026-01-15T12:00:00Z");
const SNAPSHOT_AT = "2026-01-15T11:54:00Z";

/** Full-width wrapper so wide components fill the specimen frame. */
function Wide({ children }: { children: ReactNode }) {
  return <div className="w-full min-w-0">{children}</div>;
}

// A stand-in sync marker (icon + text). Real screens pass the §B status badge.
function SyncMarker({ drifted }: { drifted: boolean }) {
  return drifted ? (
    <span className="inline-flex items-center gap-1 rounded-md border border-status-warn-border bg-status-warn-bg px-1.5 text-xs text-status-warn-fg">
      <Icon name="triangle-alert" size={12} />
      Drifted
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md border border-status-ok-border bg-status-ok-bg px-1.5 text-xs text-status-ok-fg">
      <Icon name="circle-check" size={12} />
      In sync
    </span>
  );
}

const HOST_FACTS = [
  { label: "Hostname", value: "nas-01.lan" },
  { label: "Address", value: <span className="font-mono tabular-nums">10.0.4.12</span>, hint: "From DHCP lease" },
  { label: "Operating system", value: "Debian 12 (bookworm)" },
  { label: "Owner", value: <NotDeclared /> },
  { label: "Last snapshot", value: <time dateTime={SNAPSHOT_AT}>{formatRelative(SNAPSHOT_AT, NOW)}</time> },
];

const COMPARISON: ComparisonRow[] = [
  { label: "Image", declared: "ghcr.io/acme/web:1.4.2", observed: "ghcr.io/acme/web:1.4.2", marker: <SyncMarker drifted={false} /> },
  { label: "Replicas", declared: "2", observed: "1", marker: <SyncMarker drifted /> },
  { label: "Port", declared: "8080", observed: <NotObserved />, marker: <SyncMarker drifted /> },
  { label: "Health check", declared: <NotDeclared />, observed: "GET /healthz → 200" },
];

const STAT_TONES: { tone: Tone; label: string; value: string; icon: IconName }[] = [
  { tone: "ok", label: "In sync", value: "128", icon: "circle-check" },
  { tone: "warn", label: "Active drift", value: "12", icon: "triangle-alert" },
  { tone: "danger", label: "Unreachable", value: "3", icon: "circle-x" },
  { tone: "info", label: "Waivers", value: "7", icon: "info" },
  { tone: "pending", label: "Awaiting snapshot", value: "4", icon: "hourglass" },
  { tone: "neutral", label: "Coverage", value: "92%", icon: "circle" },
];

const YAML_SOURCE = `# estate.yaml
services:
  web:
    image: ghcr.io/acme/web:1.4.2
    replicas: 2
    ports: [8080]
    enabled: true`;

// Hand-written highlight.js markup (what `hljs.highlight` emits), so the
// workbench shows the token theme without bundling a highlighter.
const YAML_HTML = `<span class="hljs-comment"># estate.yaml</span>
<span class="hljs-attr">services:</span>
  <span class="hljs-attr">web:</span>
    <span class="hljs-attr">image:</span> <span class="hljs-string">ghcr.io/acme/web:1.4.2</span>
    <span class="hljs-attr">replicas:</span> <span class="hljs-number">2</span>
    <span class="hljs-attr">ports:</span> [<span class="hljs-number">8080</span>]
    <span class="hljs-attr">enabled:</span> <span class="hljs-literal">true</span>`;

const TS_SOURCE = `export function probe(host: string): Promise<boolean> {
  // Resolve before the timeout, or report unreachable.
  return fetch(\`https://\${host}/healthz\`).then((r) => r.ok);
}`;

const TS_HTML = `<span class="hljs-keyword">export</span> <span class="hljs-keyword">function</span> <span class="hljs-title function_">probe</span>(<span class="hljs-params">host: <span class="hljs-built_in">string</span></span>): <span class="hljs-title class_">Promise</span>&lt;<span class="hljs-built_in">boolean</span>&gt; {
  <span class="hljs-comment">// Resolve before the timeout, or report unreachable.</span>
  <span class="hljs-keyword">return</span> <span class="hljs-title function_">fetch</span>(<span class="hljs-string">\`https://<span class="hljs-subst">\${host}</span>/healthz\`</span>).<span class="hljs-title function_">then</span>(<span class="hljs-function">(<span class="hljs-params">r</span>) =&gt;</span> r.<span class="hljs-property">ok</span>);
}`;

const LONG_LINE = `docker run --rm --name pulse --network host -e PULSE_ESTATE=/etc/pulse/estate.yaml -v /etc/pulse:/etc/pulse:ro ghcr.io/acme/pulse:0.4.0 --port 8080 --log-format json`;

const LONG_LOG = Array.from({ length: 40 }, (_, i) => `[${String(i + 1).padStart(2, "0")}] synced volume data-${i + 1}`).join("\n");

const PROSE_HTML = `<h2>Restoring a backup</h2>
<p>Backups land in <code>/srv/backup</code> nightly. See the <a href="#content">runbook</a> before restoring, and <strong>stop the service first</strong>.</p>
<ol><li>Stop the stack.</li><li>Restore the volume.</li><li>Start the stack and check health.</li></ol>
<blockquote><p>Restores overwrite the live volume.</p></blockquote>
<pre><code class="hljs language-bash"><span class="hljs-built_in">cd</span> /srv/stack &amp;&amp; docker compose down
restic restore latest --target /srv/data <span class="hljs-comment"># ~5 min</span></code></pre>
<table><thead><tr><th>Volume</th><th>Size</th></tr></thead><tbody><tr><td>data</td><td>4.2 GB</td></tr><tr><td>config</td><td>12 MB</td></tr></tbody></table>`;

const FINDINGS = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}: port ${8000 + i} declared but not listening`);

/** The headless hook with the stock controls: any list shape can reuse them. */
function ShowMoreHookDemo() {
  const state = useShowMore({ total: FINDINGS.length, initial: 2, step: 4 });
  return (
    <div className="flex flex-col gap-2">
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm">
        {FINDINGS.slice(0, state.visible).map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ol>
      <ShowMoreControls state={state} noun="findings" />
    </div>
  );
}

function Content() {
  return (
    <>
      <Specimen label="KeyValueList — grid (default), with hint and empty value">
        <Wide>
          <KeyValueList items={HOST_FACTS} />
        </Wide>
      </Specimen>
      <Specimen label="KeyValueList — stacked">
        <Wide>
          <KeyValueList layout="stacked" items={HOST_FACTS.slice(0, 3)} />
        </Wide>
      </Specimen>
      <Specimen label="KeyValueList — inline (meta row), children API">
        <Wide>
          <KeyValueList layout="inline">
            <KeyValue label="Actor" value="gary" />
            <KeyValue label="Duration" value={<span className="tabular-nums">1 204 ms</span>} />
            <KeyValue label="Exit code" value={<span className="tabular-nums">0</span>} />
          </KeyValueList>
        </Wide>
      </Specimen>
      <Specimen label="Empty-value renderers">
        <Wide>
          <KeyValueList
            items={[
              { label: "Declared owner", value: <NotDeclared /> },
              { label: "Observed version", value: <NotObserved /> },
              { label: "Optional parameter", value: <NotSupplied /> },
              { label: "Custom absent text", value: <EmptyValue>No labels</EmptyValue> },
            ]}
          />
        </Wide>
      </Specimen>

      <Specimen label="ComparisonGrid — rows with sync markers, empty sides">
        <Wide>
          <ComparisonGrid rows={COMPARISON} />
        </Wide>
      </Specimen>
      <Specimen label="ComparisonGrid — custom labels, descriptions, no markers">
        <Wide>
          <ComparisonGrid
            declaredLabel="Estate config"
            declaredDescription="estate.yaml @ main"
            observedLabel="Live host"
            observedDescription="Snapshot 6m ago"
            rows={[
              { label: "CPU", declared: "4 cores", observed: "4 cores" },
              { label: "Memory", declared: "16 GB", observed: "16 GB" },
            ]}
          />
        </Wide>
      </Specimen>

      <Specimen label="StatTile — every tone, with icon">
        <Wide>
          <StatGrid>
            {STAT_TONES.map((s) => (
              <StatTile key={s.tone} tone={s.tone} label={s.label} value={s.value} icon={s.icon} />
            ))}
          </StatGrid>
        </Wide>
      </Specimen>
      <Specimen label="StatTile — link, sub-label, plain">
        <Wide>
          <StatGrid>
            <StatTile tone="warn" label="Active drift" value="12" subLabel="3 new since yesterday" href="#content" />
            <StatTile label="Hosts" value="42" subLabel="across 3 sites" />
            <StatTile label="Uptime" value="99.95%" />
          </StatGrid>
        </Wide>
      </Specimen>
      <Specimen label="StatTile — absent value (not reported, unavailable)">
        <Wide>
          <StatGrid>
            <StatTile label="Ingestion rate" value="not reported" valueState="absent" absentDescription="no value: the source did not report it" />
            <StatTile tone="danger" label="Free disk" value="unavailable" valueState="absent" absentDescription="no value: the source is unavailable" />
          </StatGrid>
        </Wide>
      </Specimen>

      <Specimen label="Meter — tones with icons, meta line, clamped over-max">
        <Wide>
          <div className="grid gap-5 md:grid-cols-2">
            <Meter label="Current session" value={24} tone="ok" icon="circle-check" meta="Resets in 2h 14m · via OAuth" />
            <Meter label="All models" value={78} tone="warn" icon="triangle-alert" meta="Resets in 3d 4h · via statusLine" />
            <Meter label="Opus" value={100} tone="danger" icon="octagon-alert" meta="Limit reached" />
            <Meter label="Disk" value={130} max={200} valueText="130 / 200 GB" />
          </div>
        </Wide>
      </Specimen>

      <Specimen label="CodeBlock — highlighted YAML, caption, copy">
        <Wide>
          <CodeBlock caption="estate.yaml" language="yaml" code={YAML_SOURCE} highlightedHtml={YAML_HTML} />
        </Wide>
      </Specimen>
      <Specimen label="CodeBlock — highlighted TypeScript, no caption">
        <Wide>
          <CodeBlock language="typescript" code={TS_SOURCE} highlightedHtml={TS_HTML} />
        </Wide>
      </Specimen>
      <Specimen label="CodeBlock — plain text: scroll (default) vs wrap">
        <Wide>
          <div className="flex flex-col gap-3">
            <CodeBlock caption="Scrolls horizontally" code={LONG_LINE} />
            <CodeBlock caption="Wraps" code={LONG_LINE} wrap copy={false} />
          </div>
        </Wide>
      </Specimen>
      <Specimen label="CodeBlock — maxHeight, no toolbar">
        <Wide>
          <CodeBlock code={LONG_LOG} copy={false} maxHeight="8rem" />
        </Wide>
      </Specimen>

      <Specimen label="LogOutput — streaming, no output yet">
        <Wide>
          <LogOutput label="Run output" streaming />
        </Wide>
      </Specimen>
      <Specimen label="LogOutput — streaming (snapshot)">
        <Wide>
          <LogOutput
            label="Run output"
            streaming
            stdout={"Pulling ghcr.io/acme/web:1.4.2\nlayer 1/3 done\nlayer 2/3 done"}
          />
        </Wide>
      </Specimen>
      <Specimen label="LogOutput — finished with stderr">
        <Wide>
          <LogOutput
            label="Run output"
            stdout={"Stopping web … done\nStarting web … done"}
            stderr={"warning: healthcheck took 4.8s (limit 5s)"}
          />
        </Wide>
      </Specimen>
      <Specimen label="LogOutput — finished, no output; long output capped">
        <Wide>
          <div className="flex flex-col gap-3">
            <LogOutput label="Run output" />
            <LogOutput label="Sync log" stdout={LONG_LOG} maxHeight="8rem" />
          </div>
        </Wide>
      </Specimen>

      <Specimen label="Prose — rendered (already sanitized) markdown">
        <Wide>
          <Prose sanitizedHtml={PROSE_HTML} />
        </Wide>
      </Specimen>

      <Specimen label="Disclosure — collapsed, with count">
        <Wide>
          <Disclosure label="Waivers" count={3}>
            <p className="m-0 text-sm">3 findings are waived until 2026-02-01.</p>
          </Disclosure>
        </Wide>
      </Specimen>
      <Specimen label="Disclosure — expanded, no count">
        <Wide>
          <Disclosure label="Snapshot details" defaultOpen>
            <KeyValueList
              items={[
                { label: "Taken", value: <time dateTime={SNAPSHOT_AT}>{formatRelative(SNAPSHOT_AT, NOW)}</time> },
                { label: "Probe", value: "ssh" },
              ]}
            />
          </Disclosure>
        </Wide>
      </Specimen>

      <Specimen label="ShowMore — step of 3 (Show 3 more / Show all)">
        <Wide>
          <ShowMore
            label="Findings"
            items={FINDINGS}
            initial={3}
            step={3}
            noun="findings"
            renderItem={(f) => <span className="text-sm">{f}</span>}
          />
        </Wide>
      </Specimen>
      <Specimen label="ShowMore — reveal the rest at once; everything visible">
        <Wide>
          <div className="flex flex-col gap-4">
            <ShowMore
              label="Hosts"
              items={FINDINGS.slice(0, 6)}
              initial={4}
              renderItem={(f) => <span className="text-sm">{f}</span>}
            />
            <ShowMore
              label="Short list"
              items={FINDINGS.slice(0, 2)}
              renderItem={(f) => <span className="text-sm">{f}</span>}
            />
          </div>
        </Wide>
      </Specimen>
      <Specimen label="useShowMore + ShowMoreControls — headless state, stock buttons">
        <Wide>
          <ShowMoreHookDemo />
        </Wide>
      </Specimen>
    </>
  );
}

export const content: WorkbenchSectionDef = {
  id: "content",
  title: "Content & data display",
  catalogue: "D",
  Demo: Content,
};
