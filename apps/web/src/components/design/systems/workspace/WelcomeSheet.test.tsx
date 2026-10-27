// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeFilesApi } from "./testFakes";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/studio/designSystemImport", () => ({ designSystemImport: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));
vi.mock("../useOwnerProjects", () => ({ useOwnerProjects: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));

const { brandFolder, brandSummary, WelcomeSheetView } = await import("./WelcomeSheet");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

function render(canEdit = true) {
  const { api } = fakeFilesApi([]);
  const onImport = vi.fn();
  const onChanged = vi.fn();
  act(() =>
    root.render(
      <WelcomeSheetView
        canEdit={canEdit}
        systemName="Acme"
        api={api}
        onImport={onImport}
        onChanged={onChanged}
      />,
    ),
  );
  return { api, onImport, onChanged };
}

describe("WelcomeSheet", () => {
  it("routes brand files: fonts to fonts/, Markdown to docs/, the rest to assets/Brand", () => {
    expect(brandFolder("Inter.woff2")).toBe("fonts");
    expect(brandFolder("guidelines.md")).toBe("docs");
    expect(brandFolder("logo.svg")).toBe("assets/Brand");
    expect(brandFolder("brand-book.pdf")).toBe("assets/Brand");
    expect(brandSummary(["assets/Brand/a.png", "assets/Brand/b.svg", "fonts/Inter.woff2"])).toBe(
      "Added 3 files: 2 to Assets, 1 to Typography.",
    );
  });

  it("offers three ways to start", async () => {
    const { onImport } = render();
    expect($('[data-testid="welcome-sheet"]')!.textContent).toContain("Not sure where to start?");
    for (const title of ["Import from a repository", "Upload brand files", "Describe it"])
      expect($('[data-testid="welcome-sheet"]')!.textContent).toContain(title);
    await act(async () => $<HTMLButtonElement>('[data-testid="welcome-import"]')!.click());
    expect(onImport).toHaveBeenCalledTimes(1);
    const describe = $<HTMLButtonElement>('[data-testid="welcome-describe"]')!;
    expect(describe.getAttribute("aria-expanded")).toBe("false");
    await act(async () => describe.click());
    const panel = $('[data-testid="welcome-describe-panel"]')!;
    expect(panel.textContent).toContain("Fill in the Acme design system");
    expect(describe.getAttribute("aria-expanded")).toBe("true");
    expect(describe.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("uploads brand files into assets/ and fonts/", async () => {
    const { api, onChanged } = render();
    const input = $<HTMLInputElement>('[data-testid="welcome-upload-input"]')!;
    const files = [
      new File([new Uint8Array([1, 2, 3])], "Logo.svg", { type: "image/svg+xml" }),
      new File([new Uint8Array([4])], "Inter.woff2", { type: "font/woff2" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    for (let index = 0; index < 5; index += 1) await flush();
    expect(api.put.mock.calls.map(([path]) => path)).toEqual([
      "assets/Brand/Logo.svg",
      "fonts/Inter.woff2",
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect($('[data-testid="welcome-message"]')!.textContent).toBe(
      "Added 2 files: 1 to Assets, 1 to Typography.",
    );
  });

  it("uploads nothing until the file list has loaded, so no stored file is replaced", async () => {
    const { api } = fakeFilesApi([{ path: "fonts/Inter.woff2" }], {
      listing: { data: null, isPending: true },
    });
    act(() =>
      root.render(<WelcomeSheetView canEdit systemName="Acme" api={api} onImport={vi.fn()} />),
    );
    const input = $<HTMLInputElement>('[data-testid="welcome-upload-input"]')!;
    const picker = vi.spyOn(input, "click");
    await act(async () => $<HTMLButtonElement>('[data-testid="welcome-upload"]')!.click());
    expect(picker).not.toHaveBeenCalled();
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array([4])], "Inter.woff2")],
      configurable: true,
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(api.put).not.toHaveBeenCalled();
    expect($('[data-testid="welcome-message"]')!.textContent).toContain("hasn't loaded");
    // The refused files keep their note after the list arrives.
    const { api: loaded } = fakeFilesApi([{ path: "fonts/Inter.woff2" }]);
    act(() =>
      root.render(
        <WelcomeSheetView
          canEdit
          systemName="Acme"
          api={{ ...api, listing: loaded.listing }}
          onImport={vi.fn()}
        />,
      ),
    );
    expect($('[data-testid="welcome-message"]')!.textContent).toContain("hasn't loaded");
  });

  it("keeps the basics panel, and focus, when adding them fails", async () => {
    const { api } = fakeFilesApi([]);
    const onStart = vi.fn(async () => false);
    act(() =>
      root.render(
        <WelcomeSheetView
          canEdit
          systemName="Acme"
          api={api}
          onImport={vi.fn()}
          onStart={onStart}
        />,
      ),
    );
    const start = $<HTMLButtonElement>('[data-testid="welcome-start"]')!;
    await act(async () => start.click());
    expect(start.getAttribute("aria-expanded")).toBe("true");
    const add = $<HTMLButtonElement>('[data-testid="welcome-start-add"]')!;
    add.focus();
    await act(async () => add.click());
    await flush();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect($('[data-testid="welcome-start-panel"]')).not.toBeNull();
    expect(document.activeElement).toBe(add);
    let finish: (added: boolean) => void = () => undefined;
    onStart.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    await act(async () => add.click());
    // While it saves, the button says so; another press adds nothing.
    expect(add.textContent).toBe("Adding…");
    expect(add.getAttribute("aria-busy")).toBe("true");
    await act(async () => add.click());
    expect(onStart).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    await flush();
    expect($('[data-testid="welcome-start-panel"]')).toBeNull();
  });

  it("refuses a file type a design system does not keep", async () => {
    const { api } = render();
    const input = $<HTMLInputElement>('[data-testid="welcome-upload-input"]')!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "tokens.zip")],
      configurable: true,
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect($('[data-testid="welcome-message"]')!.textContent).toContain(
      "tokens.zip is not a type a design system keeps.",
    );
    expect(api.put).not.toHaveBeenCalled();
  });

  it("keeps only the describe guidance without edit rights", () => {
    render(false);
    expect($('[data-testid="welcome-import"]')).toBeNull();
    expect($('[data-testid="welcome-upload"]')).toBeNull();
    expect($('[data-testid="welcome-describe"]')).not.toBeNull();
  });
});
