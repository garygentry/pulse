// apps/web/tests/dom-cleanup.test.tsx — `describeDom` unmounts what its tests left mounted.
//
// Test files share one process and its module state, so a tree a file forgot to unmount used to
// outlive the file. A leaked `App` kept its command palette's Ctrl+K handler registered, and a later
// file's Ctrl+K opened it too: an extra dialog, then two focus traps passing focus back and forth
// until CI's timeout (2026-11-18 onward, whenever `app.test.ts` ran before `shell-shell.test.tsx`).

import { expect, test } from "bun:test";
import { createElement, useEffect } from "react";

import { describeDom, renderWithStore } from "./dom.js";

const unmounted = { mount: false, renderWithStore: false };

function Probe({ name }: { name: keyof typeof unmounted }) {
  useEffect(() => () => {
    unmounted[name] = true;
  }, [name]);
  return null;
}

describeDom("a file that forgets to unmount", (dom) => {
  test("mounts two trees and leaves them mounted", async () => {
    await dom.mount(createElement(Probe, { name: "mount" }));
    await renderWithStore(createElement(Probe, { name: "renderWithStore" }));
    expect(unmounted).toEqual({ mount: false, renderWithStore: false });
  });
});

test("describeDom unmounted both trees when the file's block ended", () => {
  expect(unmounted).toEqual({ mount: true, renderWithStore: true });
});
