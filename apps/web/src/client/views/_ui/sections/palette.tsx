import { useState } from "react";
import {
  Button,
  CommandPalette,
  Kbd,
  commandGroupsFromIndex,
  type CommandIndexEntry,
  type CommandPaletteGroup,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

/** A static command index in the shell's shape; the adapter turns it into palette groups. */
const INDEX: readonly CommandIndexEntry[] = [
  { kind: "view", id: "overview", label: "Overview", navPath: "/overview" },
  { kind: "view", id: "alerts", label: "Alerts", navPath: "/alerts" },
  { kind: "view", id: "estate", label: "Estate", navPath: "/estate" },
  { kind: "host", id: "nas-01", label: "nas-01", sublabel: "Critical", navPath: "/estate/host/nas-01" },
  { kind: "host", id: "edge-01", label: "edge-01", sublabel: "OK", navPath: "/estate/host/edge-01" },
  {
    kind: "service",
    id: "nas-01/smb",
    label: "smb",
    sublabel: "nas-01 · Warning",
    navPath: "/estate/service/nas-01/smb",
  },
  {
    kind: "alert",
    id: "fp-1",
    label: "DiskAlmostFull",
    sublabel: "nas-01 · critical",
    navPath: "/alerts/fp-1",
  },
];

function PaletteDemo({
  label,
  groups,
  onPicked,
}: {
  label: string;
  groups: (pick: (what: string) => void) => readonly CommandPaletteGroup[];
  onPicked: (what: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        placeholder="Jump to a view, host, service or alert…"
        emptyText="Nothing matches."
        groups={groups(onPicked)}
      />
    </>
  );
}

function Palette() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      <Specimen label="CommandPalette: data-driven groups, icons, hints, keywords; Escape returns focus">
        <PaletteDemo
          label="Open the palette"
          onPicked={setPicked}
          groups={(pick) => [
            {
              heading: "Actions",
              items: [
                {
                  id: "silence",
                  label: "Silence alert",
                  icon: "bell",
                  hint: "S",
                  keywords: ["mute"],
                  onSelect: () => pick("Silence alert"),
                },
                {
                  id: "theme",
                  label: "Toggle theme",
                  icon: "sun-moon",
                  keywords: ["dark", "light"],
                  onSelect: () => pick("Toggle theme"),
                },
              ],
            },
          ]}
        />
        <PaletteDemo
          label="Open from a command index"
          onPicked={setPicked}
          groups={(pick) => commandGroupsFromIndex(INDEX, (path) => pick(path))}
        />
        <span className="text-sm text-muted-foreground">
          The shell opens it with <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>.
        </span>
      </Specimen>
      <p role="status" className="text-sm text-muted-foreground">
        {picked === null ? "Nothing selected yet." : `Selected: ${picked}`}
      </p>
    </>
  );
}

export const palette: WorkbenchSectionDef = {
  id: "command-palette",
  title: "Command palette",
  Demo: Palette,
};
