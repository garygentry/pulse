// apps/web/tests/ui-content.test.tsx — ported from deck's `ui-content` suite (vendored `@/ui`).
import { afterEach, expect, it, mock, spyOn, describe } from "bun:test";
import type { ReactNode } from "react";

import {
  CodeBlock,
  ComparisonGrid,
  Disclosure,
  KeyValue,
  KeyValueList,
  LogOutput,
  NotDeclared,
  NotObserved,
  NotSupplied,
  Prose,
  ShowMore,
  StatGrid,
  StatTile,
  Meter,
} from "@/ui";

import { act, describeUi, fireEvent, render, screen, userEvent, within } from "./rtl.js";

/** Deck's workbench `Specimen` frame (`features/_ui/kit.tsx`): a captioned figure. */
function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure>
      <figcaption>{label}</figcaption>
      <div>{children}</div>
    </figure>
  );
}

const LONG_LOG = Array.from({ length: 40 }, (_, i) => `[${i + 1}] synced volume data-${i + 1}`).join("\n");
const FINDINGS = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}`);

/**
 * Stand-in for deck's workbench §D section (`features/_ui/sections/content.tsx`), which pulse does
 * not vendor: the same specimen inventory (one figure per specimen, five LogOutputs), shorter data.
 */
function ContentDemo() {
  return (
    <>
      <Specimen label="KeyValueList grid">
        <KeyValueList items={[{ label: "Hostname", value: "nas-01" }, { label: "Owner", value: <NotDeclared /> }]} />
      </Specimen>
      <Specimen label="KeyValueList stacked">
        <KeyValueList layout="stacked" items={[{ label: "Address", value: "10.0.4.12", hint: "From DHCP lease" }]} />
      </Specimen>
      <Specimen label="KeyValueList inline">
        <KeyValueList layout="inline">
          <KeyValue label="Actor" value="gary" />
          <KeyValue label="Exit code" value="0" />
        </KeyValueList>
      </Specimen>
      <Specimen label="Empty-value renderers">
        <KeyValueList
          items={[
            { label: "Declared owner", value: <NotDeclared /> },
            { label: "Observed version", value: <NotObserved /> },
            { label: "Optional parameter", value: <NotSupplied /> },
          ]}
        />
      </Specimen>
      <Specimen label="ComparisonGrid">
        <ComparisonGrid rows={[{ label: "Replicas", declared: "2", observed: "1", marker: <span>Drifted</span> }]} />
      </Specimen>
      <Specimen label="StatTile">
        <StatGrid>
          <StatTile tone="warn" label="Active drift" value="12" subLabel="3 new" href="#content" />
          <StatTile label="Hosts" value="42" />
        </StatGrid>
      </Specimen>
      <Specimen label="Meter">
        <Meter label="Opus" value={100} tone="danger" icon="octagon-alert" meta="Limit reached" />
        <Meter label="Disk" value={130} max={200} valueText="130 / 200 GB" />
      </Specimen>
      <Specimen label="CodeBlock highlighted">
        <CodeBlock caption="estate.yaml" language="yaml" code="replicas: 2" highlightedHtml="<span>replicas:</span> 2" />
      </Specimen>
      <Specimen label="CodeBlock plain">
        <CodeBlock caption="Wraps" code="docker run --rm deck-probe" wrap copy={false} />
        <CodeBlock code={LONG_LOG} copy={false} maxHeight="8rem" />
      </Specimen>
      <Specimen label="LogOutput streaming, no output yet">
        <LogOutput label="Run output" streaming />
      </Specimen>
      <Specimen label="LogOutput streaming">
        <LogOutput label="Run output" streaming stdout={"layer 1/3 done\nlayer 2/3 done"} />
      </Specimen>
      <Specimen label="LogOutput finished with stderr">
        <LogOutput label="Run output" stdout="Starting web … done" stderr="warning: slow healthcheck" />
      </Specimen>
      <Specimen label="LogOutput no output; long output capped">
        <LogOutput label="Run output" />
        <LogOutput label="Sync log" stdout={LONG_LOG} maxHeight="8rem" />
      </Specimen>
      <Specimen label="Prose">
        <Prose sanitizedHtml="<h2>Restoring a backup</h2><p>Stop the service first.</p>" />
      </Specimen>
      <Specimen label="Disclosure">
        <Disclosure label="Waivers" count={3}>
          <p>3 findings are waived.</p>
        </Disclosure>
        <Disclosure label="Snapshot details" defaultOpen>
          <p>Probe: ssh</p>
        </Disclosure>
      </Specimen>
      <Specimen label="ShowMore">
        <ShowMore label="Findings" items={FINDINGS} initial={3} step={3} noun="findings" renderItem={(f) => f} />
        <ShowMore label="Short list" items={FINDINGS.slice(0, 2)} renderItem={(f) => f} />
      </Specimen>
    </>
  );
}

describeUi("@/ui content & data display", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("KeyValueList", () => {
    it("renders items as term/definition pairs, with hints inside the definition", () => {
      render(
        <KeyValueList
          items={[
            { label: "Hostname", value: "nas-01" },
            { label: "Address", value: "10.0.4.12", hint: "From DHCP lease" },
          ]}
        />,
      );
      const terms = screen.getAllByRole("term");
      const definitions = screen.getAllByRole("definition");
      expect(terms.map((t) => t.textContent)).toEqual(["Hostname", "Address"]);
      expect(definitions[0]).toHaveTextContent("nas-01");
      expect(definitions[1]).toHaveTextContent("10.0.4.12From DHCP lease");
      expect(terms[0]!.closest("dl")).toHaveAttribute("data-slot", "key-value-list");
    });

    it("accepts KeyValue children in every layout", () => {
      for (const layout of ["grid", "stacked", "inline"] as const) {
        render(
          <KeyValueList layout={layout} aria-label={`meta ${layout}`}>
            <KeyValue label="Actor" value="gary" />
            <KeyValue label="Exit code">0</KeyValue>
          </KeyValueList>,
        );
        const list = screen.getByLabelText(`meta ${layout}`);
        expect(list).toHaveAttribute("data-layout", layout);
        expect(within(list).getAllByRole("definition").map((d) => d.textContent)).toEqual(["gary", "0"]);
        expect(within(list).getAllByRole("term")[0]).toHaveTextContent("Actor");
      }
    });

    it("names absent values in words, never a blank", () => {
      render(
        <KeyValueList
          items={[
            { label: "Owner", value: <NotDeclared /> },
            { label: "Version", value: <NotObserved /> },
            { label: "Tag", value: <NotSupplied /> },
          ]}
        />,
      );
      expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([
        "Not declared",
        "Not observed",
        "Not supplied",
      ]);
    });
  });

  describe("ComparisonGrid", () => {
    const rows = [
      { label: "Replicas", declared: "2", observed: "1", marker: <span>Drifted</span> },
      { label: "Owner", declared: <NotDeclared />, observed: "ops" },
    ];

    it("renders declared and observed sides as named regions of term/definition pairs", () => {
      render(<ComparisonGrid rows={rows} />);
      const declared = screen.getByRole("region", { name: "Declared intent" });
      const observed = screen.getByRole("region", { name: "Observed reality" });
      expect(within(declared).getAllByRole("definition").map((d) => d.textContent)).toEqual(["2", "Not declared"]);
      expect(within(observed).getAllByRole("definition").map((d) => d.textContent)).toEqual(["1Drifted", "ops"]);
      expect(within(declared).queryByText("Drifted")).toBeNull();
    });

    it("uses configurable side labels", () => {
      render(<ComparisonGrid rows={rows} declaredLabel="Estate config" observedLabel="Live host" />);
      expect(screen.getByRole("region", { name: "Estate config" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Live host" })).toBeInTheDocument();
    });

    it("renders free-form sides titled by headings instead of regions", () => {
      render(
        <ComparisonGrid headingLevel={3} declared={<p>declared body</p>} observed={<p>observed body</p>} />,
      );
      expect(screen.queryByRole("region")).toBeNull();
      const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
      expect(headings).toEqual(["Declared intent", "Observed reality"]);
      expect(screen.getByText("declared body")).toBeInTheDocument();
      expect(screen.getByText("observed body")).toBeInTheDocument();
      expect(screen.queryByRole("term")).toBeNull();
    });
  });

  describe("Meter", () => {
    it("exposes a named meter with its value range and text", () => {
      render(<Meter label="Opus" value={82} tone="warn" icon="triangle-alert" srValueText="82% used, nearing limit" meta="Resets in 2h" />);
      const meter = screen.getByRole("meter", { name: "Opus" });
      expect(meter).toHaveAttribute("aria-valuenow", "82");
      expect(meter).toHaveAttribute("aria-valuemin", "0");
      expect(meter).toHaveAttribute("aria-valuemax", "100");
      expect(meter).toHaveAttribute("aria-valuetext", "82% used, nearing limit");
      const root = meter.closest("[data-slot=meter]");
      expect(root).toHaveAttribute("data-tone", "warn");
      expect(root).toHaveTextContent("82%");
      expect(root).toHaveTextContent("Resets in 2h");
    });

    it("clamps the value and supports a custom max and value text", () => {
      render(<Meter label="Disk" value={250} max={200} valueText="250 / 200 GB" />);
      const meter = screen.getByRole("meter", { name: "Disk" });
      expect(meter).toHaveAttribute("aria-valuenow", "200");
      expect(meter).toHaveAttribute("aria-valuetext", "250 / 200 GB");
    });
  });

  describe("StatTile / StatGrid", () => {
    it("pairs the label with its value and sub-label", () => {
      render(
        <StatGrid>
          <StatTile label="Active drift" value="12" tone="warn" icon="triangle-alert" subLabel="3 new" />
        </StatGrid>,
      );
      expect(screen.getByRole("term")).toHaveTextContent("Active drift");
      expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual(["12", "3 new"]);
      const tile = screen.getByRole("term").closest("[data-slot=stat-tile]");
      expect(tile).toHaveAttribute("data-tone", "warn");
      expect(tile?.closest("[data-slot=stat-grid]")).not.toBeNull();
    });

    it("becomes a single link, named by its content, when given href", () => {
      render(<StatTile label="Hosts" value="42" href="/hosts" />);
      const link = screen.getByRole("link", { name: /Hosts\s*42/ });
      expect(link).toHaveAttribute("href", "/hosts");
    });

    it("renders the link through a supplied link component", () => {
      function RouterLink(props: { href: string; className?: string; children?: React.ReactNode }) {
        return <a data-router="yes" {...props} />;
      }
      render(<StatTile label="Hosts" value="42" href="/hosts" linkAs={RouterLink} />);
      expect(screen.getByRole("link")).toHaveAttribute("data-router", "yes");
    });
  });

  describe("CodeBlock", () => {
    it("is a figure named by its caption, with a focusable scroll area and highlighted markup", () => {
      render(
        <CodeBlock
          caption="estate.yaml"
          language="yaml"
          code="replicas: 2"
          highlightedHtml={'<span class="hljs-attr">replicas:</span> <span class="hljs-number">2</span>'}
        />,
      );
      const figure = screen.getByRole("figure", { name: "estate.yaml" });
      const code = figure.querySelector("code")!;
      expect(code).toHaveClass("hljs", "language-yaml");
      expect(code.querySelector(".hljs-number")).toHaveTextContent("2");
      expect(code.closest("pre")).toHaveAttribute("tabindex", "0");
      expect(within(figure).getByText("yaml")).toBeInTheDocument();
    });

    it("renders plain code as text (never as HTML)", () => {
      render(<CodeBlock code={'<b id="x">bold</b>'} copy={false} />);
      expect(screen.getByText('<b id="x">bold</b>')).toBeInTheDocument();
      expect(document.getElementById("x")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("copies the source text and announces the result", async () => {
      const user = userEvent.setup();
      const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      render(<CodeBlock code="echo hi" highlightedHtml="<span>echo</span> hi" />);

      await user.click(screen.getByRole("button", { name: "Copy code" }));
      expect(writeText).toHaveBeenCalledWith("echo hi");
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
    });

    it("reports a failed copy instead of claiming success", async () => {
      const user = userEvent.setup();
      spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
      render(<CodeBlock code="echo hi" />);

      await user.click(screen.getByRole("button", { name: "Copy code" }));
      expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Could not copy to clipboard");
    });
  });

  describe("LogOutput", () => {
    it("is a named polite log region, busy while streaming", () => {
      render(<LogOutput label="Run output" streaming stdout="line 1" />);
      const log = screen.getByRole("log", { name: "Run output" });
      expect(log).toHaveAttribute("aria-live", "polite");
      expect(log).toHaveAttribute("aria-busy", "true");
      expect(log).toHaveTextContent("line 1");
      expect(screen.getByText("Streaming")).toBeInTheDocument();
    });

    it("shows a waiting placeholder while streaming with no output, and 'No output.' once done", () => {
      const { rerender } = render(<LogOutput streaming />);
      expect(screen.getByRole("log", { name: "Output" })).toHaveTextContent("Waiting for output…");
      rerender(<LogOutput />);
      const log = screen.getByRole("log", { name: "Output" });
      expect(log).toHaveAttribute("aria-busy", "false");
      expect(log).toHaveTextContent("No output.");
      expect(screen.queryByText("Streaming")).toBeNull();
    });

    it("labels stderr in text, not just colour", () => {
      render(<LogOutput stdout="ok" stderr="warning: slow" />);
      const stderr = screen.getByText("warning: slow").closest("[data-stream=stderr]") as HTMLElement;
      expect(within(stderr).getByText("Standard error")).toBeInTheDocument();
    });

    it("autoscrolls to the bottom as output grows, unless the reader scrolled up", () => {
      const { rerender } = render(<LogOutput stdout="a" streaming />);
      const pre = screen.getByRole("log").querySelector("[data-stream=stdout]") as HTMLElement;
      let scrollTop = 0;
      Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 500 });
      Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 100 });
      Object.defineProperty(pre, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v;
        },
      });

      rerender(<LogOutput stdout={"a\nb"} streaming />);
      expect(scrollTop).toBe(500);

      // The reader scrolls up: new output must not yank them back down.
      scrollTop = 120;
      fireEvent.scroll(pre);
      rerender(<LogOutput stdout={"a\nb\nc"} streaming />);
      expect(scrollTop).toBe(120);

      // Back at the bottom: pinned again.
      scrollTop = 400;
      fireEvent.scroll(pre);
      rerender(<LogOutput stdout={"a\nb\nc\nd"} streaming />);
      expect(scrollTop).toBe(500);
    });

    it("makes each stream keyboard-scrollable", () => {
      render(<LogOutput stdout="ok" stderr="bad" />);
      for (const pre of screen.getByRole("log").querySelectorAll("pre")) {
        expect(pre).toHaveAttribute("tabindex", "0");
      }
    });
  });

  describe("Prose", () => {
    it("renders the caller's (already sanitized) HTML as content", () => {
      render(<Prose sanitizedHtml="<h2>Restore</h2><p>Stop the <a href='/x'>stack</a> first.</p>" />);
      expect(screen.getByRole("heading", { level: 2, name: "Restore" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "stack" })).toHaveAttribute("href", "/x");
      expect(screen.getByRole("heading").closest("[data-slot=prose]")).not.toBeNull();
    });
  });

  describe("Disclosure", () => {
    it("is a button with aria-expanded/aria-controls, named by label and count", async () => {
      const user = userEvent.setup();
      render(
        <Disclosure label="Waivers" count={3}>
          <p>Three waived findings</p>
        </Disclosure>,
      );
      const trigger = screen.getByRole("button", { name: "Waivers 3" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Three waived findings")).toBeNull();

      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const panel = screen.getByText("Three waived findings").parentElement!;
      expect(trigger.getAttribute("aria-controls")).toBe(panel.id);

      // Keyboard: it's a real button, so Enter and Space toggle it.
      trigger.focus();
      await user.keyboard("{Enter}");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      await user.keyboard(" ");
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });

    it("starts open with defaultOpen", () => {
      render(
        <Disclosure label="Details" defaultOpen>
          <p>Body</p>
        </Disclosure>,
      );
      expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Body")).toBeInTheDocument();
    });

    it("returns focus to the trigger when it collapses with focus inside", () => {
      function Harness({ open, refocus }: { open: boolean; refocus?: boolean }) {
        return (
          <Disclosure label="Edit waiver" open={open} {...(refocus === undefined ? {} : { refocusOnCollapse: refocus })}>
            <button type="button">Done</button>
          </Disclosure>
        );
      }
      const { rerender } = render(<Harness open />);
      act(() => screen.getByRole("button", { name: "Done" }).focus());
      rerender(<Harness open={false} />);
      expect(screen.getByRole("button", { name: "Edit waiver" })).toHaveFocus();

      // Opt out: focus is left where the browser puts it.
      rerender(<Harness open refocus={false} />);
      act(() => screen.getByRole("button", { name: "Done" }).focus());
      rerender(<Harness open={false} refocus={false} />);
      expect(screen.getByRole("button", { name: "Edit waiver" })).not.toHaveFocus();
    });

    it("leaves focus alone when the reader had moved it elsewhere", () => {
      function Harness({ open }: { open: boolean }) {
        return (
          <>
            <Disclosure label="Panel" open={open}>
              <button type="button">Inner</button>
            </Disclosure>
            <button type="button">Elsewhere</button>
          </>
        );
      }
      const { rerender } = render(<Harness open />);
      act(() => screen.getByRole("button", { name: "Inner" }).focus());
      act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
      rerender(<Harness open={false} />);
      expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    });
  });

  describe("ShowMore", () => {
    const items = Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`);

    it("reveals in steps, moves focus to the first revealed item, then offers Show all", async () => {
      const user = userEvent.setup();
      render(
        <ShowMore label="Findings" items={items} initial={3} step={2} noun="findings" renderItem={(t) => t} />,
      );
      const list = screen.getByRole("list", { name: "Findings" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(3);

      await user.click(screen.getByRole("button", { name: "Show 2 more findings" }));
      expect(within(list).getAllByRole("listitem")).toHaveLength(5);
      expect(within(list).getByText("Item 4").closest("li")).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Show all 8 findings" }));
      expect(within(list).getAllByRole("listitem")).toHaveLength(8);
      expect(within(list).getByText("Item 6").closest("li")).toHaveFocus();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("without a step, one button reveals the rest and there is no redundant Show all", async () => {
      const user = userEvent.setup();
      render(<ShowMore items={items} initial={5} renderItem={(t) => t} />);
      expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Show 3 more" }));
      expect(screen.getAllByRole("listitem")).toHaveLength(8);
    });

    it("hands focus to the caller via onReveal(firstRevealedIndex)", async () => {
      const user = userEvent.setup();
      const onReveal = mock();
      render(<ShowMore items={items} initial={3} step={2} onReveal={onReveal} renderItem={(t) => t} />);
      await user.click(screen.getByRole("button", { name: "Show 2 more" }));
      expect(onReveal).toHaveBeenCalledTimes(1);
      expect(onReveal).toHaveBeenCalledWith(3);
      expect(screen.getByRole("button", { name: "Show 2 more" })).toHaveFocus();
    });

    it("renders no controls when everything fits", () => {
      render(<ShowMore items={items.slice(0, 2)} renderItem={(t) => t} />);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  describe("workbench §D section", () => {
    it("renders every specimen without throwing", () => {
      render(<ContentDemo />);
      expect(screen.getAllByRole("figure").length).toBeGreaterThan(10);
      expect(screen.getAllByRole("log")).toHaveLength(5);
    });
  });
});
