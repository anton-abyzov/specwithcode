// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { assetSets } from "./assetsModel";
import { browserFile } from "./filesModel";
import type { SystemFilesApi } from "./systemFilesApi";
import { fakeFilesApi, stubObjectUrls } from "./testFakes";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));

const { AssetsSectionView, REMOVE_ASSETS_TEXT } = await import("./AssetsSection");

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
const $ = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document.body) =>
  scope.querySelector<T>(selector);
const button = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const set = (name: string) => $(`[data-testid="asset-set"][data-set="${name}"]`)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await flush();
};

const file = (name: string, size: number, type = "image/png") => {
  const blob = new File([new Uint8Array(size).fill(7)], name, { type });
  return blob;
};

async function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (let index = 0; index < 5; index += 1) await flush();
}

async function drop(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  await act(async () => {
    target.dispatchEvent(event);
  });
  for (let index = 0; index < 5; index += 1) await flush();
}

const FILES = [
  { path: "assets/Logos/mark.svg", text: "<svg/>", mimeType: "image/svg+xml" },
  { path: "assets/Logos/wordmark.png", text: "x".repeat(93_184), mimeType: "image/png" },
  { path: "assets/hero.jpg", text: "jpg", mimeType: "image/jpeg" },
  { path: "assets/.DS_Store", text: "" },
  { path: "README.md", text: "# Acme" },
  { path: "src/logo.svg", origin: "source" as const, text: "<svg/>" },
];

function render(api: SystemFilesApi, canEdit = true) {
  act(() => root.render(<AssetsSectionView canEdit={canEdit} api={api} />));
}

describe("asset sets", () => {
  it("are the folders under assets/, with loose files in Other", () => {
    const { api } = fakeFilesApi(FILES);
    const sets = assetSets(api.listing.data!.files.map(browserFile));
    expect(sets.map((entry) => [entry.name, entry.folder, entry.files.map((f) => f.name)])).toEqual(
      [
        ["Logos", "assets/Logos", ["mark.svg", "wordmark.png"]],
        ["Other", "assets", ["hero.jpg"]],
      ],
    );
  });
});

describe("AssetsSection", () => {
  it("lists each set as a table with type and size, and the storage footer", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await flush();
    const logos = set("Logos");
    expect(logos.textContent).toContain("2 files");
    const types = [...logos.querySelectorAll('[data-testid="asset-type"]')].map(
      (cell) => cell.textContent,
    );
    expect(types).toEqual(["SVG · 6 B", "PNG · 91 KB"]);
    expect(set("Other").textContent).toContain("hero.jpg");
    expect($('[data-testid="assets-storage"]')!.textContent).toBe(
      "Stored with this design system: 5 files · 91 KB of 1024 MB used",
    );
    // Thumbnails load through blob URLs.
    expect(logos.querySelector("img")?.getAttribute("src")).toMatch(/^blob:fake\//);
  });

  it("uploads chosen files into the set", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    expect($('[aria-label="Upload file to Logos"]')).not.toBeNull();
    await choose($<HTMLInputElement>('[data-testid="asset-set-input"]', set("Logos"))!, [
      file("Logo (dark).png", 3),
    ]);
    expect(api.put).toHaveBeenCalledWith("assets/Logos/Logo -dark.png", "BwcH");
    expect(api.listing.refresh).toHaveBeenCalled();
  });

  it("uploads dropped files into the set they land on, without replacing a namesake", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await drop(set("Other"), [file("hero.jpg", 2, "image/jpeg")]);
    expect(api.put).toHaveBeenCalledWith("assets/hero 2.jpg", "Bwc=");
  });

  it("checks types, sizes and room before sending anything", async () => {
    const { api } = fakeFilesApi(FILES, { limits: { limitBytes: 100_000 } });
    render(api);
    const input = $<HTMLInputElement>('[data-testid="asset-set-input"]', set("Logos"))!;
    await choose(input, [file("notes.exe", 3, "application/octet-stream")]);
    expect($('[data-testid="assets-problem"]')!.textContent).toContain(
      "notes.exe is not a type a design system keeps.",
    );
    await choose(input, [file("poster.png", 11 * 1024 * 1024)]);
    expect($('[data-testid="assets-problem"]')!.textContent).toBe(
      "poster.png is 11 MB; one file can be at most 10 MB.",
    );
    await choose(input, [file("photo.png", 20_000)]);
    expect($('[data-testid="assets-problem"]')!.textContent).toBe(
      "There isn't room: these files need 20 KB and 7 KB is left.",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("starts a new set from its first files", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click(button("New set")!);
    const dialog = $('[data-testid="new-set-dialog"]')!;
    expect($<HTMLInputElement>('input[placeholder="e.g. Logos"]', dialog)).not.toBeNull();
    await click(button("Create set", dialog)!);
    expect(dialog.textContent).toContain("A set needs a name.");
    const name = $<HTMLInputElement>('input[placeholder="e.g. Logos"]', dialog)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Logos");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await choose($<HTMLInputElement>('[data-testid="new-set-input"]', dialog)!, [
      file("check.svg", 3, "image/svg+xml"),
    ]);
    await click(button("Create set", dialog)!);
    expect(dialog.textContent).toContain("There is already a Logos set.");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Icons");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Create set", dialog)!);
    for (let index = 0; index < 5; index += 1) await flush();
    expect(api.put).toHaveBeenCalledWith("assets/Icons/check.svg", "BwcH");
    expect($('[data-testid="new-set-dialog"]')).toBeNull();
  });

  it("truncates a long set behind Show all", async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      path: `assets/Icons/icon-${index + 1}.svg`,
      text: "<svg/>",
    }));
    const { api } = fakeFilesApi(many);
    render(api);
    expect(set("Icons").querySelectorAll('[data-testid="asset-row"]')).toHaveLength(8);
    await click(button("Show all 11 files")!);
    expect(set("Icons").querySelectorAll('[data-testid="asset-row"]')).toHaveLength(11);
  });

  it("confirms before deleting a set, then removes every file in it", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api);
    await click($('[aria-label="Delete the Logos set"]')!);
    const confirm = $('[data-testid="confirm-delete"]')!;
    expect(confirm.textContent).toContain(REMOVE_ASSETS_TEXT);
    expect(REMOVE_ASSETS_TEXT).toBe(
      "The files are deleted from assets/. Anything linking to them will break.",
    );
    await click(button("Remove", confirm)!);
    expect(api.remove.mock.calls.map(([path]) => path)).toEqual([
      "assets/Logos/mark.svg",
      "assets/Logos/wordmark.png",
    ]);
  });

  it("is read-only without edit rights", async () => {
    const { api } = fakeFilesApi(FILES);
    render(api, false);
    expect(button("New set")).toBeNull();
    expect($('[aria-label="Upload file to Logos"]')).toBeNull();
    await drop(set("Logos"), [file("x.png", 2)]);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("says when there are no assets yet", async () => {
    const { api } = fakeFilesApi([{ path: "README.md", text: "# Acme" }]);
    render(api);
    expect($('[data-testid="assets-empty"]')!.textContent).toContain("No files yet.");
    expect($('[data-testid="assets-storage"]')!.textContent).toBe(
      "Stored with this design system: 1 file · 6 B of 1024 MB used",
    );
  });
});
