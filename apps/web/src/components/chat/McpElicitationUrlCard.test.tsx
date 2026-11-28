// @vitest-environment jsdom
import {
  MCP_ELICITATION_URL_DONE_ANSWER,
  RuntimeRequestId,
  type OrchestrationV2McpElicitation,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderToStaticMarkup } from "react-dom/server";

import type { PendingApproval } from "../../session-logic";
import {
  ComposerPendingApprovalPanel,
  isMcpElicitationCardApproval,
} from "./ComposerPendingApprovalPanel";
import { McpElicitationUrlCard } from "./McpElicitationUrlCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requestId = RuntimeRequestId.make("elicitation-url-1");
const SIGN_IN = "https://accounts.github.com/login/device?code=ABCD&next=%2Fhome";
const link = (url: string | undefined): OrchestrationV2McpElicitation => ({
  serverName: "github",
  mode: "url",
  message: "Sign in to GitHub to continue.",
  ...(url === undefined ? {} : { url }),
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(
  options: {
    url?: string | undefined;
    onRespond?: ReturnType<typeof vi.fn>;
    openLink?: (url: string) => Promise<void>;
    disabled?: boolean;
  } = {},
) {
  const onRespond = options.onRespond ?? vi.fn(async () => undefined);
  const openLink = options.openLink ?? vi.fn(async () => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <McpElicitationUrlCard
        requestId={requestId}
        elicitation={link("url" in options ? options.url : SIGN_IN)}
        pendingCount={1}
        disabled={options.disabled ?? false}
        isResponding={false}
        onRespond={onRespond as never}
        openLink={openLink}
      />,
    ),
  );
  return { container: host, onRespond, openLink };
}

const click = (element: Element | null) => act(() => (element as HTMLElement).click());
const button = (container: HTMLElement, selector: string) =>
  container.querySelector<HTMLButtonElement>(selector)!;

describe("McpElicitationUrlCard", () => {
  it("shows the server, the message, the full link and its registrable domain", () => {
    const { container } = mount();
    expect(container.textContent).toContain("github asks you to open a link");
    expect(container.textContent).toContain("Sign in to GitHub to continue.");
    expect(container.querySelector("[data-url-full]")?.textContent).toBe(SIGN_IN);
    expect(container.querySelector("[data-url-host]")?.textContent).toBe("accounts.github.com");
    expect(container.querySelector("[data-url-registrable-domain]")?.textContent).toBe(
      "github.com",
    );
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Cancel", "Decline", "Open link", "I'm done, continue"]);
    expect(container.querySelectorAll("[data-url-warning]")).toHaveLength(0);
  });

  it("opens nothing until the person presses Open link, then opens the link unchanged", async () => {
    const { container, openLink, onRespond } = mount();
    expect(openLink).not.toHaveBeenCalled();
    click(button(container, "[data-url-open]"));
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(SIGN_IN);
    // Opening answers nothing: the server still waits for the person.
    expect(onRespond).not.toHaveBeenCalled();
    // Once opened, "I'm done, continue" becomes the main action.
    const before = button(container, "[data-approval-decision='accept']").className;
    await act(async () => undefined);
    expect(button(container, "[data-approval-decision='accept']").className).not.toBe(before);
  });

  it("sends accept with the card's done answer, and decline or cancel bare", () => {
    const { container, onRespond } = mount();
    click(button(container, "[data-approval-decision='accept']"));
    expect(onRespond).toHaveBeenLastCalledWith(requestId, "accept", {
      ...MCP_ELICITATION_URL_DONE_ANSWER,
    });
    click(button(container, "[data-approval-decision='decline']"));
    expect(onRespond).toHaveBeenLastCalledWith(requestId, "decline");
    click(button(container, "[data-approval-decision='cancel']"));
    expect(onRespond).toHaveBeenLastCalledWith(requestId, "cancel");
  });

  it("warns about a lookalike, Punycode or insecure link", () => {
    const cases = [
      ["https://xn--80ak6aa92e.com/login", ["punycode"]],
      ["https://gіthub.com/login", ["punycode", "mixed-script"]],
      ["http://github.example/login", ["not-https"]],
      ["http://localhost:3000/callback", []],
    ] as const;
    for (const [url, warnings] of cases) {
      const { container } = mount({ url });
      expect(
        [...container.querySelectorAll<HTMLElement>("[data-url-warning]")].map(
          (node) => node.dataset.urlWarning,
        ),
      ).toEqual(warnings);
      act(() => root?.unmount());
      host?.remove();
      root = null;
    }
  });

  it("shows the decoded host so a lookalike is visible, and still opens the raw link", () => {
    const { container, openLink } = mount({ url: "https://xn--80ak6aa92e.com/login" });
    expect(container.querySelector("[data-url-host]")?.textContent).toBe("аррӏе.com");
    click(button(container, "[data-url-open]"));
    expect(openLink).toHaveBeenCalledWith("https://xn--80ak6aa92e.com/login");
  });

  it("offers only Decline and Cancel for a link it can't show", () => {
    for (const url of [undefined, "javascript:alert(1)", "https://a@evil.example"]) {
      const openLink = vi.fn(async () => undefined);
      const { container } = mount({ url, openLink });
      expect(container.textContent).toContain("This link can't be shown.");
      expect(button(container, "[data-url-open]").disabled).toBe(true);
      expect(button(container, "[data-approval-decision='accept']").disabled).toBe(true);
      click(button(container, "[data-url-open]"));
      expect(openLink).not.toHaveBeenCalled();
      act(() => root?.unmount());
      host?.remove();
      root = null;
    }
  });

  it("says so when the link didn't open", async () => {
    const { container } = mount({ openLink: async () => Promise.reject(new Error("no")) });
    click(button(container, "[data-url-open]"));
    await act(async () => undefined);
    expect(container.textContent).toContain("The link didn't open.");
  });

  it("does nothing while locked", () => {
    const { container, onRespond, openLink } = mount({ disabled: true });
    for (const selector of [
      "[data-url-open]",
      "[data-approval-decision='accept']",
      "[data-approval-decision='decline']",
    ])
      click(button(container, selector));
    expect(onRespond).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe("ComposerPendingApprovalPanel with an MCP link", () => {
  const approval = (extra: Partial<PendingApproval>): PendingApproval => ({
    requestId,
    requestKind: "mcp-elicitation",
    createdAt: "2026-11-28T00:00:00.000Z",
    detail: "Sign in to GitHub to continue.",
    appName: "github",
    responseCapability: "live",
    elicitation: link(SIGN_IN),
    ...extra,
  });

  it("draws the link card and hides the generic approval actions", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={approval({})}
        pendingCount={1}
        onRespond={async () => undefined}
      />,
    );
    expect(markup).toContain("data-mcp-elicitation-url");
    expect(markup).not.toContain("App access approval");
    expect(isMcpElicitationCardApproval(approval({}))).toBe(true);
  });

  it("shows no link once the provider process is gone", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={approval({ responseCapability: "not_resumable" })}
        pendingCount={1}
        onRespond={async () => undefined}
      />,
    );
    expect(markup).toContain("Provider process is gone");
    expect(markup).not.toContain("data-mcp-elicitation-url");
    expect(markup).not.toContain("accounts.github.com");
  });
});
