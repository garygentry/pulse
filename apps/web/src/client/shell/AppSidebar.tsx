// shell/AppSidebar.tsx — the primary navigation, built from the view registry: grouped (nav.ts), with
// icons, and the active view marked `aria-current="page"` (deep routes such as /alerts/:fingerprint
// keep their view active). Collapses to an icon rail on desktop and becomes a sheet below `md`. Not
// mounted under kiosk. Nav entries are plain links: the router's document click interceptor routes
// them in-app and carries the kiosk/rotate query.
//
// Keyboard: the view links are one Tab stop (roving tabindex: the last focused link, else the active
// view, else the first) and ↑/↓ (j/k), Home/End move between them through `useListNavigation`; Enter
// follows the focused link. The same contract holds on the icon rail and in the mobile sheet.
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSignals } from "@preact/signals-react/runtime";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Icon } from "@/ui/patterns/icon";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { useListNavigation } from "@/ui/hooks/use-list-navigation";
// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/ui/primitives/sidebar";

import type { AppStore } from "../store/index.js";
import type { ViewDefinition } from "../../shared/registry.js";
import { groupNavViews, type NavGroup } from "./nav.js";

export interface AppSidebarProps {
  store: AppStore;
  views: readonly ViewDefinition[];
}

export function AppSidebar(props: AppSidebarProps): ReactElement {
  useSignals();
  const { store, views } = props;
  const groups = useMemo(() => groupNavViews(views), [views]);
  const activeView = store.route.value.view;
  const path = store.route.value.path;

  // Nav links route in-app, so nothing unmounts the mobile sheet: close it on every navigation or it
  // keeps covering the view just chosen.
  // A link to the current path does not navigate, so the click closes it as well.
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [path, setOpenMobile]);
  const closeMobile = (): void => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Pulse">
              <a href="/overview" onClick={closeMobile}>
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
                >
                  P
                </span>
                <span className="text-base font-semibold">Pulse</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <ViewNav groups={groups} activeView={activeView} path={path} onNavigate={closeMobile} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

interface ViewNavProps {
  groups: readonly NavGroup[];
  activeView: string;
  path: string;
  onNavigate: () => void;
}

/**
 * The grouped view links. Its own component so the list navigation binds to the `<nav>` each time it
 * mounts: on desktop with the sidebar, and on mobile each time the sheet opens.
 */
function ViewNav({ groups, activeView, path, onNavigate }: ViewNavProps): ReactElement {
  // Roving tabindex: one Tab stop, on the last focused link, else the active view, else the first.
  // Navigating resets it to the (new) active view.
  const navRef = useRef<HTMLElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => setFocusedId(null), [path]);
  const navIds = groups.flatMap((g) => g.views.map((v) => v.id));
  const tabStop =
    focusedId !== null && navIds.includes(focusedId)
      ? focusedId
      : navIds.includes(activeView)
        ? activeView
        : (navIds[0] ?? null);
  useListNavigation({
    scope: "element",
    containerRef: navRef,
    keys: "arrows",
    getItems: () => navRef.current?.querySelectorAll<HTMLElement>("[data-sidenav-item]") ?? [],
  });

  return (
    <nav
      ref={navRef}
      aria-label="Views"
      onFocus={(event) => {
        const id = (event.target as HTMLElement).dataset.sidenavItem;
        if (id !== undefined && id !== "") setFocusedId(id);
      }}
    >
      {groups.map(({ label, views: groupViews }) => (
        <SidebarGroup key={label ?? "_ungrouped"}>
          {label === undefined ? null : <SidebarGroupLabel>{label}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {groupViews.map((view) => {
                const active = activeView === view.id;
                return (
                  <SidebarMenuItem key={view.id}>
                    <SidebarMenuButton asChild isActive={active} tooltip={view.label}>
                      <a
                        href={`/${view.id}`}
                        onClick={onNavigate}
                        data-sidenav-item={view.id}
                        tabIndex={view.id === tabStop ? 0 : -1}
                        aria-current={active ? "page" : undefined}
                      >
                        <Icon name={view.icon ?? "circle"} />
                        <span>{view.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  );
}
