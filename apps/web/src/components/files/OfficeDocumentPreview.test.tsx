// @vitest-environment jsdom

import {
  DesignError,
  EnvironmentId,
  type DesignPreviewDocumentResult,
  type DesignPreviewWorkbookResult,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  capabilities: { officeDocumentPreview: true } as Record<string, boolean> | undefined,
  query: { data: null, error: null, failure: null } as {
    data: unknown;
    error: string | null;
    failure: unknown;
  },
  asked: [] as unknown[],
  canWrite: true,
}));

vi.mock("~/i18n", () => ({
  useTx: () => (text: string) => text,
}));
vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["office-host", { environment: { capabilities: state.capabilities } }]]),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.asked.push(atom);
    return atom === null ? { data: null, error: null, failure: null } : state.query;
  },
}));
vi.mock("~/studio/design", () => ({
  design: {
    previewWorkbook: (target: unknown) => ({ previewWorkbook: target }),
    previewDocument: (target: unknown) => ({ previewDocument: target }),
  },
}));
vi.mock("../office/SheetView", () => ({
  SheetView: (props: { text: string; mode?: string }) => (
    <div data-sheet-view={props.mode ?? ""}>{props.text}</div>
  ),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock("../office/document/HostDocumentEditor", () => ({
  HostDocumentEditor: (props: { path: string; canWrite: boolean }) => (
    <div data-document-editor={props.canWrite ? "edit" : "read"}>{props.path}</div>
  ),
}));
vi.mock("./DeckPreview", () => ({
  FilePreviewCard: (props: { reason: string; name: string }) => (
    <div data-file-card={props.name}>{props.reason}</div>
  ),
}));

import {
  DocxDocumentView,
  HostDocumentPreview,
  HostWorkbookPreview,
} from "./OfficeDocumentPreview";

const environmentId = EnvironmentId.make("office-host");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.capabilities = { officeDocumentPreview: true };
  state.query = { data: null, error: null, failure: null };
  state.asked.length = 0;
  state.canWrite = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("HostWorkbookPreview", () => {
  it("renders SheetView with workbook JSON and note banner when features are omitted", async () => {
    const result: DesignPreviewWorkbookResult = {
      sheetJson: '{"v":1,"kind":"specwithcode.sheet","title":"Budget","tabs":[{"name":"Q1","cells":{"A1":"Rev"}}]}',
      sheetCount: 2,
      truncatedSheets: 1,
      unsupportedFeatures: ["Pivot tables", "Charts"],
    };
    state.query = { data: result, error: null, failure: null };

    await act(() =>
      root.render(
        <HostWorkbookPreview
          environmentId={environmentId}
          name="budget.xlsx"
          path="/repo/budget.xlsx"
        />,
      ),
    );

    expect(container.querySelector("[data-sheet-view]")?.textContent).toBe(result.sheetJson);
    expect(container.textContent).toContain("Pivot tables");
    expect(container.textContent).toContain("truncated");
  });

  it("shows fallback card when host lacks officeDocumentPreview capability", async () => {
    state.capabilities = { officeDocumentPreview: false };

    await act(() =>
      root.render(
        <HostWorkbookPreview
          environmentId={environmentId}
          name="budget.xlsx"
          path="/repo/budget.xlsx"
        />,
      ),
    );

    expect(state.asked[0]).toBeNull();
    expect(container.querySelector("[data-file-card='budget.xlsx']")).not.toBeNull();
  });

  it("shows failure reason when preview RPC returns a DesignError", async () => {
    state.query = {
      data: null,
      error: "too_large",
      failure: new DesignError({
        code: "too_large",
        detail: "Workbook is over the 20 MB preview limit.",
      }),
    };

    await act(() =>
      root.render(
        <HostWorkbookPreview
          environmentId={environmentId}
          name="huge.xlsx"
          path="/repo/huge.xlsx"
        />,
      ),
    );

    expect(container.querySelector("[data-file-card='huge.xlsx']")?.textContent).toContain("20 MB");
  });
});

describe("HostDocumentPreview & DocxDocumentView", () => {
  it("renders headings, styled runs, lists, tables, images, and fragment anchors", async () => {
    const doc: DesignPreviewDocumentResult = {
      blocks: [
        { type: "heading", level: 1, id: "intro", runs: [{ text: "Executive Summary" }] },
        {
          type: "paragraph",
          runs: [
            { text: "Growth hit " },
            { text: "42%", bold: true, italic: true },
            { text: " — see " },
            { text: "Appendix", anchor: "appendix" },
          ],
        },
        {
          type: "list",
          ordered: true,
          items: [{ runs: [{ text: "Step one" }] }, { runs: [{ text: "Step two" }] }],
        },
        {
          type: "table",
          rows: [
            { cells: [{ header: true, runs: [{ text: "Region" }] }] },
            { cells: [{ runs: [{ text: "EMEA" }] }] },
          ],
        },
        { type: "image", asset: "img_1", alt: "Chart" },
        { type: "paragraph", id: "appendix", runs: [{ text: "Appendix text" }] },
      ],
      images: { img_1: "data:image/png;base64,AAAA" },
      imagesOmitted: 0,
      truncated: false,
      unsupportedFeatures: ["Comments"],
    };
    state.query = { data: doc, error: null, failure: null };

    await act(() =>
      root.render(
        <HostDocumentPreview
          environmentId={environmentId}
          name="brief.docx"
          path="/repo/brief.docx"
        />,
      ),
    );

    expect(container.querySelector("h1")?.textContent).toBe("Executive Summary");
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("em")).not.toBeNull();
    // A link scrolls to its bookmark inside the preview and leaves the address alone.
    const link = container.querySelector<HTMLAnchorElement>("a[data-docx-link='appendix']")!;
    expect(link.textContent).toBe("Appendix");
    expect(link.getAttribute("href")).toBe("#docx-appendix");
    const target = container.querySelector<HTMLElement>("#docx-appendix")!;
    expect(target.textContent).toBe("Appendix text");
    let scrolled = 0;
    target.scrollIntoView = () => {
      scrolled += 1;
    };
    const before = window.location.hash;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(scrolled).toBe(1);
    expect(window.location.hash).toBe(before);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("th")?.textContent).toBe("Region");
    expect(container.querySelector("td")?.textContent).toBe("EMEA");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(container.textContent).toContain("Comments");
  });

  it("renders empty document message cleanly", async () => {
    const empty: DesignPreviewDocumentResult = {
      blocks: [],
      images: {},
      imagesOmitted: 0,
      truncated: false,
      unsupportedFeatures: [],
    };
    await act(() => root.render(<DocxDocumentView name="empty.docx" preview={empty} />));
    expect(container.textContent).toContain("no readable text blocks");
  });
});

describe("HostDocumentPreview with the Word editor", () => {
  it("opens the editor when the machine edits documents, read only without write access", async () => {
    state.capabilities = { officeDocumentPreview: true, officeDocumentEditing: true };
    await act(async () => {
      root.render(<HostDocumentPreview environmentId={environmentId} path="/p/a.docx" name="a.docx" />);
    });
    expect(container.querySelector("[data-document-editor]")?.getAttribute("data-document-editor")).toBe("edit");
    // The editor opens the file itself; the preview query is never asked.
    expect(state.asked.every((atom) => atom === null)).toBe(true);

    state.canWrite = false;
    await act(async () => {
      root.render(<HostDocumentPreview environmentId={environmentId} path="/p/b.docx" name="b.docx" />);
    });
    expect(container.querySelector("[data-document-editor]")?.getAttribute("data-document-editor")).toBe("read");
  });

  it("keeps the preview on a machine that cannot edit documents", async () => {
    state.capabilities = { officeDocumentPreview: true };
    await act(async () => {
      root.render(<HostDocumentPreview environmentId={environmentId} path="/p/a.docx" name="a.docx" />);
    });
    expect(container.querySelector("[data-document-editor]")).toBeNull();
    expect(state.asked.some((atom) => atom !== null)).toBe(true);
  });
});
