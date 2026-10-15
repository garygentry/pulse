import { Component, Fragment, type ReactNode } from "react";
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
  /** Failed, and a reset key change asked for another try: the fragment renders beside the fallback. */
  retrying: boolean;
  /** Retries so far, keying a fresh retry boundary each time. */
  attempt: number;
  lastResetKey: unknown;
}

/**
 * Inline render isolation for a fragment inside a host page. A throw renders a
 * compact danger `Callout` (`role="alert"`) with fixed text — never the caught
 * exception — so the host page and sibling fragments keep working. On success it
 * renders the children with no wrapper element.
 *
 * A `resetKey` change retries a failed fragment without re-announcing it: the fragment is
 * tried beside the still-mounted fallback, inside its own nested boundary, so a retry that
 * fails again leaves this boundary's fallback node in place (no new alert), and one that
 * succeeds drops the fallback before paint. A failure is logged and reported once per
 * episode, not once per retry.
 */
export class FragmentBoundary extends Component<FragmentBoundaryProps, FragmentBoundaryState> {
  state: FragmentBoundaryState = { failed: false, retrying: false, attempt: 0, lastResetKey: this.props.resetKey };

  /** Whether the current failure episode has been logged. */
  private reported = false;

  static getDerivedStateFromError(): Partial<FragmentBoundaryState> {
    return { failed: true, retrying: false };
  }

  static getDerivedStateFromProps(
    props: FragmentBoundaryProps,
    state: FragmentBoundaryState,
  ): Partial<FragmentBoundaryState> | null {
    if (props.resetKey !== state.lastResetKey) {
      return state.failed
        ? { lastResetKey: props.resetKey, retrying: true, attempt: state.attempt + 1 }
        : { lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    this.report(error);
  }

  /** Log and report a failure, once per episode. */
  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    console.error(`[pulse] fragment "${this.props.label}" failed to render`, error);
    this.props.onError?.(error);
  }

  /** The retry threw again: the episode goes on, with the same fallback. */
  private readonly retryFailed = (error: unknown): void => {
    this.report(error);
    this.setState({ retrying: false });
  };

  /** The retried fragment rendered and committed: the episode is over. */
  private readonly recovered = (): void => {
    this.reported = false;
    this.setState({ failed: false, retrying: false });
  };

  private renderFallback(): ReactNode {
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

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // The fallback keeps its position (and DOM node) while a retry renders beside it.
    return [
      <Fragment key="fallback">{this.renderFallback()}</Fragment>,
      this.state.retrying ? (
        <RetryBoundary key={`retry-${this.state.attempt}`} onFail={this.retryFailed} onCommit={this.recovered}>
          {this.props.children}
        </RetryBoundary>
      ) : null,
    ];
  }
}

interface RetryProps {
  children: ReactNode;
  /** The retried fragment committed without throwing. */
  onCommit: () => void;
  /** The retried fragment threw. */
  onFail: (error: unknown) => void;
}

/**
 * One retry of a failed fragment, isolated in its own boundary so a throw is caught here and
 * never makes the outer boundary re-render (and replace) its fallback.
 */
class RetryBoundary extends Component<RetryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onFail(error);
  }

  render(): ReactNode {
    if (this.state.failed) return null;
    return <RetryCommit onCommit={this.props.onCommit}>{this.props.children}</RetryCommit>;
  }
}

/** Renders a retried fragment; once it commits, reports it before paint (layout phase). */
class RetryCommit extends Component<{ children: ReactNode; onCommit: () => void }> {
  componentDidMount(): void {
    this.props.onCommit();
  }

  render(): ReactNode {
    return this.props.children;
  }
}
