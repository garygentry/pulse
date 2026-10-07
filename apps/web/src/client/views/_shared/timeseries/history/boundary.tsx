// Per-region render-fault containment shared by /engine and /timeline (02 §9, REQ-OBS-01).
import { Component } from "react";
import type { ReactNode } from "react";
import { Callout } from "@/ui";

/** Props for RegionErrorBoundary. */
export interface RegionErrorBoundaryProps {
  /** Plain-text region name, used in the console log and the fault description. */
  readonly label: string;
  /** When this value changes after a fault, the boundary clears its error and re-renders children
   *  (e.g. pass the history key or range so a new question gets a fresh attempt). */
  readonly resetKey?: string | number | null;
  /** The region content. */
  readonly children?: ReactNode;
}

interface RegionBoundaryState {
  /** The caught render/lifecycle error, or null while healthy. */
  readonly error: Error | null;
}

/**
 * Contains a render fault to one region or chart (REQ-OBS-01). Wraps every region of both views
 * and every chart. Never re-throws. Emits no telemetry (REQ-OBS-02); the console line is the only
 * side effect.
 */
export class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionBoundaryState> {
  override state: RegionBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RegionBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`[history-region] render fault in ${this.props.label}`, error);
  }

  override componentDidUpdate(prev: RegionErrorBoundaryProps): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div data-slot="region-fault">
          <Callout tone="danger" role="status" icon="circle-alert" compact title="This panel failed to render">
            {`${this.props.label} could not be displayed. Reload the page to try again; other panels are unaffected.`}
          </Callout>
        </div>
      );
    }
    return this.props.children;
  }
}
