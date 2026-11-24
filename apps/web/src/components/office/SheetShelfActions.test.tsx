// @vitest-environment jsdom
import { EnvironmentId } from "@specweave-studio/contracts";
import { parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canWrite: true,
  capabilities: { officeWorkbookEdit: true } as Record<string, boolean>,
  calls: [] as Array<{ command: string; request: { input: Record<string, string> } }>,
  toasts: [] as unknown[],
}));

vi.mock("~/i18n", () => ({
  useTx: () => (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] ?? match),
}));
vi.mock("../../i18n", () => ({
  useTx: () => (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] ?? match),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => state.canWrite }));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map([["host", { environment: { capabilities: state.capabilities } }]]),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: "writeFile" } }));
vi.mock("~/studio/design", () => ({ design: { importWorkbook: "importWorkbook" } }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: (toast: unknown) => state.toasts.push(toast) },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (request: { input: Record<string, string> }) => {
    state.calls.push({ command, request });
    if (command === "importWorkbook") {
      return {
        _tag: "Success",
        value: {
          sheetJson: JSON.stringify({ v: 1, kind: "sheet", title: "Budget", tabs: [{ name: "Q1", cells: { A1: 1 } }] }),
          sheetCount: 1,
          truncatedSheets: 0,
          unsupportedFeatures: ["Charts"],
        },
      };
    }
    return { _tag: "Success", value: { relativePath: request.input.relativePath } };
  },
}));

import { SheetShelfActions, newSheetPath } from "./SheetShelfActions";

const environmentId = EnvironmentId.make("host");
let root: Root;
let container: HTMLDivElement;
const opened: Array<[string, string]> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.canWrite = true;
  state.capabilities = { officeWorkbookEdit: true };
  state.calls.length = 0;
  state.toasts.length = 0;
  opened.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() =>
    root.render(
      <SheetShelfActions
        environmentId={environmentId}
        workspaceRoot="/repo"
        taken={new Set([".specweave/reports/untitled-sheet.sheet.json"])}
        onOpen={(path, title) => opened.push([path, title])}
      />,
    ),
  );

const upload = async (file: File) => {
  const input = container.querySelector<HTMLInputElement>("[data-shelf-import-input]")!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("sheet shelf actions", () => {
  it("names a new sheet after the ones already there", () => {
    expect(newSheetPath("Untitled sheet", new Set())).toBe(".specweave/reports/untitled-sheet.sheet.json");
    expect(newSheetPath("Untitled sheet", new Set([".specweave/reports/untitled-sheet.sheet.json"]))).toBe(
      ".specweave/reports/untitled-sheet-2.sheet.json",
    );
  });

  it("writes a blank sheet into the output folder and opens it", async () => {
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-shelf-new-sheet]")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(state.calls[0]?.command).toBe("writeFile");
    expect(state.calls[0]?.request.input.relativePath).toBe(".specweave/reports/untitled-sheet-2.sheet.json");
    const parsed = parseSheetDocument(state.calls[0]!.request.input.contents!);
    expect(parsed.ok && parsed.document.tabs[0]?.name).toBe("Sheet1");
    expect(opened).toEqual([[".specweave/reports/untitled-sheet-2.sheet.json", "Untitled sheet"]]);
  });

  it("imports a .csv in the browser with typed values", async () => {
    await render();
    await upload(new File(["Item,Cost\nTea,$4.50\n"], "Costs.csv", { type: "text/csv" }));
    const written = parseSheetDocument(state.calls[0]!.request.input.contents!);
    expect(written.ok && written.document.tabs[0]?.cells).toEqual({ A1: "Item", B1: "Cost", A2: "Tea", B2: 4.5 });
    expect(opened[0]).toEqual([".specweave/reports/costs.sheet.json", "Costs"]);
  });

  it("converts a .xlsx on the host and says what it left out", async () => {
    await render();
    await upload(new File([new Uint8Array([80, 75, 3, 4])], "Budget.xlsx"));
    expect(state.calls[0]?.command).toBe("importWorkbook");
    expect(state.calls[0]?.request.input).toEqual({ title: "Budget", data: "UEsDBA==" });
    expect(state.calls[1]?.request.input.relativePath).toBe(".specweave/reports/budget.sheet.json");
    expect(JSON.stringify(state.toasts)).toContain("Left out: Charts.");
  });

  it("offers nothing without file write", async () => {
    state.canWrite = false;
    await render();
    expect(container.querySelector("[data-shelf-new-sheet]")).toBeNull();
  });
});
