import { useRef, useState } from "react";
import { Input, formatDocumentTitle, useListNavigation } from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

const ITEMS = ["alpha.invalid", "bravo.invalid", "charlie.invalid", "delta.invalid"] as const;

function ListNavigationDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activated, setActivated] = useState<string | null>(null);

  // Element scope: only keys pressed inside this frame are handled, never the whole page.
  useListNavigation({
    keys: "arrows",
    scope: "element",
    containerRef,
    getItems: () => listRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
  });

  return (
    <div ref={containerRef} className="flex w-full max-w-sm flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Focus an item, then use ↑/↓, Home/End, Enter or Space. Keys typed in the text field stay
        in the field.
      </p>
      <Input aria-label="Editable field (keys pass through)" placeholder="Type j, k, Home…" />
      <ul ref={listRef} aria-label="Demo hosts" className="flex flex-col gap-1">
        {ITEMS.map((name) => (
          <li key={name}>
            <button
              type="button"
              onClick={() => setActivated(name)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-left font-mono text-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
      <p role="status" className="text-sm text-muted-foreground">
        {activated === null ? "Nothing activated yet." : `Activated ${activated}.`}
      </p>
    </div>
  );
}

function Hooks() {
  return (
    <>
      <Specimen label='useListNavigation — "arrows" preset, element scope, editable guard'>
        <ListNavigationDemo />
      </Specimen>
      <Specimen label="useDocumentTitle">
        <code className="font-mono text-sm">{formatDocumentTitle("Hosts")}</code>
        <code className="font-mono text-sm">{formatDocumentTitle(null)}</code>
      </Specimen>
      <Specimen label="useScrollToHash">
        <p className="text-sm text-muted-foreground">
          On page entry, scrolls to and focuses the element named by the URL fragment (for example{" "}
          <code className="font-mono">/monitoring#alerts</code>).
        </p>
      </Specimen>
    </>
  );
}

export const hooks: WorkbenchSectionDef = {
  id: "hooks",
  title: "Interaction hooks",
  catalogue: "G",
  Demo: Hooks,
};
