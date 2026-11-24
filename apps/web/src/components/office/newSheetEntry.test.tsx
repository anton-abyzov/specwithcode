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
  onDisk: new Set<string>(),
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
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileReader: () => async (_env: unknown, _cwd: string, path: string) =>
    state.onDisk.has(path) ? { _tag: "contents", contents: "{}" } : { _tag: "gone" },
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

import type { ArtifactNewEntry } from "../studio/shell/ArtifactNewMenu";
import { newSheetPath, useNewSheetEntry } from "./newSheetEntry";

const environmentId = EnvironmentId.make("host");
const SHEET_NAME = (base: string) => new RegExp(`^\\.specweave/reports/${base}-[a-z0-9]+\\.sheet\\.json$`);
let root: Root;
let container: HTMLDivElement;
let entry: ArtifactNewEntry | null = null;

function Probe() {
  entry = useNewSheetEntry({
    environmentId,
    workspaceRoot: "/repo",
    taken: new Set([".specweave/reports/untitled-sheet.sheet.json"]),
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.canWrite = true;
  state.capabilities = { officeWorkbookEdit: true };
  state.calls.length = 0;
  state.toasts.length = 0;
  state.onDisk.clear();
  entry = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<Probe />));

describe("the Sheet entry in the New menu", () => {
  it("names a new sheet after the ones already there", () => {
    const ids = ["aaaaaa", "bbbbbb"];
    const next = () => ids.shift()!;
    expect(newSheetPath("Untitled sheet", new Set([".specweave/reports/untitled-sheet-aaaaaa.sheet.json"]), next)).toBe(
      ".specweave/reports/untitled-sheet-bbbbbb.sheet.json",
    );
    expect(newSheetPath("Untitled sheet", new Set())).toMatch(/^\.specweave\/reports\/untitled-sheet-[a-z0-9]+\.sheet\.json$/);
  });

  it("writes a blank sheet into the output folder and returns it to open", async () => {
    await render();
    const created = await entry!.create();
    expect(state.calls[0]?.command).toBe("writeFile");
    expect(state.calls[0]?.request.input.relativePath).toMatch(SHEET_NAME("untitled-sheet"));
    const parsed = parseSheetDocument(state.calls[0]!.request.input.contents!);
    expect(parsed.ok && parsed.document.tabs[0]?.name).toBe("Sheet1");
    expect(created).toEqual({ path: state.calls[0]?.request.input.relativePath, title: "Untitled sheet" });
    expect(entry!.imports?.extensions).toEqual(["xlsx", "csv", "tsv"]);
  });

  it("imports a .csv in the browser with typed values", async () => {
    await render();
    const created = await entry!.imports!.run(new File(["Item,Cost\nTea,$4.50\n"], "Costs.csv", { type: "text/csv" }));
    const written = parseSheetDocument(state.calls[0]!.request.input.contents!);
    expect(written.ok && written.document.tabs[0]?.cells).toEqual({ A1: "Item", B1: "Cost", A2: "Tea", B2: 4.5 });
    expect(created?.path).toMatch(SHEET_NAME("costs"));
    expect(created?.title).toBe("Costs");
  });

  it("converts a .xlsx on the host and says what it left out", async () => {
    await render();
    await entry!.imports!.run(new File([new Uint8Array([80, 75, 3, 4])], "Budget.xlsx"));
    expect(state.calls[0]?.command).toBe("importWorkbook");
    expect(state.calls[0]?.request.input).toEqual({ title: "Budget", data: "UEsDBA==" });
    expect(state.calls[1]?.request.input.relativePath).toMatch(SHEET_NAME("budget"));
    expect(JSON.stringify(state.toasts)).toContain("Left out: Charts.");
  });

  it("never writes over a Sheet the shelf has not listed yet", async () => {
    const random = vi.spyOn(Math, "random");
    // 0.5 -> "i", so the first name is taken on disk and the second is free.
    random.mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
    const first = `.specweave/reports/untitled-sheet-${(0.5).toString(36).slice(2, 8)}.sheet.json`;
    state.onDisk.add(first);
    await render();
    const created = await entry!.create();
    random.mockRestore();
    expect(created?.path).not.toBe(first);
    expect(state.calls.map((call) => call.request.input.relativePath)).toEqual([created?.path]);
  });

  it("offers nothing without file write", async () => {
    state.canWrite = false;
    await render();
    expect(entry).toBeNull();
  });
});
