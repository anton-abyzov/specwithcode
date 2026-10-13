// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectMessageBody } from "./ProjectMessageBody";

const copy = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: copy, isCopied: false }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  copy.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(text: string, collapsible = true) {
  await act(async () =>
    root.render(
      <ProjectMessageBody text={text} collapsible={collapsible}>
        <div data-full-message>
          <a href="https://example.com">Source</a>
          <pre>{text}</pre>
        </div>
      </ProjectMessageBody>,
    ),
  );
}

describe("coordinator message disclosure", () => {
  it("keeps a long request compact without hidden interactive links, then restores full content", async () => {
    const text =
      'Verify the connection. {"checkConnection":true}\n' + "Keep exact text. ".repeat(60);
    await render(text);
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")!.textContent!.length).toBeLessThanOrEqual(321);
    expect(container.querySelector("p")!.textContent).not.toBe(text);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-full-message]")).toBeNull();
  });

  it("copies the full original request while collapsed, including source dates and JSON", async () => {
    const text = '2026-10-13T06:00:00Z\n{"maxResults":1}\n' + "detail ".repeat(120);
    await render(text);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy full message"]')!.click(),
    );
    expect(copy).toHaveBeenCalledExactlyOnceWith(text, undefined);
  });

  it.each(["Short request.", "x".repeat(600), Array(8).fill("line").join("\n")])(
    "leaves short requests in full",
    async (text) => {
      await render(text);
      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toBe(text);
    },
  );

  it("folds many short lines and leaves assistant results expanded", async () => {
    const text = Array(9).fill("item").join("\n");
    await render(text);
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    await render(text.repeat(40), false);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(text.repeat(40));
  });
});
