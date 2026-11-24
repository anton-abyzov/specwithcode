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
});
