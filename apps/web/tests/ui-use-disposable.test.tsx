// apps/web/tests/ui-use-disposable.test.tsx — `useDisposable` (pulse-only hook in `@/ui`).
import { expect, it } from "bun:test";
import { StrictMode, useEffect } from "react";

import { useDisposable } from "@/ui";

import { describeUi, render, screen } from "./rtl.js";

interface Resource {
  readonly id: number;
  disposed: boolean;
}

function harness() {
  const made: Resource[] = [];
  function Probe() {
    const r = useDisposable(
      () => {
        const res: Resource = { id: made.length + 1, disposed: false };
        made.push(res);
        return res;
      },
      (res) => {
        res.disposed = true;
      },
    );
    return <output>{`${r.id}:${r.disposed ? "disposed" : "live"}`}</output>;
  }
  return { made, Probe };
}

describeUi("@/ui useDisposable", () => {
  it("creates once per mount and disposes on unmount", async () => {
    const { made, Probe } = harness();
    const { unmount, rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(made).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("1:live");
    unmount();
    await Promise.resolve();
    expect(made[0]!.disposed).toBe(true);
  });

  it("under StrictMode, the remount keeps the first resource live (mount-once effects stay bound to it)", async () => {
    const { made, Probe } = harness();
    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await Promise.resolve();
    // StrictMode renders twice, so `create` may run per render; the committed one is never disposed.
    const shown = screen.getByRole("status").textContent!;
    expect(shown).toMatch(/:live$/);
    const current = made.find((r) => `${r.id}:live` === shown)!;
    expect(current.disposed).toBe(false);
    unmount();
    await Promise.resolve();
    expect(current.disposed).toBe(true);
  });

  it("under StrictMode, a mount-once effect and the render see the same live resource", async () => {
    const { made } = harness();
    let seenByEffect: Resource | null = null;
    function Probe() {
      const r = useDisposable(
        () => {
          const res: Resource = { id: made.length + 1, disposed: false };
          made.push(res);
          return res;
        },
        (res) => {
          res.disposed = true;
        },
      );
      useEffect(() => {
        seenByEffect = r;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <output>{String(r.id)}</output>;
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await Promise.resolve();
    expect(made).toHaveLength(1);
    expect(String(seenByEffect!.id)).toBe(screen.getByRole("status").textContent!);
    expect(seenByEffect!.disposed).toBe(false);
  });
});
