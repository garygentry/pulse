import { useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Icon,
  Input,
  Kbd,
  KbdGroup,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  ScrollBar,
  Separator,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

const BUTTON_VARIANTS = ["default", "secondary", "outline", "ghost", "link", "destructive"] as const;
const BADGE_VARIANTS = ["default", "secondary", "outline", "destructive"] as const;

/** Button `loading`: focus stays on the button while the work is in flight. */
function LoadingButton() {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      loading={loading}
      onClick={() => {
        setLoading(true);
        window.setTimeout(() => setLoading(false), 2_000);
      }}
    >
      {loading ? "Silencing…" : "Silence (2 s)"}
    </Button>
  );
}

function ControlledTextarea() {
  const [value, setValue] = useState("Planned maintenance on nas-01.");
  return (
    <div className="flex w-72 flex-col gap-1.5">
      <Label htmlFor="wb-textarea">Silence comment</Label>
      <Textarea id="wb-textarea" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
      <span className="text-xs text-muted-foreground tabular-nums">{value.length} characters</span>
    </div>
  );
}

function Primitives() {
  return (
    <>
      <Specimen label="Button variants">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </Specimen>
      <Specimen label="Button sizes and states">
        <Button size="xs">xs</Button>
        <Button size="sm">sm</Button>
        <Button>default</Button>
        <Button size="lg">lg</Button>
        <Button size="icon" aria-label="Copy link">
          <Icon name="link" />
        </Button>
        <Button>
          <Icon name="play" />
          With icon
        </Button>
        <Button disabled>disabled</Button>
      </Specimen>
      <Specimen label="Button loading: spinner, aria-busy, clicks ignored, focus kept (no disabled attribute)">
        <Button loading>Applying…</Button>
        <Button loading variant="outline">
          Saving…
        </Button>
        <LoadingButton />
      </Specimen>
      <Specimen label="Badge variants">
        {BADGE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </Specimen>
      <Specimen label="Form controls: Input, Label, Checkbox">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-input">Host name</Label>
          <Input id="wb-input" placeholder="nas-01" className="w-48" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-invalid">Invalid</Label>
          <Input id="wb-invalid" defaultValue="bad value" aria-invalid="true" className="w-48" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-disabled">Disabled</Label>
          <Input id="wb-disabled" defaultValue="read only" disabled className="w-48" />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="wb-check" defaultChecked />
          <Label htmlFor="wb-check">Include suppressed</Label>
        </div>
      </Specimen>
      <Specimen label="Textarea: controlled, disabled">
        <ControlledTextarea />
        <div className="flex w-72 flex-col gap-1.5">
          <Label htmlFor="wb-textarea-disabled">Disabled</Label>
          <Textarea id="wb-textarea-disabled" defaultValue="Read only" disabled />
        </div>
      </Specimen>
      <Specimen label="RadioGroup: arrow keys move and select; one disabled option">
        <RadioGroup defaultValue="2h" name="wb-duration" aria-label="Silence duration">
          {[
            { value: "1h", label: "1 hour" },
            { value: "2h", label: "2 hours" },
            { value: "1d", label: "1 day" },
            { value: "forever", label: "Until resolved", disabled: true },
          ].map((option) => (
            <div key={option.value} className="flex items-center gap-2">
              <RadioGroupItem
                id={`wb-radio-${option.value}`}
                value={option.value}
                disabled={option.disabled === true}
              />
              <Label htmlFor={`wb-radio-${option.value}`}>{option.label}</Label>
            </div>
          ))}
        </RadioGroup>
      </Specimen>
      <Specimen label="Kbd and KbdGroup">
        <Kbd>/</Kbd>
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <span className="text-sm">
          Press <Kbd>j</Kbd> / <Kbd>k</Kbd> to move between rows
        </span>
      </Specimen>
      <Specimen label="Toggle and ToggleGroup">
        <Toggle aria-label="Show suppressed" defaultPressed>
          <Icon name="eye-off" />
          Suppressed
        </Toggle>
        <Toggle variant="outline" aria-label="Wrap lines">
          Wrap
        </Toggle>
        <ToggleGroup type="single" variant="outline" defaultValue="24h" aria-label="Range">
          {["1h", "6h", "24h", "7d"].map((range) => (
            <ToggleGroupItem key={range} value={range} className="px-3">
              {range}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Specimen>
      <Specimen label="Alert">
        <Alert className="max-w-md">
          <Icon name="info" />
          <AlertTitle>Snapshot is 2 minutes old</AlertTitle>
          <AlertDescription>The live stream reconnects automatically.</AlertDescription>
        </Alert>
        <Alert variant="destructive" className="max-w-md">
          <Icon name="circle-x" />
          <AlertTitle>Estate failed to load</AlertTitle>
          <AlertDescription>estate.yaml is not valid YAML.</AlertDescription>
        </Alert>
      </Specimen>
      <Specimen label="Card (header, action, content, footer), tabs, separator">
        <Card className="w-80">
          <CardHeader>
            <CardTitle>nas-01</CardTitle>
            <CardDescription>Storage · 12 services</CardDescription>
            <CardAction>
              <Button size="icon" variant="ghost" aria-label="Refresh nas-01">
                <Icon name="refresh-cw" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="alerts">Alerts</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="text-sm">
                Every service is up.
              </TabsContent>
              <TabsContent value="alerts" className="text-sm">
                No alerts firing.
              </TabsContent>
            </Tabs>
            <Separator className="my-3" />
            <p className="text-sm text-muted-foreground">Last scrape 6s ago</p>
          </CardContent>
          <CardFooter>
            <Button size="sm" variant="outline">
              Open host
            </Button>
          </CardFooter>
        </Card>
      </Specimen>
      <Specimen label="Breadcrumb (with ellipsis)">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#primitives">Estate</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#primitives">nas-01</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>node-exporter</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Specimen>
      <Specimen label="Collapsible">
        <Collapsible className="flex w-72 flex-col gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="justify-between">
              Labels
              <Icon name="chevron-down" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-2 font-mono text-xs">
            job=node · instance=nas-01:9100 · site=home
          </CollapsibleContent>
        </Collapsible>
      </Specimen>
      <Specimen label="ScrollArea (vertical and horizontal bars)">
        <ScrollArea className="h-32 w-64 rounded-md border border-border">
          <ul className="w-96 p-2 text-sm">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i} className="py-0.5 font-mono">
                {`probe-${String(i + 1).padStart(2, "0")} · http://service-${i + 1}.lan/healthz`}
              </li>
            ))}
          </ul>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </Specimen>
      <Specimen label="Skeleton">
        <div className="flex w-72 flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      </Specimen>
      <Specimen label="Table (caption, footer)">
        <Table>
          <TableCaption>Hosts in the estate</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Services</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>nas-01</TableCell>
              <TableCell>storage</TableCell>
              <TableCell className="text-right tabular-nums">12</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>edge-01</TableCell>
              <TableCell>router</TableCell>
              <TableCell className="text-right tabular-nums">3</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="text-right tabular-nums">15</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Specimen>
      <Specimen label="Sidebar (static, collapsible none)">
        <SidebarProvider className="min-h-0 w-auto">
          <Sidebar collapsible="none" className="h-auto rounded-md border border-border">
            <SidebarHeader>
              <SidebarInput aria-label="Filter views" placeholder="Filter…" />
            </SidebarHeader>
            <SidebarSeparator />
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Views</SidebarGroupLabel>
                <SidebarGroupAction aria-label="Add view">
                  <Icon name="circle-plus" />
                </SidebarGroupAction>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>
                        <Icon name="activity" />
                        Overview
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton>
                        <Icon name="triangle-alert" />
                        Alerts
                      </SidebarMenuButton>
                      <SidebarMenuBadge>4</SidebarMenuBadge>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton>
                        <Icon name="server" />
                        Estate
                      </SidebarMenuButton>
                      <SidebarMenuAction aria-label="Estate options">
                        <Icon name="menu" />
                      </SidebarMenuAction>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton href="#primitives">Hosts</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton href="#primitives">Services</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <span className="px-2 text-xs text-muted-foreground">pulse</span>
            </SidebarFooter>
          </Sidebar>
        </SidebarProvider>
      </Specimen>
    </>
  );
}

export const primitives: WorkbenchSectionDef = {
  id: "primitives",
  title: "Primitives",
  Demo: Primitives,
};
