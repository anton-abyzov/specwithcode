// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  FolderCopyRow,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { CopyClassPicker, CopyPlanPreview } from "./HandoffCopyPreview";
import { DEFAULT_COPY_SELECTION, EXACT_COPY_SELECTION } from "../../studio/folderCopy";

const total = (files: number, bytes: number) => ({ files, bytes });
const summary: FolderCopySourceSummary = {
  totals: {
    repository: total(10, 5_000_000),
    tracked: total(100, 2_000_000),
    untracked: total(5, 1_000),
    ignoredData: total(3, 16_000_000_000),
    rebuildable: total(9000, 900_000_000),
    secret: total(2, 300),
  },
  repositories: [],
  secretFiles: [{ path: ".env", size: 120 }],
  linksOutside: 1,
  warnings: [],
};
const row = (overrides: Partial<FolderCopyRow> = {}): FolderCopyRow => ({
  id: "repo:api",
  kind: "repository",
  path: "repositories/api",
  status: "diverged",
  detail: "",
  filesToMove: 3,
  bytesToMove: 3000,
  bytesPresent: 0,
  choices: [],
  decision: null,
  needsDecision: false,
  conflicts: [],
  moreConflicts: 0,
  cloneAvailable: false,
  clone: false,
  ...overrides,
});
const status = (rows: ReadonlyArray<FolderCopyRow>): FolderCopyStatus => ({
  operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
  sourceEnvironmentId: "m4" as never,
  sourceProjectId: "source" as never,
  sourceMachine: "M4",
  mode: "copy-only",
  targetFolder: "/target",
  title: "Project",
  selection: [...DEFAULT_COPY_SELECTION],
  mirror: false,
  state: "previewed",
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [...rows],
  totals: { filesToMove: 3, bytesToMove: 3000, bytesPresent: 0, decisionsNeeded: 1 },
  checks: [],
  warnings: [],
  unstable: [],
  committed: false,
  projectId: null,
  createdAt: "2026-10-19T20:00:00.000Z",
  updatedAt: "2026-10-19T20:00:00.000Z",
});

let root: Root;
let container: HTMLDivElement;
const render = (node: ReactNode) => act(async () => root.render(node));
const checkbox = (slot: string, klass?: string) => {
  const host = container.querySelector(
    klass ? `[data-slot="${slot}"][data-class="${klass}"]` : `[data-slot="${slot}"]`,
  );
  const element = host?.querySelector<HTMLElement>('[role="checkbox"]');
  if (!element) throw new Error(`Missing checkbox ${slot} ${klass ?? ""}`);
  return element;
};
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("copy class picker", () => {
  it("selects everything but rebuildable folders by default and never offers secrets", async () => {
    const onChange = vi.fn();
    await render(
      <CopyClassPicker
        summary={summary}
        selection={DEFAULT_COPY_SELECTION}
        onChange={onChange}
        disabled={false}
      />,
    );
    expect(checkbox("copy-class", "tracked").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("copy-class", "ignoredData").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("copy-class", "rebuildable").getAttribute("aria-checked")).toBe("false");
    const secret = checkbox("copy-class", "secret");
    expect(secret.getAttribute("aria-checked")).toBe("false");
    expect(secret.getAttribute("aria-disabled") ?? secret.getAttribute("data-disabled")).not.toBe(
      null,
    );
    await act(async () => secret.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Selected: 16.0 GB in 118 files.");
    expect(container.textContent).toContain("outside the folder");
  });

  it("switches to an exact copy and back", async () => {
    const onChange = vi.fn();
    await render(
      <CopyClassPicker
        summary={summary}
        selection={DEFAULT_COPY_SELECTION}
        onChange={onChange}
        disabled={false}
      />,
    );
    await act(async () => checkbox("copy-exact").click());
    expect(onChange).toHaveBeenLastCalledWith(EXACT_COPY_SELECTION);
    await render(
      <CopyClassPicker
        summary={summary}
        selection={EXACT_COPY_SELECTION}
        onChange={onChange}
        disabled={false}
      />,
    );
    expect(checkbox("copy-class", "rebuildable").getAttribute("aria-checked")).toBe("true");
    await act(async () => checkbox("copy-exact").click());
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_COPY_SELECTION);
  });
});

describe("copy plan preview", () => {
  it("answers every conflict in a row, including unlisted ones, with one choice", async () => {
    const onDecide = vi.fn();
    await render(
      <CopyPlanPreview
        status={status([
          row({
            status: "conflict",
            conflicts: [
              {
                id: "repo:api:a.txt",
                path: "a.txt",
                reason: "differs",
                choices: ["keep-mine", "take-theirs", "keep-both"],
                decision: null,
              },
              {
                id: "repo:api:b",
                path: "b",
                reason: "type-differs",
                choices: ["keep-mine", "take-theirs"],
                decision: null,
              },
            ],
            moreConflicts: 40,
          }),
        ])}
        onDecide={onDecide}
        onClone={vi.fn()}
        disabled={false}
      />,
    );
    expect(container.textContent).toContain("42 files differ on both machines");
    expect(container.textContent).toContain("40 more not listed");
    // "Keep both" is not valid for every conflict, so it is not offered for the row.
    expect(() => button("All: Keep both (source copy beside it)")).toThrow();
    await act(async () => button("All: Keep this machine’s version").click());
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ "all:repo:api": "keep-mine" });
  });

  it("names the machines in each choice and titles the root row with the project", async () => {
    await render(
      <CopyPlanPreview
        status={status([
          row({
            path: ".",
            needsDecision: true,
            choices: ["keep-mine", "leave-both"],
            conflicts: [
              {
                id: "file:notes/plan.md",
                path: "notes/plan.md",
                reason: "differs",
                choices: ["keep-mine", "take-theirs", "keep-both"],
                decision: null,
              },
            ],
          }),
        ])}
        onDecide={vi.fn()}
        onClone={vi.fn()}
        disabled={false}
        machines={{ here: "Minis", source: "M4" }}
        rootLabel="review"
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("review");
    expect(text).not.toMatch(/^\.|Project root/u);
    expect(text).toContain("Keep Minis’s version");
    expect(text).toContain("Take M4’s version (back up Minis’s)");
    expect(text).toContain("Keep both (M4’s copy beside it)");
    expect(text).not.toContain("this machine");
    expect(container.querySelector('[aria-label="Choice for review"]')).not.toBeNull();
  });

  it("offers a clone per clean repository", async () => {
    const onClone = vi.fn();
    await render(
      <CopyPlanPreview
        status={status([row({ status: "new", cloneAvailable: true })])}
        onDecide={vi.fn()}
        onClone={onClone}
        disabled={false}
      />,
    );
    await act(async () => checkbox("copy-clone").click());
    expect(onClone).toHaveBeenCalledExactlyOnceWith("repo:api", true);
  });
});
