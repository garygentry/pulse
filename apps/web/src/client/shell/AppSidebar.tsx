// shell/AppSidebar.tsx — the primary navigation, built from the view registry: grouped (nav.ts), with
// icons, and the active view marked `aria-current="page"` (deep routes such as /alerts/:fingerprint
// keep their view active). Collapses to an icon rail on desktop and becomes a sheet below `md`. Not
// mounted under kiosk. Nav entries are plain links: the router's document click interceptor routes
// them in-app and carries the kiosk/rotate query.
import type { ReactElement } from "react";
import { useEffect, useMemo } from "react";
import { useSignals } from "@preact/signals-react/runtime";

// ui-deep-import: entry code; through the barrel Bun.build hoists lazy-only @/ui modules into the entry
import { Icon } from "@/ui/patterns/icon";
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
import { groupNavViews } from "./nav.js";

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
        <nav aria-label="Views">
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
                            onClick={closeMobile}
                            data-sidenav-item=""
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
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
