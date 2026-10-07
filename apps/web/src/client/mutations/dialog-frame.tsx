// apps/web/src/client/mutations/dialog-frame.tsx — the shared modal frame of the lazy mutation dialogs.
// Imported statically only by the dialog modules, so it ships inside their lazy chunks.
import type { ReactElement, ReactNode } from "react";
import { useRef } from "react";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/ui";

/** Props for {@link MutationDialogFrame}. */
export interface MutationDialogFrameProps {
  readonly open: boolean;
  /** Called on Esc / outside click (when dismissable) and by the dialog's own Cancel/Close actions. */
  readonly onClose: () => void;
  /** Heading text; it is the dialog's accessible name. */
  readonly title: string;
  /** When false (a submit is in flight), Esc and outside clicks do not close. Default true. */
  readonly dismissable?: boolean;
  /** `alertdialog` for a destructive confirmation. Default `dialog`. */
  readonly role?: "dialog" | "alertdialog";
  /** Accessible description (rendered visually hidden). */
  readonly description?: string;
  /** Footer actions: plain ActionButtons, so an async submit decides when the dialog closes. */
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}

const CONTENT = "max-h-[calc(100dvh-2rem)] overflow-y-auto";

/** First tabbable element inside `root` (an alertdialog's initial focus). */
function firstTabbable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    ["input:not([type=hidden]):not([disabled])", "textarea:not([disabled])", "select:not([disabled])", "button:not([disabled])", "[href]", "[tabindex]"]
      .map((sel) => `${sel}:not([tabindex='-1']):not([aria-hidden='true'])`).join(", "));
}

/**
 * A Radix modal for a mutation dialog. Closing returns focus to whatever had it when the dialog opened
 * (the trigger keeps focus while its lazy chunk loads); Radix only does that for a `DialogTrigger`. This
 * also works when the parent unmounts the dialog on close: Radix still runs the close-autofocus handler.
 */
export function MutationDialogFrame(p: MutationDialogFrameProps): ReactElement {
  const dismissable = p.dismissable !== false;
  const returnFocus = useRef<HTMLElement | null>(null);

  const onOpenChange = (open: boolean): void => {
    if (!open && dismissable) p.onClose();
  };
  const recordReturnFocus = (event: Event): void => {
    const active = (event.currentTarget as HTMLElement | null)?.ownerDocument.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
  };
  const onCloseAutoFocus = (event: Event): void => {
    event.preventDefault();
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) el.focus();
  };
  const onEscapeKeyDown = (event: KeyboardEvent): void => {
    if (!dismissable) event.preventDefault();
  };
  const onOutside = (event: Event): void => {
    if (!dismissable) event.preventDefault();
  };
  const describedBy = p.description === undefined ? { "aria-describedby": undefined } : {};

  if (p.role === "alertdialog") {
    return (
      <AlertDialog open={p.open} onOpenChange={onOpenChange}>
        <AlertDialogContent className={CONTENT} {...describedBy}
          onOpenAutoFocus={(e) => {
            recordReturnFocus(e);
            e.preventDefault();
            const content = e.currentTarget as HTMLElement | null;
            (content !== null ? firstTabbable(content) ?? content : null)?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={onEscapeKeyDown}>
          <AlertDialogHeader>
            <AlertDialogTitle>{p.title}</AlertDialogTitle>
            {p.description !== undefined ? <AlertDialogDescription className="sr-only">{p.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          {p.children}
          <AlertDialogFooter>{p.actions}</AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={p.open} onOpenChange={onOpenChange}>
      <DialogContent className={CONTENT} showCloseButton={false} {...describedBy}
        onOpenAutoFocus={recordReturnFocus} onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={onEscapeKeyDown}
        onPointerDownOutside={onOutside} onInteractOutside={onOutside}>
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          {p.description !== undefined ? <DialogDescription className="sr-only">{p.description}</DialogDescription> : null}
        </DialogHeader>
        {p.children}
        <DialogFooter>{p.actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
