// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROJECTS, SYSTEMS } from "../systems/fixtureData";
import { CreationRow } from "./CreationRow";
import {
  canImportDecks,
  deckTitleFromFile,
  NotImportedDialog,
  pptxFileProblem,
} from "./deckImport";
import { availableCreationKinds } from "./galleryModel";
import { NewDesignDialog, type NewDesignRequest } from "./NewDesignDialog";

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

const pick = (input: HTMLInputElement, file: File) =>
  act(() => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

const pptx = (name = "Q3 review.pptx") =>
  new File([new Uint8Array([0x50, 0x4b, 3, 4])], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });

const buttonNamed = (text: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === text);

describe("Import PowerPoint entry (1051 AC-03)", () => {
  it("the capability gate: only servers that advertise designDeckImport import decks", () => {
    expect(canImportDecks({ designDeckImport: true })).toBe(true);
    expect(canImportDecks({})).toBe(false);
    expect(canImportDecks(undefined)).toBe(false);
  });

  it("Make something new hides the entry without the capability and offers it next to Slides with it", async () => {
    act(() =>
      root.render(
        <CreationRow
          kinds={availableCreationKinds()}
          disabledReason={() => null}
          onCreate={vi.fn()}
        />,
      ),
    );
    expect(document.querySelector("[data-testid=design-import-pptx]")).toBeNull();

    const onImportSlides = vi.fn();
    act(() =>
      root.render(
        <CreationRow
          kinds={availableCreationKinds()}
          disabledReason={() => null}
          onCreate={vi.fn()}
          onImportSlides={onImportSlides}
        />,
      ),
    );
    const entry = document.querySelector<HTMLButtonElement>("[data-testid=design-import-pptx]")!;
    expect(entry.textContent).toContain("Import PowerPoint…");
    // It sits with the Slides tile.
    expect(entry.closest("li")?.querySelector('[data-kind="slides"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>(
      "[data-testid=design-import-pptx-input]",
    )!;
    expect(input.accept).toContain(".pptx");
    const file = pptx();
    pick(input, file);
    expect(onImportSlides).toHaveBeenCalledWith(file);
  });

  it("New slides hides Import PowerPoint… when the server cannot import", async () => {
    act(() =>
      root.render(
        <NewDesignDialog
          kind="slides"
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={vi.fn(async () => null)}
        />,
      ),
    );
    await flush();
    expect(document.querySelector("[data-testid=import-pptx]")).toBeNull();
  });

  it("New slides imports the picked deck into the chosen owner and system", async () => {
    const onCreate = vi.fn(async (_request: NewDesignRequest) => null);
    const onImport = vi.fn(async (_request: NewDesignRequest, _file: File) => null);
    act(() =>
      root.render(
        <NewDesignDialog
          kind="slides"
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={onCreate}
          onImport={onImport}
        />,
      ),
    );
    await flush();
    expect(buttonNamed("Import PowerPoint…")).toBeDefined();
    const file = pptx();
    pick(document.querySelector<HTMLInputElement>("[data-testid=import-pptx-input]")!, file);
    await flush();
    const dialog = document.querySelector("[data-testid=new-design-dialog]")!;
    expect(dialog.textContent).toContain("Import PowerPoint");
    expect(document.querySelector("[data-testid=import-pptx-file]")?.textContent).toBe(
      "Q3 review.pptx",
    );
    await act(async () => buttonNamed("Import")!.click());
    await flush();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slides",
        owner: { kind: "playground" },
        title: "Q3 review",
        designSystem: null,
      }),
      file,
    );
  });

  it("opens ready to import a file picked from Make something new, and refuses .pptm", async () => {
    const onImport = vi.fn(async (_request: NewDesignRequest, _file: File) => null);
    act(() =>
      root.render(
        <NewDesignDialog
          kind="slides"
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={vi.fn(async () => null)}
          onImport={onImport}
          initialFile={pptx("macro deck.pptm")}
        />,
      ),
    );
    await flush();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("macros");
    await act(async () => buttonNamed("Import")!.click());
    await flush();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("a plain design never offers the import", async () => {
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={vi.fn(async () => null)}
          onImport={vi.fn(async () => null)}
        />,
      ),
    );
    await flush();
    expect(document.querySelector("[data-testid=import-pptx]")).toBeNull();
  });

  it("lists what was not imported for each slide and opens the deck", async () => {
    const onOpenDeck = vi.fn();
    act(() =>
      root.render(
        <NotImportedDialog
          title="Q3 review"
          notImported={[
            { slide: 5, items: ['Shape (star5) "5-Point Star 4"'] },
            { slide: 6, items: ['Table "Table 2"'] },
          ]}
          onOpenDeck={onOpenDeck}
          onClose={vi.fn()}
        />,
      ),
    );
    await flush();
    const dialog = document.querySelector("[data-testid=deck-not-imported]")!;
    expect(dialog.textContent).toContain("Slide 5");
    expect(dialog.textContent).toContain('Table "Table 2"');
    expect(dialog.textContent).toContain("2 parts");
    act(() =>
      document.querySelector<HTMLButtonElement>("[data-testid=deck-not-imported-open]")!.click(),
    );
    expect(onOpenDeck).toHaveBeenCalled();
  });

  it("checks files before reading them", () => {
    expect(pptxFileProblem({ name: "deck.pptx", size: 10 })).toBeNull();
    expect(pptxFileProblem({ name: "deck.key", size: 10 })).toBe(
      "Choose a PowerPoint file (.pptx).",
    );
    expect(pptxFileProblem({ name: "deck.pptx", size: 51 * 1024 * 1024 })).toMatch(/50 MB/);
    expect(deckTitleFromFile("Launch.PPTX")).toBe("Launch");
  });
});
