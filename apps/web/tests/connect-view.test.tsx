// apps/web/tests/connect-view.test.tsx — the /connect page in its four states (loading, usable, refused,
// error): page structure, the QR text alternative, the refusal copy and the keyboard copy path.
import { describe, expect, it, spyOn } from "bun:test";
import { buildConnectLink, CONNECT_LINK_MAX_LENGTH, type ConnectLinkRefusal } from "@pulse/web-data/contract";
import { CLIENT_TRANSPORT_MESSAGES } from "@pulse/web-data/wire";

import type { ConnectLinkPayload } from "../src/shared/connect-link.js";
import { connectView } from "../src/client/views/connect/index.js";
import { CONNECT_LINK_PATH } from "../src/client/views/connect/use-connect-link.js";
import { ConnectView, refusalCopy } from "../src/client/views/connect/view.js";
import { describeUi, render, screen, userEvent, within } from "./rtl.js";

const BASE = "https://pulse.example.com";
const LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";
const ENV_VAR = "PULSE_WEB_EXTERNAL_URL";

const CONFIGURED: ConnectLinkPayload = { configured: { link: LINK, baseUrl: BASE }, refusal: null };
const NEITHER: ConnectLinkPayload = { configured: null, refusal: null };

interface StubFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: string[];
}

/** A stable fetch that answers each call with the next queued response; a call past the queue stays pending. */
function stubFetch(responses: ReadonlyArray<() => Response>): StubFetch {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const next = responses[calls.length];
    calls.push(String(input));
    return next === undefined ? new Promise<Response>(() => {}) : next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => (): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Render the page over one response and wait until it leaves the loading state. */
async function renderSettled(body: unknown, origin = BASE, status = 200): Promise<HTMLElement> {
  const { fetchImpl } = stubFetch([json(body, status)]);
  const { container } = render(<ConnectView fetchImpl={fetchImpl} origin={origin} />);
  await screen.findByText(/./, { selector: '[data-slot="connect-page"]:not([data-region="loading"]) h1' });
  return container;
}

/** The page root carries the slot and holds the one h1, which PageHeader renders. */
function expectPageStructure(container: HTMLElement): void {
  const root = container.firstElementChild as HTMLElement;
  expect(root).toHaveAttribute("data-slot", "connect-page");
  const h1s = screen.getAllByRole("heading", { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]).toHaveTextContent("Connect a phone");
  expect(h1s[0]!.closest('[data-slot="page-header"]')).not.toBeNull();
  expect(within(root).getByRole("heading", { level: 1 })).toBe(h1s[0]!);
}

/** No code and no link text anywhere on the page. */
function expectNoLink(): void {
  expect(screen.queryByRole("img", { name: /pulse:/ })).toBeNull();
  expect(screen.queryByText(/pulse:\/\//)).toBeNull();
  expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
}

/** An https origin whose connect link is longer than the limit. */
const LONG_ORIGIN = `https://${Array.from({ length: 5 }, () => "a".repeat(50)).join(".")}.example.com`;

describe("refusalCopy", () => {
  const CASES: ReadonlyArray<readonly ["config" | "browsing", ConnectLinkRefusal, string, string]> = [
    ["config", "not-https", `${ENV_VAR} does not use HTTPS`, `Set ${ENV_VAR} to the server's https address and restart Pulse.`],
    ["config", "loopback", `${ENV_VAR} is a loopback address`, `A phone cannot reach a loopback address. Set ${ENV_VAR} to the server's https address and restart Pulse.`],
    ["config", "too-long", `${ENV_VAR} is too long`, `The link would be longer than 256 characters and could not be scanned. Use a shorter https address for ${ENV_VAR}.`],
    ["browsing", "not-https", "you are browsing Pulse over http", `Browse Pulse by its https address, or set ${ENV_VAR} to the server's https address.`],
    ["browsing", "loopback", "you are browsing Pulse on a loopback address", `A phone cannot reach this address. Browse Pulse by its https address, or set ${ENV_VAR}.`],
    ["browsing", "too-long", "this address is too long", `Set ${ENV_VAR} to a shorter https address.`],
    ["browsing", "unparseable", "this address could not be read", `Set ${ENV_VAR} to the server's https address.`],
    ["browsing", "credentials", "this address carries credentials", `Set ${ENV_VAR} to the server's https address, without a user name or password.`],
  ];

  it.each(CASES)("%s / %s names the cause and the fix", (cause, reason, cause_text, body) => {
    expect(refusalCopy({ kind: "refused", reason, cause })).toEqual({ title: `No connect link: ${cause_text}`, body });
  });

  it("takes the length limit from the contract", () => {
    expect(CONNECT_LINK_MAX_LENGTH).toBe(256);
  });
});

describeUi("ConnectView", () => {
  it("is what the registered view loads", async () => {
    expect(connectView).toMatchObject({ id: "connect", label: "Connect a phone" });
    expect(connectView.nav).toBeUndefined();
    expect(await connectView.load()).toBe(ConnectView as unknown as Awaited<ReturnType<typeof connectView.load>>);
  });

  it("loading: a named status region under the one h1, with no code yet", () => {
    const { fetchImpl, calls } = stubFetch([]);
    const { container } = render(<ConnectView fetchImpl={fetchImpl} origin={BASE} />);
    expect(screen.getByRole("status", { name: "Loading the connect link" })).toHaveAttribute("aria-busy", "true");
    expectPageStructure(container);
    expectNoLink();
    expect(calls).toEqual([CONNECT_LINK_PATH]);
  });

  it("usable, configured: the code's text alternative is the link, beside the link text and its source", async () => {
    const container = await renderSettled(CONFIGURED, "http://localhost:8080");
    expectPageStructure(container);
    expect(screen.getByRole("img", { name: LINK })).toBeInTheDocument();
    expect(screen.getByText(LINK)).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Connect link" });
    expect(within(section).getByText(`Address from ${ENV_VAR}: ${BASE}`)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("usable, browsing: builds the link from the address being browsed and says how to pin it", async () => {
    const container = await renderSettled(NEITHER, BASE);
    expectPageStructure(container);
    expect(screen.getByRole("img", { name: LINK })).toBeInTheDocument();
    expect(screen.getByText(LINK)).toBeInTheDocument();
    expect(
      screen.getByText(`Address you are browsing: ${BASE}. Set ${ENV_VAR} so every operator gets the same link.`),
    ).toBeInTheDocument();
  });

  it.each(["not-https", "loopback", "too-long"] as const)(
    "refused, config (%s): an alert with icon and text, and no code or link",
    async (reason) => {
      // The browsing address is usable, and is still not used once the configured one is refused.
      const container = await renderSettled({ configured: null, refusal: { reason, envVar: ENV_VAR } }, BASE);
      expectPageStructure(container);
      const copy = refusalCopy({ kind: "refused", reason, cause: "config" });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("data-slot", "connect-refused");
      expect(alert).toHaveAttribute("data-tone", "danger");
      expect(within(alert).getByText(copy.title)).toBeInTheDocument();
      expect(within(alert).getByText(copy.body)).toBeInTheDocument();
      // Icon plus text, never colour alone: the tone glyph is decorative and sits beside the title.
      expect(alert.querySelector("svg[aria-hidden]")).not.toBeNull();
      expectNoLink();
    },
  );

  it.each([
    ["not-https", "http://192.0.2.10"],
    ["not-https", "http://localhost:8080"],
    ["loopback", "https://localhost:8443"],
    ["loopback", "https://127.0.0.1"],
    ["too-long", LONG_ORIGIN],
    ["unparseable", "null"],
    ["credentials", "https://operator:secret@pulse.example.com"],
  ] as const)("refused, browsing (%s, %s): names the cause and shows no code or address", async (reason, origin) => {
    expect(buildConnectLink(origin)).toMatchObject({ ok: false, refusal: reason });
    const container = await renderSettled(NEITHER, origin);
    expectPageStructure(container);
    const copy = refusalCopy({ kind: "refused", reason, cause: "browsing" });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(copy.title)).toBeInTheDocument();
    expect(within(alert).getByText(copy.body)).toBeInTheDocument();
    expect(alert.querySelector("svg[aria-hidden]")).not.toBeNull();
    expectNoLink();
    expect(container.textContent).not.toContain("secret");
  });

  it("a served link too long for a scannable code is refused as too long, not drawn", async () => {
    const link = `${LINK}&name=${"a".repeat(3000)}`;
    await renderSettled({ configured: { link, baseUrl: BASE }, refusal: null });
    const copy = refusalCopy({ kind: "refused", reason: "too-long", cause: "config" });
    expect(within(screen.getByRole("alert")).getByText(copy.title)).toBeInTheDocument();
    expectNoLink();
  });

  it("error: an alert with Retry, which refetches and then shows the link", async () => {
    const user = userEvent.setup();
    const { fetchImpl, calls } = stubFetch([json({ code: "INTERNAL_ERROR", message: "Internal error." }, 500), json(CONFIGURED)]);
    const { container } = render(<ConnectView fetchImpl={fetchImpl} origin={BASE} />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load the connect link")).toBeInTheDocument();
    expectPageStructure(container);
    expectNoLink();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("img", { name: LINK })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toEqual([CONNECT_LINK_PATH, CONNECT_LINK_PATH]);
  });

  it("error: a body of the wrong shape is an error, never a link", async () => {
    const container = await renderSettled({ configured: { link: "https://pulse.example.com", baseUrl: BASE }, refusal: null });
    expectPageStructure(container);
    expect(within(screen.getByRole("alert")).getByText(CLIENT_TRANSPORT_MESSAGES.RESPONSE_INVALID)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keyboard: Tab reaches the copy button and Enter copies the link", async () => {
    const user = userEvent.setup();
    const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    try {
      await renderSettled(CONFIGURED);
      const copy = screen.getByRole("button", { name: "Copy code" });
      for (let i = 0; i < 5 && document.activeElement !== copy; i += 1) await user.tab();
      expect(document.activeElement).toBe(copy);

      await user.keyboard("{Enter}");
      expect(writeText).toHaveBeenCalledWith(LINK);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
    } finally {
      writeText.mockRestore();
    }
  });

  it("kiosk: the page brings its own gutter only when the route carries kiosk=1", async () => {
    const routerWith = (query: Record<string, string>) =>
      ({ current: () => ({ query }) }) as unknown as NonNullable<Parameters<typeof ConnectView>[0]["router"]>;
    const { fetchImpl } = stubFetch([]);
    const kiosk = render(<ConnectView fetchImpl={fetchImpl} origin={BASE} router={routerWith({ kiosk: "1" })} />);
    expect(kiosk.container.firstElementChild).toHaveAttribute("data-kiosk", "1");
    kiosk.unmount();
    const desk = render(<ConnectView fetchImpl={fetchImpl} origin={BASE} router={routerWith({})} />);
    expect(desk.container.firstElementChild).toHaveAttribute("data-kiosk", "0");
  });
});
