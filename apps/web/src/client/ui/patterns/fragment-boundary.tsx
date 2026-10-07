import { Component, type ReactNode } from "react";
import { Callout } from "@/ui/patterns/callout";

export interface FragmentBoundaryProps {
  /** The isolated fragment (a slot fragment, header summary, evidence field …). */
  children: ReactNode;
  /** Fixed, caller-chosen name of the fragment ("Alerts summary"); the fallback reads "{label} unavailable". */
  label: string;
  /** Keeps the fragment's navigation working in the fallback (renders the text as a link). */
  href?: string;
  /** Replaces the default compact callout entirely. */
  fallback?: ReactNode;
  /** When this value changes, a prior failure is cleared. */
  resetKey?: unknown;
  /** Diagnostic hook, called from `componentDidCatch`. */
  onError?: (error: unknown) => void;
}

interface FragmentBoundaryState {
  failed: boolean;
  lastResetKey: unknown;
}

/**
 * Inline render isolation for a fragment inside a host page. A throw renders a
 * compact danger `Callout` (`role="alert"`) with fixed text — never the caught
 * exception — so the host page and sibling fragments keep working. On success it
 * renders the children with no wrapper element.
 */
export class FragmentBoundary extends Component<FragmentBoundaryProps, FragmentBoundaryState> {
  state: FragmentBoundaryState = { failed: false, lastResetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<FragmentBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: FragmentBoundaryProps,
    state: FragmentBoundaryState,
  ): Partial<FragmentBoundaryState> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { failed: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    console.error(`[pulse] fragment "${this.props.label}" failed to render`, error);
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    const text = `${this.props.label} unavailable`;
    return (
      <Callout data-slot="fragment-boundary" tone="danger" icon="cloud-off" compact>
        {this.props.href !== undefined ? (
          <a href={this.props.href} className="font-medium underline underline-offset-4">
            {text}
          </a>
        ) : (
          text
        )}
      </Callout>
    );
  }
}
