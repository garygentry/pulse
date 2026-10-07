// apps/web/tests/ui-foundations-links.test.tsx — ported from deck's `ui-foundations-links` suite (vendored `@/ui`).
import { describe, expect, it } from "bun:test";

import { ExternalLink, SafeRouteLink, VisuallyHidden } from "@/ui";

import { describeUi, render, screen } from "./rtl.js";

describeUi("@/ui foundation links", () => {
  const hostHref = (host: string): string => `/inventory/hosts/${encodeURIComponent(host)}`;

  describe("SafeRouteLink", () => {
    it("renders an in-app link with the built href", () => {
      render(<SafeRouteLink build={() => hostHref("nas 01")}>nas 01</SafeRouteLink>);
      const link = screen.getByRole("link", { name: "nas 01" });
      expect(link).toHaveAttribute("href", "/inventory/hosts/nas%2001");
      expect(link).toHaveAttribute("data-slot", "safe-route-link");
      expect(link).not.toHaveAttribute("target");
    });

    it("swallows URIError from an unencodable param and renders a non-interactive marker", () => {
      render(
        <p>
          Host: <SafeRouteLink build={() => hostHref("\uD800")}>bad</SafeRouteLink>
        </p>,
      );
      expect(screen.queryByRole("link")).toBeNull();
      const marker = screen.getByText("Invalid entity link").closest('[data-slot="safe-route-link"]')!;
      expect(marker).toHaveAttribute("data-invalid");
      expect(marker.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText(/Host:/)).toBeInTheDocument();
    });

    it("renders a custom fallback", () => {
      render(
        <SafeRouteLink build={() => hostHref("\uDFFF")} fallback="unknown host">
          x
        </SafeRouteLink>,
      );
      expect(screen.getByText("unknown host")).toBeInTheDocument();
    });

    it("does not swallow errors other than URIError", () => {
      const boom = () => {
        throw new TypeError("bug");
      };
      const original = console.error;
      console.error = () => {};
      try {
        expect(() => render(<SafeRouteLink build={boom}>x</SafeRouteLink>)).toThrow("bug");
      } finally {
        console.error = original;
      }
    });
  });

  describe("ExternalLink", () => {
    it("opens in a new tab safely and says so in its accessible name", () => {
      render(<ExternalLink href="https://example.com/grafana">Grafana</ExternalLink>);
      const link = screen.getByRole("link", { name: "Grafana (opens in new tab)" });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("data-slot", "external-link");
      expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("keeps the sr text when the glyph is hidden", () => {
      render(
        <ExternalLink href="https://example.com" showIcon={false}>
          Docs
        </ExternalLink>,
      );
      const link = screen.getByRole("link", { name: "Docs (opens in new tab)" });
      expect(link.querySelector("svg")).toBeNull();
    });
  });

  describe("VisuallyHidden", () => {
    it("keeps text in the accessibility tree and supports live regions", () => {
      render(
        <VisuallyHidden as="p" role="status" aria-live="polite">
          3 results
        </VisuallyHidden>,
      );
      const region = screen.getByRole("status");
      expect(region.tagName).toBe("P");
      expect(region).toHaveTextContent("3 results");
      expect(region).toHaveAttribute("data-slot", "visually-hidden");
    });
  });
});
