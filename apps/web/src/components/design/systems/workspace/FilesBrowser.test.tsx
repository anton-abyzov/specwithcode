// @vitest-environment jsdom
import type { DesignOwnerInput, EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SystemFilesApi } from "./systemFilesApi";
import { fakeFilesApi, stubObjectUrls, SYSTEM } from "./testFakes";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));
vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: { text: string }) => <div data-testid="markdown-body">{props.text}</div>,
}));
vi.mock("~/components/files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string; text: string }) => (
    <pre data-testid="source" data-name={props.name}>
      {props.text}
    </pre>
  ),
}));

const { FilesBrowserView } = await import("./FilesBrowser");

let container: HTMLDivElement;
let root: Root;
let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  urls = stubObjectUrls();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  urls.restore();
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const row = (path: string) => $(`[data-testid="files-row"][data-path="${path}"]`)!;
const folder = (path: string) => $(`[data-testid="files-folder"][data-path="${path}"]`)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await flush();
};

const FILES = [
  { path: "README.md", text: "# Acme\n\nCalm and dense.", mimeType: "text/markdown" },
  { path: "docs/voice.md", text: "# Voice\n\nPlain words." },
  { path: "fonts/Inter.woff2", text: "wOF2", mimeType: "font/woff2" },
  {
    path: "assets/Logos/mark.svg",
    text: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    mimeType: "image/svg+xml",
  },
  { path: "assets/Logos/brand.pdf", text: "%PDF-1.7", mimeType: "application/pdf" },
  { path: "src/theme.css", origin: "source" as const, text: ":root { --ink: #111; }" },
  { path: "src/.env.css", origin: "source" as const, text: "hidden" },
  {
    path: "src/huge.css",
    origin: "source" as const,
    text: "",
    unavailable: "larger than 2 MB",
  },
];

const OWNER: DesignOwnerInput = { kind: "playground" };

function render(api: SystemFilesApi, extra: { canEdit?: boolean } = {}) {
  const onClose = vi.fn();
  const onGoToSection = vi.fn();
  act(() =>
    root.render(
      <div style={{ position: "relative" }}>
        <FilesBrowserView
          environmentId={"env" as EnvironmentId}
          owner={OWNER}
          system={SYSTEM}
          canEdit={extra.canEdit ?? true}
          onClose={onClose}
          onGoToSection={onGoToSection}
          api={api}
        />
      </div>,
    ),
  );
  return { onClose, onGoToSection };
}

describe("FilesBrowser", () => {
  it("groups the files with where each one shows, and hides dot paths", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await flush();
    const headings = [...document.querySelectorAll("[data-group]")].map((group) =>
      group.getAttribute("data-group"),
    );
    expect(headings).toEqual(["Folders", "Stylesheets", "Documents", "Data", "Sources"]);
    expect(row("README.md").textContent).toContain("Markdown · Shown in Overview");
    expect(row("tokens.css").textContent).toContain(
      "Stylesheet · Generated from this design system",
    );
    expect(row("src/theme.css").textContent).toContain("Read from the repository");
    expect($('[data-path="src/.env.css"]')).toBeNull();
    expect(folder("fonts").textContent).toContain("Folder · 1 file");
  });

  it("previews markdown when a file is clicked, with its details and Go to", async () => {
    const { api } = fakeFilesApi(FILES);
    const { onGoToSection } = render(api);
    await click(row("README.md"));
    expect(api.read).toHaveBeenCalledWith({ origin: "stored", path: "README.md" });
    expect($('[data-testid="file-preview-markdown"]')!.textContent).toContain("Acme");
    expect($('[data-testid="markdown-body"]')!.textContent).toContain("Calm and dense.");
    expect($('[data-testid="files-name"]')!.textContent).toBe("README.md");
    expect($('[data-testid="files-where"]')!.textContent).toBe("Markdown · Shown in Overview");
    expect($('[data-testid="files-size"]')!.textContent).toBe("23 B · MD");
    await click(button("Go to Overview")!);
    expect(onGoToSection).toHaveBeenCalledWith("readme");
  });

  it("splits list and preview by its own width, not the window's", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await flush();
    const browser = $('[data-testid="files-browser"]')!;
    const list = $('nav[aria-label="System files"]')!;
    expect(browser.className).toContain("@container/files");
    expect(list.className).toContain("@2xl/files:flex");
    await click(row("README.md"));
    // A narrow browser shows one pane: the list hides behind All files.
    expect(list.classList.contains("hidden")).toBe(true);
    expect(button("All files")!.parentElement!.className).toContain("@2xl/files:hidden");
    const layout = [browser, list, button("All files")!.parentElement!].map((el) => el.className);
    expect(layout.join(" ")).not.toMatch(/(^|\s)(md|lg):/);
  });

  it("opens folders in place and shows an image through a blob URL, never inline SVG", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click(folder("assets"));
    expect(folder("assets").getAttribute("aria-expanded")).toBe("true");
    await click(folder("assets/Logos"));
    await click(row("assets/Logos/mark.svg"));
    const image = $<HTMLImageElement>('[data-testid="file-preview-image"]')!;
    expect(image.getAttribute("src")).toMatch(/^blob:fake\//);
    expect(urls.created.at(-1)!.type).toBe("image/svg+xml");
    expect(document.querySelector("svg script")).toBeNull();
    expect($('[data-testid="files-where"]')!.textContent).toBe("Image · Shown in Assets");
  });

  it("shows generated and source files as read-only source", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click(row("tokens.css"));
    expect(api.read).not.toHaveBeenCalled();
    expect($('[data-testid="source"]')!.textContent).toContain(":root {");
    expect($('[data-testid="source"]')!.textContent).toContain("--ink: #111111;");
    await click(row("src/theme.css"));
    expect(api.read).toHaveBeenCalledWith({ origin: "source", path: "src/theme.css" });
    expect($('[data-testid="source"]')!.textContent).toBe(":root { --ink: #111; }");
    expect(button("Rename")).toBeNull();
  });

  it("renders a font as a specimen from its bytes", async () => {
    const loaded: string[] = [];
    const fonts = { add: vi.fn(), delete: vi.fn() };
    class FakeFontFace {
      constructor(
        readonly family: string,
        readonly source: ArrayBuffer,
      ) {
        loaded.push(family);
      }
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    try {
      const { api } = fakeFilesApi(FILES);
      render(api);
      await click(folder("fonts"));
      await click(row("fonts/Inter.woff2"));
      const specimen = $('[data-testid="font-specimen"]')!;
      expect(specimen.getAttribute("data-state")).toBe("ready");
      expect(specimen.textContent).toContain("The quick brown fox jumps over the lazy dog");
      expect(specimen.textContent).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
      expect(fonts.add).toHaveBeenCalledTimes(1);
      expect($('[data-testid="files-where"]')!.textContent).toBe("Font · Shown in Typography");
      await click(button("Go to Typography")!);
    } finally {
      vi.unstubAllGlobals();
      delete (document as { fonts?: unknown }).fonts;
    }
    expect(loaded).toHaveLength(1);
  });

  it("explains a PDF and an unreadable source, and downloads the PDF", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click(folder("assets"));
    await click(folder("assets/Logos"));
    await click(row("assets/Logos/brand.pdf"));
    expect($('[data-testid="files-preview"]')!.textContent).toContain(
      "Preview isn't available for this file type",
    );
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await click(button("Download")!);
    expect(api.read).toHaveBeenCalledWith({ origin: "stored", path: "assets/Logos/brand.pdf" });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(urls.created.at(-1)!.size).toBe(8);
    clicked.mockRestore();

    await click(row("src/huge.css"));
    expect($('[data-testid="files-preview"]')!.textContent).toContain(
      "This file can't be read from the repository: larger than 2 MB",
    );
    expect(button("Download")!.disabled).toBe(true);
  });

  it("renames and deletes stored files when editing, with a confirmation", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click(folder("docs"));
    await click(row("docs/voice.md"));
    await click(button("Delete")!);
    expect($('[data-testid="confirm-delete"]')!.textContent).toContain(
      "Anything linking to it will break.",
    );
    expect(api.remove).not.toHaveBeenCalled();
    const confirm = [...$('[data-testid="confirm-delete"]')!.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Delete",
    )!;
    await click(confirm);
    expect(api.remove).toHaveBeenCalledWith("docs/voice.md");
    expect(api.listing.refresh).toHaveBeenCalled();
  });

  it("is read-only without edit rights", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api, { canEdit: false });
    await click(row("README.md"));
    expect(button("Rename")).toBeNull();
    expect(button("Delete")).toBeNull();
    expect(button("Download")).not.toBeNull();
  });

  it("closes from its button and from Esc", async () => {
    const { api } = fakeFilesApi(FILES);
    const { onClose } = render(api);
    await click($('[aria-label="Close the file browser"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says when it is listing, when listing failed, and when there are no files", async () => {
    const pending = fakeFilesApi([], { listing: { data: null } });
    render(pending.api);
    expect($('[data-testid="files-browser"]')!.textContent).toContain("Listing files…");

    const failed = fakeFilesApi([], { listing: { data: null, error: "Network down" } });
    render(failed.api);
    expect($('[data-testid="files-browser"]')!.textContent).toContain("Couldn't list the files.");
    await click(button("Try again")!);
    expect(failed.api.listing.refresh).toHaveBeenCalled();

    const empty = fakeFilesApi([]);
    render(empty.api);
    expect($('[data-testid="files-empty"]')!.textContent).toContain(
      "This design system has no stored files yet",
    );
    expect(row("tokens.json")).not.toBeNull();
  });
});
