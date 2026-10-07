import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

function MenuDemo() {
  const [showSuppressed, setShowSuppressed] = useState(true);
  const [density, setDensity] = useState("comfortable");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          View options
          <Icon name="chevron-down" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Alerts</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem>
            Copy link
            <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>Export (unavailable)</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showSuppressed}
          onCheckedChange={(checked) => setShowSuppressed(checked === true)}
        >
          Show suppressed
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
          <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Group by</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Severity</DropdownMenuItem>
            <DropdownMenuItem>Host</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Expire silence</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommandDialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open CommandDialog
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Views">
            <CommandItem onSelect={() => setOpen(false)}>Overview</CommandItem>
            <CommandItem onSelect={() => setOpen(false)}>Alerts</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

function Overlays() {
  return (
    <>
      <Specimen label="Dialog (trigger, close, footer)">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Edit silence</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit silence</DialogTitle>
              <DialogDescription>Matchers stay as they are; only the comment changes.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wb-dialog-comment">Comment</Label>
              <Input id="wb-dialog-comment" defaultValue="Planned maintenance" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Save</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Specimen>
      <Specimen label="AlertDialog: default and small with media">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Expire silence</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Expire this silence?</AlertDialogTitle>
              <AlertDialogDescription>
                Alerts it covers start notifying again immediately.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep silence</AlertDialogCancel>
              <AlertDialogAction>Expire</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">Small confirm</Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Icon name="bell" />
              </AlertDialogMedia>
              <AlertDialogTitle>Acknowledge alert?</AlertDialogTitle>
              <AlertDialogDescription>Others see it as acknowledged.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Acknowledge</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Specimen>
      <Specimen label="Sheet: right and bottom">
        {(["right", "bottom"] as const).map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild>
              <Button variant="outline">Open {side} sheet</Button>
            </SheetTrigger>
            <SheetContent side={side}>
              <SheetHeader>
                <SheetTitle>Alert detail</SheetTitle>
                <SheetDescription>DiskAlmostFull on nas-01, firing for 12 minutes.</SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <SheetClose asChild>
                  <Button variant="outline">Close</Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        ))}
      </Specimen>
      <Specimen label="DropdownMenu: items, shortcut, checkbox, radio, submenu, destructive">
        <MenuDemo />
      </Specimen>
      <Specimen label="Popover (header, title, description)">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Matchers</Button>
          </PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Silence matchers</PopoverTitle>
              <PopoverDescription>alertname=DiskAlmostFull, instance=nas-01</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      </Specimen>
      <Specimen label="Tooltip (hover or focus)">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Refresh">
              <Icon name="refresh-cw" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh now</TooltipContent>
        </Tooltip>
      </Specimen>
      <Specimen label="Select: groups, label, separator, disabled item">
        <Select defaultValue="critical">
          <SelectTrigger className="w-48" aria-label="Minimum severity">
            <SelectValue placeholder="Minimum severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Severity</SelectLabel>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectItem value="none" disabled>
              None (unavailable)
            </SelectItem>
          </SelectContent>
        </Select>
        <Select disabled>
          <SelectTrigger className="w-48" aria-label="Disabled select">
            <SelectValue placeholder="Disabled" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="x">x</SelectItem>
          </SelectContent>
        </Select>
      </Specimen>
      <Specimen label="Command (inline) and CommandDialog">
        <Command className="w-72 rounded-lg border border-border">
          <CommandInput placeholder="Filter actions…" />
          <CommandList>
            <CommandEmpty>No actions match.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem>
                <Icon name="bell" />
                Silence alert
                <CommandShortcut>S</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <Icon name="circle-check" />
                Acknowledge
                <CommandShortcut>A</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Navigate">
              <CommandItem>Overview</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        <CommandDialogDemo />
      </Specimen>
    </>
  );
}

export const overlays: WorkbenchSectionDef = {
  id: "overlays",
  title: "Overlays, menus & pickers",
  Demo: Overlays,
};
