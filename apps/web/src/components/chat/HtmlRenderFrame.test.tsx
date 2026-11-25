// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const URL_ = "https://host.test/api/assets/page.html?sig=abc";

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: { "--background": "#111" } }),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: URL_, expiresAt: Date.now() + 3_600_000 }),
  useAssetUrlRefresh: () => async () => URL_,
}));
vi.mock("~/state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: false }) }));
vi.mock("~/viewerOverlayStore", () => ({
  useViewerOverlay: () => null,
  useViewerOverlayStore: { getState: () => ({ setThreadCollapsed: () => undefined }) },
}));

const { HtmlRenderFrame } = await import("./HtmlRenderFrame");

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function frameSrc(kind: "visual" | undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <HtmlRenderFrame
        environmentId={"env-A" as never}
        htmlRender={{
          attachmentId: "att-1",
          title: "Page",
          height: 300,
          ...(kind ? { kind } : {}),
        }}
      />,
    ),
  );
  const frame = document.querySelector<HTMLIFrameElement>("iframe");
  if (!frame) throw new Error("no frame");
  return frame.getAttribute("src") ?? "";
}

describe("HtmlRenderFrame scroll containment", () => {
  it("an inline visual asks its page to keep scrollIntoView inside the frame", async () => {
    const src = await frameSrc("visual");
    expect(src.startsWith(`${URL_}#studio-theme=`)).toBe(true);
    expect(src.endsWith("&studio-contain-scroll")).toBe(true);
  });

  // The report's frame also serves the full-screen reader, which a page's own
  // scrollIntoView must still be able to scroll.
  it("a report keeps the browser's own scrollIntoView", async () => {
    const src = await frameSrc(undefined);
    expect(src.startsWith(`${URL_}#studio-theme=`)).toBe(true);
    expect(src).not.toContain("studio-contain-scroll");
  });
});
