// tests/timeline-live-control.test.tsx — F37: the pause/resume toggle is ONE button, so toggling keeps
// keyboard focus on it (two swapped buttons dropped focus to <body>).
import { expect, test } from "bun:test";
import { useState } from "react";

import { LiveControl } from "../src/client/views/timeline/controls.js";
import { createEstateClock } from "../src/client/format.js";
import { describeUi, render, screen, userEvent } from "./rtl.js";

const clock = createEstateClock({ name: "e", timezone: "UTC", tzFallback: false });

function Harness(): React.ReactElement {
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  return <LiveControl pausedAt={pausedAt} clock={clock} onPause={() => setPausedAt(1_800_000_000)} onResume={() => setPausedAt(null)} />;
}

describeUi("LiveControl (F37)", () => {
  test("pausing and resuming keep focus on the same button, whose label states the state", async () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Pause" });
    await userEvent.click(button);
    const paused = screen.getByRole("button", { name: /Paused — resume live/ });
    expect(paused).toBe(button);
    expect(document.activeElement).toBe(button);
    await userEvent.click(paused);
    expect(screen.getByRole("button", { name: "Pause" })).toBe(button);
  });
});
