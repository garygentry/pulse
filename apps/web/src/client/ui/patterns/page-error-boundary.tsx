import { Component, Fragment, type ReactNode } from "react";
import { pageHeadingId } from "@/ui/lib/dom-id";
import { ErrorState } from "@/ui/patterns/error-state";
import { PageHeader } from "@/ui/patterns/page-header";

export interface PageErrorBoundaryProps {
  /** The page content to isolate. */
  children: ReactNode;
  /** When this value changes (e.g. the route path), a prior failure is cleared. */
  resetKey?: unknown;
  /** Fallback page heading. */
  title?: string;
  /** Fallback message. Fixed text: the caught exception is never shown. */
  message?: string;
  /** Retry button text. */
  retryLabel?: string;
  /** Fallback heading level (see `PageHeader.level`). */
  level?: 1 | 2 | 3;
  /** Diagnostic hook, called from `componentDidCatch`. */
  onError?: (error: unknown) => void;
  /**
   * Pulse: the page root's `data-slot` (e.g. `"alerts-page"`). When set, the fallback renders inside
   * a `data-slot={pageSlot} data-state="error"` root, so a failed page keeps the view's page contract
   * (its `…-page` root and one `h1`).
   */
  pageSlot?: string;
}

interface PageErrorBoundaryState {
  failed: boolean;
  nonce: number;
  lastResetKey: unknown;
}

/**
 * Page-level render isolation. A throw in the page content renders a page
 * header + `ErrorState` with Retry instead of blanking the app; the shell
 * survives. Retry remounts the content (a nonce key); a changed `resetKey`
 * clears the failure. Exception text is logged, never rendered.
 *
 * The content is keyed by a Fragment, not wrapped in an element, so it adds no
 * DOM of its own.
 */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { failed: false, nonce: 0, lastResetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<PageErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: PageErrorBoundaryProps,
    state: PageErrorBoundaryState,
  ): Partial<PageErrorBoundaryState> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { failed: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    console.error("[pulse] a page failed to render", error);
    this.props.onError?.(error);
  }

  private readonly retry = (): void => {
    this.setState((prior) => ({ failed: false, nonce: prior.nonce + 1 }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      const {
        title = "This page could not be displayed",
        message = "Something went wrong rendering this view. Other pages may still work.",
        retryLabel = "Retry",
        level = 1,
      } = this.props;
      const headingId = pageHeadingId(title);
      const fallback = (
        <section data-slot="page-error-boundary" aria-labelledby={headingId} className="flex flex-col gap-6">
          <PageHeader id={headingId} title={title} level={level} />
          <ErrorState title={message} onRetry={this.retry} retryLabel={retryLabel} />
        </section>
      );
      const { pageSlot } = this.props;
      return pageSlot === undefined ? (
        fallback
      ) : (
        <div data-slot={pageSlot} data-state="error" className="flex min-w-0 flex-col">
          {fallback}
        </div>
      );
    }
    return <Fragment key={this.state.nonce}>{this.props.children}</Fragment>;
  }
}
