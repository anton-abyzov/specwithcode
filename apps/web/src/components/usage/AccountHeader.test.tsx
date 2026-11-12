// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TooltipProvider } from "../ui/tooltip";
import { AccountHeader, shortDuration } from "./AccountHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});
function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return host;
}

describe("AccountHeader", () => {
  it("names provider, plan and email, and links to the provider's usage page", () => {
    const node = render(
      <AccountHeader
        driver="claudeAgent"
        label="Claude"
        plan="Claude Ultra"
        email="dev@example.com"
      />,
    );
    expect(node.textContent).toContain("Claude Ultra");
    expect(node.textContent).toContain("dev@example.com");
    const link = node.querySelector("a[data-usage-link]");
    expect(link?.getAttribute("href")).toBe("https://claude.ai/settings/usage");
    expect(link?.getAttribute("aria-label")).toBe("Open Claude usage");
  });

  it("prints nothing for an unknown account and no link without a page", () => {
    const node = render(<AccountHeader driver="grok" label="Grok" />);
    expect(node.textContent).toBe("Grok");
    expect(node.querySelector("a")).toBeNull();
  });

  it("shows the fallback place and machine as marks", () => {
    const node = render(
      <AccountHeader
        driver="codex"
        label="Codex"
        rank={{ position: 2, label: "Codex · GPT-6.1 Sol" }}
        machine={{ name: "M4", tip: "Read on M4 2m ago" }}
      />,
    );
    expect(node.querySelector(".sws-account-rank")?.getAttribute("aria-label")).toBe(
      "Fallback 2: Codex · GPT-6.1 Sol",
    );
    expect(node.querySelector(".sws-account-machine")?.textContent).toBe("M4");
  });
});

describe("shortDuration", () => {
  it("keeps the largest unit", () => {
    expect(shortDuration(48 * 3_600_000)).toBe("2d");
    expect(shortDuration(5 * 3_600_000 + 59 * 60_000)).toBe("5h");
    expect(shortDuration(12 * 60_000)).toBe("12m");
    expect(shortDuration(-1)).toBe("0m");
  });
});
