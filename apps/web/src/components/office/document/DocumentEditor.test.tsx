// @vitest-environment jsdom

import type { OfficeDocument } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../ui/menu", () => ({
  Menu: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuTrigger: (props: { children: unknown }) => <button type="button">{props.children as never}</button>,
  MenuPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuItem: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuSeparator: () => null,
}));

import { DocumentEditor, type DocumentSaveOutcome } from "./DocumentEditor";
import { hasDraftOnlyInMemory, unsavedDraft } from "./documentDrafts";

const DOC: OfficeDocument = { blocks: [{ type: "paragraph", runs: [{ text: "Hello" }] }] };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.useRealTimers();
});

function typeInto(text: string) {
  const page = container.querySelector(".office-doc-page") as HTMLElement & {
    editor?: { commands: { insertContent: (value: string) => boolean } };
  };
  // The editor's own command, as a keystroke would run it.
  page.editor!.commands.insertContent(text);
}

describe("DocumentEditor saves", () => {
  it("saves what was typed when it closes before autosave runs", async () => {
    const onSave = vi.fn(async (): Promise<DocumentSaveOutcome> => "saved");
    await act(async () => {
      root.render(<DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={60_000} />);
    });
    await act(async () => typeInto(" world"));
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(onSave).toHaveBeenCalledTimes(1);
    const [document, options] = onSave.mock.calls[0] as unknown as [OfficeDocument, { force: boolean }];
    expect(JSON.stringify(document)).toContain("world");
    expect(options.force).toBe(false);
  });

  it("tries a failed save again with the revision check, never as a forced write", async () => {
    const outcomes: DocumentSaveOutcome[] = ["failed", "conflict"];
    const onSave = vi.fn(async (): Promise<DocumentSaveOutcome> => outcomes.shift() ?? "saved");
    await act(async () => {
      root.render(<DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={10} />);
    });
    await act(async () => typeInto("!"));
    await act(async () => new Promise((done) => setTimeout(done, 50)));
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(onSave.mock.calls.map((call) => (call as unknown as [unknown, { force: boolean }])[1].force)).toEqual([
      false,
      false,
    ]);
    // A newer file on disk turns the retry into the conflict banner.
    expect(container.querySelector("[data-document-conflict]")).not.toBeNull();
  });

  it("keeps edits a close-time save could not write, and brings them back", async () => {
    const onSave = vi.fn(async (): Promise<DocumentSaveOutcome> => "conflict");
    await act(async () => {
      root.render(
        <DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={60_000} draftKey="host:a" />,
      );
    });
    await act(async () => typeInto(" kept"));
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={60_000} draftKey="host:a" />,
      );
    });
    expect(container.querySelector(".office-doc-page")?.textContent).toContain("kept");
    expect(container.querySelector('[data-save-state="dirty"]')).not.toBeNull();
    // Reload latest gives the draft up.
    await act(async () => {
      root.render(
        <DocumentEditor
          key="other"
          name="a.docx"
          document={DOC}
          onSave={async () => "conflict"}
          autosaveMs={10}
          draftKey="host:a"
        />,
      );
    });
    await act(async () => new Promise((done) => setTimeout(done, 50)));
    const reload = container.querySelector("[data-document-conflict-reload]") as HTMLButtonElement;
    await act(async () => reload.click());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<DocumentEditor name="a.docx" document={DOC} onSave={onSave} draftKey="host:a" />);
    });
    expect(container.querySelector(".office-doc-page")?.textContent).not.toContain("kept");
  });

  it("keeps a draft in the window's storage, so a refresh or quit loses nothing", async () => {
    const onSave = vi.fn(async (): Promise<DocumentSaveOutcome> => "conflict");
    await act(async () => {
      root.render(
        <DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={60_000} draftKey="host:b" />,
      );
    });
    await act(async () => typeInto(" stored"));
    await act(async () => root.unmount());
    root = createRoot(container);
    const raw = [...Array(window.localStorage.length).keys()]
      .map((index) => window.localStorage.getItem(window.localStorage.key(index)!) ?? "")
      .join("");
    expect(raw).toContain("stored");
    expect(hasDraftOnlyInMemory()).toBe(false);
    // Closing the window now needs no prompt: the draft is kept.
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(JSON.stringify(unsavedDraft("host:b"))).toContain("stored");
  });

  it("asks before the window closes when the draft could not be stored", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      const onSave = vi.fn(async (): Promise<DocumentSaveOutcome> => "conflict");
      await act(async () => {
        root.render(
          <DocumentEditor name="a.docx" document={DOC} onSave={onSave} autosaveMs={60_000} draftKey="host:c" />,
        );
      });
      await act(async () => typeInto(" big"));
      await act(async () => root.unmount());
      root = createRoot(container);
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });
});
