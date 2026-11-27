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
vi.mock("../artifactApps/InstallAsAppButton", () => ({
  InstallAsAppButton: () => <span>install-button</span>,
}));
vi.mock("~/state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: false }) }));
// The reader's content slot, once a test opens it.
const overlay: { content: HTMLElement | null } = { content: null };
vi.mock("~/viewerOverlayStore", () => ({
  useViewerOverlay: (options: { open: boolean }) =>
    options.open && overlay.content ? { content: overlay.content } : null,
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
  overlay.content?.remove();
  overlay.content = null;
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

describe("HtmlRenderFrame stage pages", () => {
  async function renderStage() {
    container = document.createElement("div");
    document.body.appendChild(container);
    overlay.content = document.createElement("div");
    document.body.appendChild(overlay.content);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <HtmlRenderFrame
          environmentId={"env-A" as never}
          htmlRender={{ attachmentId: "att-1", title: "Deck", height: 300, stage: true }}
        />,
      ),
    );
  }

  it("shows a card that runs nothing until Play", async () => {
    await renderStage();
    expect(document.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[data-html-render-stage]")).not.toBeNull();
    expect(container.textContent).toContain("Motion presentation");
  });

  it("plays full size in the reader with sound and fullscreen allowed", async () => {
    await renderStage();
    const play = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Play"),
    );
    await act(async () => play?.click());
    const frame = overlay.content?.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("allow")).toBe("autoplay; fullscreen");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame?.getAttribute("loading")).toBe("eager");
  });

  it("never gives an inline report frame sound or fullscreen", async () => {
    await frameSrc(undefined);
    expect(document.querySelector("iframe")?.hasAttribute("allow")).toBe(false);
  });
});

describe("HtmlRenderFrame earlier versions", () => {
  it("shows a replaced report as a header only, with no install and no page loaded", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <HtmlRenderFrame
          environmentId={"env-A" as never}
          htmlRender={{ attachmentId: "att-1", title: "Guide", height: 300 }}
          threadRef={{ environmentId: "env-A", threadId: "thread-1" } as never}
          replaced
        />,
      ),
    );
    expect(container.textContent).toContain("Earlier version. The newest is further down.");
    expect(container.textContent).not.toContain("install-button");
    expect(container.querySelector<HTMLElement>(".html-report-preview")?.hidden).toBe(true);
    // Hidden is not enough: a hidden frame still runs, so no frame exists until it is opened.
    expect(document.querySelector("iframe")).toBeNull();
    const openButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open report"),
    );
    expect(openButton).toBeDefined();
    await act(async () => openButton?.click());
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("keeps Install as app on the newest version", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <HtmlRenderFrame
          environmentId={"env-A" as never}
          htmlRender={{ attachmentId: "att-1", title: "Guide", height: 300 }}
          threadRef={{ environmentId: "env-A", threadId: "thread-1" } as never}
        />,
      ),
    );
    expect(container.textContent).toContain("install-button");
  });

  it("labels a current report plainly and says the thread shows a preview", async () => {
    await frameSrc(undefined);
    expect(container.textContent).toContain("Report");
    expect(container.textContent).not.toContain("Interactive");
    expect(container.textContent).toContain("A preview. Open the report");
  });
});
