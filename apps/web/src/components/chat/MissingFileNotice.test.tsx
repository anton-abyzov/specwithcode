import { EnvironmentId, ProjectReadFileError } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  folders: new Map<string, ReadonlyArray<string>>(),
}));
vi.mock("./useExistingFileLinks", () => ({
  folderEntriesOnHost: async (_environmentId: unknown, folder: string) => {
    const names = state.folders.get(folder);
    return names ? names.map((path) => ({ path, kind: "file" })) : null;
  },
}));

import { mayBeMissing, MissingFileNotice, similarFileNames } from "./MissingFileNotice";

const AUDIT = "/Users/me/.specwithcode/audits/2026-10-20";
const BRACE = `${AUDIT}/findings-{B,C,D,E}.md`;
const environmentId = EnvironmentId.make("host");

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.folders = new Map([
    [
      AUDIT,
      [
        "findings-A.md",
        "findings-B.md",
        "findings-C.md",
        "findings-D.md",
        "findings-E.md",
        "INVENTORY.md",
        "brief.md",
      ],
    ],
  ]);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(path: string, onOpen = vi.fn(), error: string | null = "Failed") {
  await act(async () => {
    renderer = create(
      <MissingFileNotice environmentId={environmentId} path={path} error={error} onOpen={onOpen} />,
    );
  });
  return onOpen;
}

function text() {
  return JSON.stringify(renderer!.toJSON());
}

it("offers the real files beside a shorthand path that is not a file", async () => {
  const onOpen = await render(BRACE);
  expect(text()).toContain("findings-{B,C,D,E}.md was not found.");
  expect(text()).toContain(BRACE);
  const buttons = renderer!.root.findAllByType("button");
  expect(buttons.map((button) => button.props.children)).toEqual([
    "findings-A.md",
    "findings-B.md",
    "findings-C.md",
    "findings-D.md",
    "findings-E.md",
  ]);
  await act(async () => buttons[2]!.props.onClick());
  expect(onOpen).toHaveBeenCalledWith(`${AUDIT}/findings-C.md`);
});

it("says when the folder itself is not there", async () => {
  await render("/Users/me/gone/report.md");
  expect(text()).toContain("report.md was not found: its folder does not exist");
});

it("explains a file the list knows is missing even when its folder is gone too", async () => {
  await render("/Users/me/gone/report.md", vi.fn(), null);
  expect(text()).toContain("report.md was not found: its folder does not exist");
  expect(text()).toContain("/Users/me/gone/report.md");
  expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
});

it("keeps the server's words when the file is there but did not read", async () => {
  await render(`${AUDIT}/brief.md`, vi.fn(), "Failed to read file 'x'.");
  expect(text()).toContain("Failed to read file 'x'.");
  expect(text()).not.toContain("was not found");
});

it("picks similar names by extension and shared start", () => {
  expect(
    similarFileNames("findings-{B,C}.md", ["findings-B.md", "INVENTORY.md", "fin.txt"]),
  ).toEqual(["findings-B.md"]);
  expect(similarFileNames("report.md", ["notes.md"])).toEqual([]);
});

it("never treats a protected refusal as a missing file", () => {
  const base = { cwd: "/w", relativePath: BRACE, failure: "operation_failed" } as const;
  expect(mayBeMissing(new ProjectReadFileError({ ...base, operation: "realpath-target" }))).toBe(
    true,
  );
  expect(
    mayBeMissing(new ProjectReadFileError({ ...base, operation: "open", reason: "protected" })),
  ).toBe(false);
  expect(mayBeMissing(new ProjectReadFileError({ ...base, failure: "binary_file" }))).toBe(false);
  expect(mayBeMissing(null)).toBe(false);
});
