// apps/web/tests/browser/fixtures/ui-data-table.tsx — browser fixture page: the `@/ui` DataTable
// virtualized over 5,000 rows, with arrow-key navigation over its row links (useListNavigation,
// scoped to the table). Every 4th row carries a second line (a taller row), so the table's row
// measurement is exercised; its handle is `window.__dataTable`. Bundled by _harness.buildFixturePage.
// The global stylesheet first: its `@layer` order statement must lead the bundled CSS.
import "../../../src/client/styles/app.css";

import { useRef } from "react";

import { DataTable, ROW_LINK_SELECTOR, useListNavigation, type ColumnDef, type DataTableHandle } from "@/ui";

import { render } from "../../react-render.js";

const ROW_COUNT = 5000;

interface Host {
  key: string;
  kind: string;
  services: number;
}

const HOSTS: Host[] = Array.from({ length: ROW_COUNT }, (_, i) => ({
  key: `host-${i}`,
  kind: i % 3 === 0 ? "Bare metal" : "VM",
  services: (i * 7) % 23,
}));

const COLUMNS: ColumnDef<Host>[] = [
  { accessorKey: "key", header: "Host" },
  {
    accessorKey: "kind",
    header: "Kind",
    // Every 4th row: a second line under the kind, as the alert catalog's rule errors are.
    cell: ({ row }) =>
      row.index % 4 === 0 ? (
        <span className="flex flex-col gap-1">
          {row.original.kind}
          <span className="text-xs text-muted-foreground">second line</span>
        </span>
      ) : (
        row.original.kind
      ),
  },
  { accessorKey: "services", header: "Services", meta: { align: "end" } },
];

function Fixture() {
  const containerRef = useRef<HTMLDivElement>(null);
  useListNavigation({
    getItems: () => containerRef.current?.querySelectorAll<HTMLElement>(ROW_LINK_SELECTOR) ?? [],
    keys: "arrows",
    scope: "element",
    containerRef,
  });
  return (
    <main className="p-4">
      <h1 className="mb-4 text-lg font-semibold">Hosts</h1>
      <div ref={containerRef}>
        <DataTable
          caption="Every host"
          columns={COLUMNS}
          data={HOSTS}
          getRowId={(row) => row.key}
          rowLink={(row) => `/hosts/${row.key}`}
          virtualize
          ref={(handle) => {
            (window as unknown as { __dataTable?: DataTableHandle | null }).__dataTable = handle;
          }}
          className="max-h-96"
        />
      </div>
    </main>
  );
}

const root = document.getElementById("app");
if (root === null) throw new Error("[ui-data-table fixture] #app mount node missing");
render(<Fixture />, root);
document.documentElement.dataset["fixtureReady"] = "1";
