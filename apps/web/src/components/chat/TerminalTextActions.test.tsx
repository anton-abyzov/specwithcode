// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const openExternal = vi.fn().mockResolvedValue(undefined);
vi.mock("../../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./HighlightedTokens", () => ({
  HighlightedTokens: ({ code, language }: { code: string; language: string }) => (
    <span data-highlight-language={language}>{code}</span>
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToolCodePanel } from "./toolOutputPresentation";

const GH_DEVICE =
  "\u001b[33m!\u001b[0m First copy your one-time code: \u001b[1m3160-87C3\u001b[0m\n" +
  "Press Enter to open https://github.com/login/device in your browser...\n";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mount(children: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(children));
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  openExternal.mockClear();
});
const stubClipboard = () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  return copy;
};

describe("terminal output links and one-time codes", () => {
  it("links the sign-in page and copies the code from the output and the bar above it", async () => {
    const copy = stubClipboard();
    const parentClick = vi.fn();
    const element = await mount(
      <div onClick={parentClick}>
        <ToolCodePanel label="Output" text={GH_DEVICE} terminal />
      </div>,
    );
    // The shown text is unchanged: links and buttons add no characters.
    expect(element.querySelector("code")!.textContent).toBe(
      "! First copy your one-time code: 3160-87C3\n" +
        "Press Enter to open https://github.com/login/device in your browser...\n",
    );
    const inline = element.querySelector<HTMLAnchorElement>("code a")!;
    expect(inline.getAttribute("href")).toBe("https://github.com/login/device");
    expect(inline.rel).toBe("noopener noreferrer");
    await act(async () => inline.click());
    expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");

    const bar = element.querySelector("[data-terminal-actions]")!;
    expect(bar.textContent).toContain("Open github.com/login/device");
    await act(async () => {
      bar.querySelector<HTMLButtonElement>('[aria-label="Copy code 3160-87C3"]')!.click();
    });
    expect(copy).toHaveBeenCalledWith("3160-87C3");
    expect(bar.querySelector('[aria-label="Copied code 3160-87C3"]')).not.toBeNull();
    await act(async () => {
      element.querySelector<HTMLButtonElement>('code [aria-label="Copy code 3160-87C3"]')!.click();
    });
    expect(copy).toHaveBeenCalledTimes(2);
    // Nothing here toggles the row it sits in.
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("picks up a code and link as live output streams in", async () => {
    const element = await mount(<ToolCodePanel label="Output" text="Starting..." terminal />);
    expect(element.querySelector("[data-terminal-actions]")).toBeNull();
    await act(async () =>
      root!.render(<ToolCodePanel label="Output" text={`Starting...\n${GH_DEVICE}`} terminal />),
    );
    expect(element.querySelector('[aria-label="Copy code 3160-87C3"]')).not.toBeNull();
    expect(element.querySelector('code a[href="https://github.com/login/device"]')).not.toBeNull();
  });

  it("keeps the bar when a grammar colors the output", async () => {
    const element = await mount(
      <ToolCodePanel
        label="Output"
        text={'{"verification_uri": "https://example.com/device", "user_code": "WDJB-MJHT"}\n'}
        language="json"
        terminal
      />,
    );
    expect(element.querySelector("[data-highlight-language=json]")).not.toBeNull();
    expect(element.querySelector('[aria-label="Copy code WDJB-MJHT"]')).not.toBeNull();
    expect(
      element.querySelector('[data-terminal-actions] a[href="https://example.com/device"]'),
    ).not.toBeNull();
  });

  it("puts no buttons above a file that was read", async () => {
    const element = await mount(
      <ToolCodePanel
        label="Output"
        text={"Visit https://github.com/login/device to activate\n"}
        context={{ filePath: "/repo/notes.txt" }}
        terminal
      />,
    );
    expect(element.querySelector("[data-terminal-actions]")).toBeNull();
    expect(element.querySelector("code")!.textContent).toBe(
      "Visit https://github.com/login/device to activate\n",
    );
  });

  it("never links other schemes", async () => {
    const plain = await mount(
      <ToolCodePanel label="Output" text="javascript:alert(1) file:///x" />,
    );
    expect(plain.querySelector("a")).toBeNull();
  });
});
