import type { ComponentProps, ReactNode } from "react";
import type { IconName } from "@/ui/lib/icons";
import type { Tone } from "@/ui/lib/status";
import { cn } from "@/ui/lib/utils";
import { Icon } from "@/ui/patterns/icon";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";

// Literal class names so Tailwind generates every tone utility.
const TONE_SURFACE: Record<Tone, string> = {
  ok: "border-status-ok-border bg-status-ok-bg [&>svg]:text-status-ok-fg *:data-[slot=alert-title]:text-status-ok-fg",
  warn: "border-status-warn-border bg-status-warn-bg [&>svg]:text-status-warn-fg *:data-[slot=alert-title]:text-status-warn-fg",
  danger:
    "border-status-danger-border bg-status-danger-bg [&>svg]:text-status-danger-fg *:data-[slot=alert-title]:text-status-danger-fg",
  info: "border-status-info-border bg-status-info-bg [&>svg]:text-status-info-fg *:data-[slot=alert-title]:text-status-info-fg",
  pending:
    "border-status-pending-border bg-status-pending-bg [&>svg]:text-status-pending-fg *:data-[slot=alert-title]:text-status-pending-fg",
  neutral:
    "border-status-neutral-border bg-status-neutral-bg [&>svg]:text-status-neutral-fg *:data-[slot=alert-title]:text-status-neutral-fg",
};

const TONE_ICON: Record<Tone, IconName> = {
  ok: "circle-check",
  warn: "triangle-alert",
  danger: "octagon-alert",
  info: "info",
  pending: "hourglass",
  neutral: "info",
};

export type CalloutRole = "alert" | "status" | "note";

/**
 * The ARIA role a tone implies: `danger` interrupts (`alert`); `warn`, `ok` and
 * `pending` report a state politely (`status`); `info` and `neutral` are
 * static supplementary content (`note`).
 */
export function calloutRole(tone: Tone): CalloutRole {
  if (tone === "danger") return "alert";
  if (tone === "info" || tone === "neutral") return "note";
  return "status";
}

export interface CalloutProps extends Omit<ComponentProps<"div">, "title" | "role"> {
  tone?: Tone;
  title?: ReactNode;
  /** Body text. */
  children?: ReactNode;
  /** Overrides the tone's default icon. */
  icon?: IconName;
  /** A follow-up affordance (link or button) under the body. */
  action?: ReactNode;
  /**
   * Shows a dismiss button. Dismissal state is caller-owned: the callout never
   * hides itself or persists anything — the caller stops rendering it.
   */
  onDismiss?: () => void;
  /** Accessible name of the dismiss button. */
  dismissLabel?: string;
  /** Overrides the tone-derived role (see `calloutRole`). */
  role?: CalloutRole;
  /** Tighter padding for inline / fragment use. */
  compact?: boolean;
}

/**
 * A toned notice on shadcn's `Alert`: icon + text (never colour alone), a role
 * derived from the tone, an optional action and a caller-owned dismiss.
 */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  action,
  onDismiss,
  dismissLabel = "Dismiss",
  role,
  compact = false,
  className,
  ...props
}: CalloutProps) {
  return (
    <Alert
      data-slot="callout"
      data-tone={tone}
      role={role ?? calloutRole(tone)}
      className={cn(
        "text-foreground",
        TONE_SURFACE[tone],
        compact && "px-3 py-2",
        onDismiss && "pe-11",
        className,
      )}
      {...props}
    >
      <Icon name={icon ?? TONE_ICON[tone]} />
      {title != null && <AlertTitle className="line-clamp-none">{title}</AlertTitle>}
      {children != null && <AlertDescription className="text-foreground">{children}</AlertDescription>}
      {action != null && <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">{action}</div>}
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute end-1.5 top-1.5 text-muted-foreground hover:text-foreground"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <Icon name="x" />
        </Button>
      )}
    </Alert>
  );
}
