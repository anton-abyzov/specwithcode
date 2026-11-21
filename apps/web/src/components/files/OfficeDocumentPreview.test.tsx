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
    expect(container.querySelector("a[href='#appendix']")?.textContent).toBe("Appendix");
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
