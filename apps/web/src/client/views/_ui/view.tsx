// src/client/views/_ui/view.tsx — the dev-only component workbench (`/_ui`).

import { useSignals } from "@preact/signals-react/runtime";
import type { ReactElement } from "react";

import type { ViewProps } from "../../../shared/registry.js";
import type { Theme } from "../../store/types.js";
import { PageHeader, Section, ToggleGroup, ToggleGroupItem, TooltipProvider } from "@/ui";
import { SECTIONS } from "./sections/index.js";

const THEMES: readonly Theme[] = ["light", "dark", "system"];

/**
 * Every `@/ui` component in its states, one `Section` per component family, over static fixtures
 * only (it never reads live data). The theme toggle writes the store's theme, so both themes can be
 * reviewed without leaving the page. Screenshots of this page are the library's visual baseline.
 */
export default function UiWorkbenchView({ store }: ViewProps): ReactElement {
  useSignals();
  const theme = store.theme.value;

  return (
    <TooltipProvider>
      <div data-slot="ui-workbench-page" className="mx-auto flex max-w-6xl flex-col gap-8 p-4 md:p-6">
        <PageHeader
          title="UI workbench"
          description={
            <>
              Every <code className="font-mono">@/ui</code> component, in its states. Development builds only.
            </>
          }
          actions={
            <ToggleGroup
              type="single"
              variant="outline"
              aria-label="Theme"
              value={theme}
              onValueChange={(next) => {
                if (next !== "") store.theme.value = next as Theme;
              }}
            >
              {THEMES.map((t) => (
                <ToggleGroupItem key={t} value={t} className="px-3 capitalize">
                  {t}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        />

        <nav aria-label="Workbench sections">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-primary underline-offset-4 hover:underline">
                  {section.catalogue !== undefined ? `${section.catalogue}. ` : ""}
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {SECTIONS.map(({ id, title, catalogue, Demo }) => (
          <Section key={id} id={id} level={2} title={`${catalogue !== undefined ? `${catalogue}. ` : ""}${title}`}>
            <Demo />
          </Section>
        ))}
      </div>
    </TooltipProvider>
  );
}
