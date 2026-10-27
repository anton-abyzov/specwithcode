// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FontFilesList, UploadFontButton, useFontUploadState } from "./FontFiles";
import type { SystemFilesApi } from "./systemFilesApi";
import { fakeFilesApi } from "./testFakes";

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
});

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);

function Harness({
  api,
  onPick,
  canEdit = true,
}: {
  api: SystemFilesApi;
  onPick?: () => void;
  canEdit?: boolean;
}) {
  const fonts = useFontUploadState(api, canEdit);
  return (
    <>
      <UploadFontButton fonts={fonts} {...(onPick === undefined ? {} : { onPick })} />
      <FontFilesList fonts={fonts} />
      {fonts.input}
    </>
  );
}

async function choose(file: File) {
  const input = $<HTMLInputElement>('[data-testid="font-upload-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("font uploads", () => {
  it("waits for the font list, so a stored font is never replaced blind", async () => {
    const { api } = fakeFilesApi([{ path: "fonts/Inter.woff2" }], {
      listing: { data: null, isPending: true },
    });
    const onPick = vi.fn();
    act(() => root.render(<Harness api={api as SystemFilesApi} onPick={onPick} />));
    const button = $<HTMLButtonElement>('[data-testid="font-upload"]')!;
    // Still reachable, so pressing it can say why nothing opens.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.title).toBe("Loading the font list…");
    const input = $<HTMLInputElement>('[data-testid="font-upload-input"]')!;
    const picker = vi.spyOn(input, "click");
    act(() => button.click());
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(picker).not.toHaveBeenCalled();
    expect($('[data-testid="font-upload-message"]')!.textContent).toContain("hasn't loaded");
    // Once the list arrives, the note about the press goes.
    const { api: loaded } = fakeFilesApi([{ path: "fonts/Inter.woff2" }]);
    act(() =>
      root.render(
        <Harness api={{ ...api, listing: loaded.listing } as SystemFilesApi} onPick={onPick} />,
      ),
    );
    expect($('[data-testid="font-upload-message"]')).toBeNull();
    // Files that reach the queue without a list are refused, and the note stays.
    act(() => root.render(<Harness api={api as SystemFilesApi} onPick={onPick} />));
    await choose(new File(["x"], "Inter.woff2"));
    expect(api.put).not.toHaveBeenCalled();
    expect($('[data-testid="font-upload-message"]')!.textContent).toContain("hasn't loaded");
  });

  it("says why when the list could not load", () => {
    const { api } = fakeFilesApi([], {
      listing: { data: null, error: "Couldn't list the files." },
    });
    act(() => root.render(<Harness api={api as SystemFilesApi} />));
    expect($<HTMLButtonElement>('[data-testid="font-upload"]')!.title).toBe(
      "Couldn't list the files.",
    );
    expect($('[role="alert"]')!.textContent).toBe("Couldn't list the files.");
  });

  it("shows a viewer no listing error, since a viewer cannot upload", () => {
    const { api } = fakeFilesApi([], {
      listing: { data: null, error: "Couldn't list the files." },
    });
    act(() => root.render(<Harness api={api as SystemFilesApi} canEdit={false} />));
    expect($('[data-testid="font-upload"]')).toBeNull();
    expect($('[role="alert"]')).toBeNull();
  });

  it("runs onPick before the picker, and keeps a stored font by adding a copy", async () => {
    const { api } = fakeFilesApi([{ path: "fonts/Inter.woff2" }]);
    const onPick = vi.fn();
    act(() => root.render(<Harness api={api as SystemFilesApi} onPick={onPick} />));
    act(() => $<HTMLButtonElement>('[data-testid="font-upload"]')!.click());
    expect(onPick).toHaveBeenCalledTimes(1);
    await choose(new File(["x"], "Inter.woff2"));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0]![0]).toMatch(/^fonts\/Inter.+\.woff2$/);
    expect(api.put.mock.calls[0]![0]).not.toBe("fonts/Inter.woff2");
  });
});
