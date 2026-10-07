// apps/web/src/client/mutations/ActionButton.tsx
import type { ReactNode, ComponentType, ReactElement } from "react";
import { useState } from "react";
import { Button, Icon } from "@/ui";
import type { IconName } from "@/ui";

/** Props for {@link ActionButton}: label, click handler and busy/loading state. */
export interface ActionButtonProps {
  readonly children: ReactNode;
  readonly onClick: () => void;
  /** In flight: aria-busy + aria-disabled and clicks are swallowed, so a double click cannot send twice (UX-03). */
  readonly busy?: boolean;
  /**
   * Loading a lazy dialog chunk: same presentation as `busy`. Neither state sets `disabled`: a trigger must keep
   * focus while its dialog loads, because disabling it drops focus to <body> and the dialog could then never
   * return focus to the trigger (REQ-A11Y-02). Re-entry is guarded by useLazyDialog.open.
   */
  readonly loading?: boolean;
  readonly variant?: "primary" | "secondary" | "danger";
  readonly icon?: IconName;
  /** Accessible name override (e.g. "Expire silence <id>"). */ readonly label?: string;
}

const VARIANT = { primary: "default", secondary: "outline", danger: "destructive" } as const;

/**
 * Library button. A busy/loading button keeps focus (aria-disabled, never `disabled`). A false capability
 * renders nothing rather than a disabled control (AUTHZ-04).
 */
export function ActionButton(p: ActionButtonProps): ReactElement {
  const busy = p.busy === true;
  const waiting = busy || p.loading === true;
  return (
    <Button type="button" size="sm" variant={VARIANT[p.variant ?? "secondary"]} loading={waiting} aria-label={p.label}
      onClick={() => { if (!busy) p.onClick(); }}>
      {!waiting && p.icon !== undefined ? <Icon name={p.icon} /> : null}
      {p.children}
    </Button>
  );
}

/**
 * Lazy dialog loader: each dialog is its own chunk. The first `open()` imports the chunk. A failed load sets `error`, and
 * the caller shows REASON_TEXT.network.
 */
export function useLazyDialog<P>(load: () => Promise<ComponentType<P>>): {
  readonly Comp: ComponentType<P> | null; readonly loading: boolean; readonly error: boolean; readonly open: () => void;
} {
  const [Comp, setComp] = useState<ComponentType<P> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const open = (): void => {
    if (Comp !== null || loading) return;
    setLoading(true);
    setError(false);
    load().then((c) => setComp(() => c), () => setError(true)).finally(() => setLoading(false));
  };
  return { Comp, loading, error, open };
}
