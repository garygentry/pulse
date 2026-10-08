import { useRef, useState, type ReactNode } from "react";
import {
  Button,
  CardGrid,
  DataTable,
  Icon,
  Input,
  LinkTile,
  List,
  ListGroup,
  ListItem,
  TreeView,
  type ColumnDef,
  type DataTableHandle,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

// Fixed data only: the workbench is snapshotted, so nothing here may vary per render.

function Wide({ children }: { children: ReactNode }) {
  return <div className="w-full min-w-0">{children}</div>;
}

// A stand-in status marker (icon + text). Real screens pass the §B StatusBadge.
function Marker({ tone, children }: { tone: "ok" | "warn" | "danger"; children: ReactNode }) {
  const cls = {
    ok: "border-status-ok-border bg-status-ok-bg text-status-ok-fg",
    warn: "border-status-warn-border bg-status-warn-bg text-status-warn-fg",
    danger: "border-status-danger-border bg-status-danger-bg text-status-danger-fg",
  }[tone];
  const icon = { ok: "circle-check", warn: "triangle-alert", danger: "circle-x" }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 text-xs ${cls}`}>
      <Icon name={icon} size={12} />
      {children}
    </span>
  );
}

interface HostRow {
  key: string;
  name: string;
  kind: string;
  purpose: string;
  declared: number;
  collection: "ok" | "warn" | "danger";
  observed: number;
}

const HOSTS: HostRow[] = [
  { key: "nas-01", name: "nas-01", kind: "Bare metal", purpose: "Storage", declared: 6, collection: "ok", observed: 6 },
  { key: "pve-02", name: "pve-02", kind: "Hypervisor", purpose: "Compute", declared: 12, collection: "warn", observed: 10 },
  { key: "edge-03", name: "edge-03", kind: "VM", purpose: "Ingress", declared: 3, collection: "danger", observed: 0 },
];

const COLLECTION_LABEL = { ok: "Fresh", warn: "Stale", danger: "Unreachable" } as const;

const GROUPED_COLUMNS: ColumnDef<HostRow>[] = [
  { accessorKey: "name", header: "Host" },
  {
    id: "intent",
    header: "Declared intent",
    columns: [
      { accessorKey: "kind", header: "Kind" },
      { accessorKey: "purpose", header: "Purpose" },
      { accessorKey: "declared", header: "Services", meta: { align: "end" } },
    ],
  },
  {
    id: "reality",
    header: "Observed reality",
    columns: [
      {
        accessorKey: "collection",
        header: "Collection",
        cell: ({ row }) => <Marker tone={row.original.collection}>{COLLECTION_LABEL[row.original.collection]}</Marker>,
      },
      { accessorKey: "observed", header: "Services", meta: { align: "end" } },
    ],
  },
];

const FLAT_COLUMNS: ColumnDef<HostRow>[] = [
  { accessorKey: "name", header: "Host" },
  { accessorKey: "kind", header: "Kind" },
  { accessorKey: "declared", header: "Declared services", meta: { align: "end" } },
];

interface AddressRow {
  id: string;
  address: string;
  mac: string;
  iface: string;
  source: string;
  lease: string;
  vlan: number;
  note: string;
}

const ADDRESSES: AddressRow[] = [
  { id: "a1", address: "10.0.4.12", mac: "3c:ec:ef:12:9a:01", iface: "enp3s0", source: "DHCP lease", lease: "2026-01-15 11:54", vlan: 40, note: "Primary storage network" },
  { id: "a2", address: "10.0.8.12", mac: "3c:ec:ef:12:9a:02", iface: "enp4s0", source: "Static", lease: "—", vlan: 80, note: "Replication link to the offsite box" },
];

const ADDRESS_COLUMNS: ColumnDef<AddressRow>[] = [
  { accessorKey: "address", header: "Address", meta: { className: "font-mono" } },
  { accessorKey: "mac", header: "MAC", meta: { className: "font-mono" } },
  { accessorKey: "iface", header: "Interface" },
  { accessorKey: "source", header: "Source" },
  { accessorKey: "lease", header: "Seen at" },
  { accessorKey: "vlan", header: "VLAN", meta: { align: "end" } },
  { accessorKey: "note", header: "Note" },
];

interface TargetRow {
  id: string;
  instance: string;
  job: string;
  state: "ok" | "warn" | "danger";
  latencyMs: number;
}

const JOBS = ["node", "blackbox", "cadvisor", "postgres", "gatus"] as const;
const TARGET_STATES = ["ok", "ok", "ok", "warn", "ok", "ok", "danger"] as const;

/** 5,000 deterministic rows: well past the 300-row virtualization threshold. */
const TARGETS: TargetRow[] = Array.from({ length: 5_000 }, (_, i) => ({
  id: `t${i}`,
  instance: `host-${String(Math.floor(i / 5) + 1).padStart(4, "0")}:${9100 + (i % 5)}`,
  job: JOBS[i % JOBS.length] ?? "node",
  state: TARGET_STATES[i % TARGET_STATES.length] ?? "ok",
  latencyMs: 4 + ((i * 37) % 211),
}));

const TARGET_STATE_LABEL = { ok: "Up", warn: "Slow", danger: "Down" } as const;

const TARGET_COLUMNS: ColumnDef<TargetRow>[] = [
  { accessorKey: "instance", header: "Instance", meta: { className: "font-mono" } },
  { accessorKey: "job", header: "Job" },
  {
    accessorKey: "state",
    header: "State",
    cell: ({ row }) => <Marker tone={row.original.state}>{TARGET_STATE_LABEL[row.original.state]}</Marker>,
  },
  { accessorKey: "latencyMs", header: "Scrape ms", meta: { align: "end" } },
];

function VirtualizedTable() {
  const table = useRef<DataTableHandle>(null);
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => table.current?.scrollToIndex(2_500, { align: "center" })}>
          Scroll to row 2,501
        </Button>
        <Button size="sm" variant="outline" onClick={() => table.current?.scrollToIndex(TARGETS.length - 1)}>
          Scroll to the last row
        </Button>
      </div>
      <DataTable
        ref={table}
        caption="Scrape targets (5,000, virtualized)"
        columns={TARGET_COLUMNS}
        data={TARGETS}
        getRowId={(r) => r.id}
        rowLink={(r) => `#target-${r.id}`}
        virtualize
        className="max-h-96"
      />
    </div>
  );
}

interface FileNode {
  path: string;
  name: string;
  children?: FileNode[];
}

const FILES: FileNode[] = [
  {
    path: "docs",
    name: "docs",
    children: [
      { path: "docs/guide.md", name: "guide.md" },
      { path: "docs/runbooks", name: "runbooks", children: [{ path: "docs/runbooks/restore.md", name: "restore.md" }, { path: "docs/runbooks/upgrade.md", name: "upgrade.md" }] },
    ],
  },
  { path: "configs", name: "configs", children: [{ path: "configs/compose.yaml", name: "compose.yaml" }] },
  { path: "empty", name: "empty", children: [] },
  { path: "readme.md", name: "readme.md" },
];

const treeAccessors = {
  getId: (n: FileNode) => n.path,
  getLabel: (n: FileNode) => n.name,
  getChildren: (n: FileNode) => n.children,
  isLeaf: (n: FileNode) => n.children === undefined,
};

function TreeDemo({ initialFilter = "", defaultExpanded }: { initialFilter?: string; defaultExpanded?: string[] }) {
  const [selected, setSelected] = useState<string | null>("docs/guide.md");
  const [filter, setFilter] = useState(initialFilter);
  return (
    <div className="flex w-72 flex-col gap-2">
      <Input aria-label="Filter files" type="search" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
      <TreeView
        aria-label="Files"
        nodes={FILES}
        {...treeAccessors}
        {...(defaultExpanded !== undefined ? { defaultExpanded } : {})}
        selectedId={selected}
        onSelect={(n) => setSelected(n.path)}
        filter={filter}
        empty={`No files match ‘${filter}’`}
      />
    </div>
  );
}

// 40 hosts × 12 services, every host open: 520 rows, past the virtualization threshold.
interface HostNode {
  id: string;
  name: string;
  children?: HostNode[];
}
const BIG_TREE: HostNode[] = Array.from({ length: 40 }, (_, h) => ({
  id: `node-${h}`,
  name: `node-${String(h).padStart(2, "0")}`,
  children: Array.from({ length: 12 }, (_, s) => ({ id: `node-${h}/svc-${s}`, name: `service-${String(s).padStart(2, "0")}` })),
}));
const BIG_TREE_OPEN = BIG_TREE.map((n) => n.id);

function VirtualTreeDemo() {
  return (
    <div className="flex w-72 flex-col">
      <TreeView
        aria-label="Hosts"
        nodes={BIG_TREE}
        getId={(n) => n.id}
        getLabel={(n) => n.name}
        getChildren={(n) => n.children}
        defaultExpanded={BIG_TREE_OPEN}
        virtualize
      />
    </div>
  );
}

function SelectableList() {
  const [selected, setSelected] = useState("disk");
  const rows = [
    { id: "disk", title: "Disk usage", description: "Root filesystem above 85%" },
    { id: "cpu", title: "CPU load", description: "5-minute load above core count" },
  ];
  return (
    <List variant="divided" aria-label="Metrics">
      {rows.map((r) => (
        <ListItem key={r.id} title={r.title} description={r.description} selected={selected === r.id} onSelect={() => setSelected(r.id)} />
      ))}
    </List>
  );
}

function Demo() {
  return (
    <div className="grid gap-4">
      <Specimen label="DataTable · grouped header, visible caption, row links">
        <Wide>
          <DataTable
            caption="Hosts: declared intent beside observed reality"
            columns={GROUPED_COLUMNS}
            data={HOSTS}
            getRowId={(r) => r.key}
            rowLink={(r) => `#host-${r.key}`}
          />
        </Wide>
      </Specimen>
      <Specimen label="DataTable · comfortable density, sr-only caption">
        <Wide>
          <DataTable caption="Hosts" captionHidden density="comfortable" columns={FLAT_COLUMNS} data={HOSTS} getRowId={(r) => r.key} />
        </Wide>
      </Specimen>
      <Specimen label="DataTable · empty">
        <Wide>
          <DataTable
            caption="Services on this host"
            columns={FLAT_COLUMNS}
            data={[]}
            getRowId={(r) => r.key}
            empty={{ title: "No services declared", description: "Declare services in the estate config." }}
          />
        </Wide>
      </Specimen>
      <Specimen label="DataTable · overflow (scrolls horizontally in a focusable region; sticky header in a bounded height)">
        <div className="w-full max-w-md min-w-0">
          <DataTable caption="Addresses" columns={ADDRESS_COLUMNS} data={ADDRESSES} getRowId={(r) => r.id} className="max-h-40" />
        </div>
      </Specimen>

      <Specimen label="DataTable · virtualize: 5,000 rows, sticky header, aria-rowcount/aria-rowindex, scrollToIndex">
        <Wide>
          <VirtualizedTable />
        </Wide>
      </Specimen>

      <Specimen label="List · plain, static, with leading / meta / actions">
        <Wide>
          <List aria-label="Collectors">
            <ListItem
              leading={<Marker tone="ok">OK</Marker>}
              title="node-exporter"
              description="Host metrics collector"
              meta={<span>6 min ago</span>}
              actions={<Button size="sm" variant="ghost">Retry</Button>}
            />
            <ListItem leading={<Marker tone="danger">Failed</Marker>} title="smartctl" description="Timed out after 30 s" meta={<span>1 h ago</span>} />
          </List>
        </Wide>
      </Specimen>
      <Specimen label="List · divided, whole-row links, one selected (aria-current)">
        <Wide>
          <List variant="divided" aria-label="Search results">
            <ListItem href="#r1" title="Restore a snapshot" description="docs/runbooks/restore.md" selected />
            <ListItem href="#r2" title="Upgrade the cluster" description="docs/runbooks/upgrade.md" meta={<span>2 matches</span>} />
          </List>
        </Wide>
      </Specimen>
      <Specimen label="List · divided, whole-row buttons (onSelect)">
        <Wide>
          <SelectableList />
        </Wide>
      </Specimen>
      <Specimen label="List · card variant, ordered">
        <Wide>
          <List as="ol" variant="card" aria-label="Audit history">
            <ListItem title="Silence created" description="edge-03 unreachable, 2 h" meta={<span>2026-01-15 11:40</span>} />
            <ListItem title="Silence expired" description="pve-02 stale" meta={<span>2026-01-15 09:12</span>} />
          </List>
        </Wide>
      </Specimen>
      <Specimen label="ListGroup · heading + count">
        <Wide>
          <ListGroup heading="Critical" level={3} count={2}>
            <List variant="divided">
              <ListItem href="#a1" leading={<Marker tone="danger">Critical</Marker>} title="edge-03 unreachable" meta={<span>12 min</span>} />
              <ListItem href="#a2" leading={<Marker tone="danger">Critical</Marker>} title="Backup job failed" meta={<span>1 h</span>} />
            </List>
          </ListGroup>
        </Wide>
      </Specimen>

      <Specimen label="CardGrid of LinkTiles · heading, 2-D arrow keys (internal, external, no status, disabled)">
        <Wide>
          <CardGrid heading="Media" level={3} count={4} navigable>
            <LinkTile href="#jellyfin" icon="circle-play" title="Jellyfin" description="Media server" status={<Marker tone="ok">Up</Marker>} meta={<span>Checked 2 min ago</span>} />
            <LinkTile href="https://example.com/docs" external icon="link" title="Upstream docs" description="Opens the vendor site" />
            <LinkTile href="#arr" icon="archive" title="Archive" description="Cold storage browser" />
            <LinkTile disabled icon="eye-off" title="Photos" description="Photo library" disabledReason="No URL declared" status={<Marker tone="warn">Unknown</Marker>} />
          </CardGrid>
        </Wide>
      </Specimen>
      <Specimen label="CardGrid · no heading (aria-label)">
        <Wide>
          <CardGrid aria-label="Integrations">
            <LinkTile href="#prom" icon="database-check" title="Prometheus" meta={<span>Connected</span>} />
            <LinkTile icon="cloud-off" title="Loki" description="Not configured" />
          </CardGrid>
        </Wide>
      </Specimen>

      <Specimen label="TreeView · expanded branch, selected leaf (arrows / Home / End / Space / Enter)">
        <TreeDemo defaultExpanded={["docs"]} />
      </Specimen>
      <Specimen label="TreeView · filtered (ancestors of matches auto-expand)">
        <TreeDemo initialFilter="restore" />
      </Specimen>
      <Specimen label="TreeView · filter with no matches">
        <TreeDemo initialFilter="zzz" />
      </Specimen>
      <Specimen label="TreeView · virtualize, 520 rows (a window rendered; End / type-ahead / * reach every row)">
        <VirtualTreeDemo />
      </Specimen>
    </div>
  );
}

export const collections: WorkbenchSectionDef = {
  id: "collections",
  title: "Collections",
  catalogue: "E",
  Demo,
};
