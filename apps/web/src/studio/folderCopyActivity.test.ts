import { beforeEach, expect, it } from "vite-plus/test";
import type { FolderCopyStatus } from "@specweave-studio/contracts";
import {
  copyActivityFromSource,
  copyActivityFromStatus,
  copyActivityText,
  copyOpener,
  currentCopyActivities,
  registerCopyOpener,
  resetCopyActivityForTests,
  setCopyActivity,
} from "./folderCopyActivity";

const status = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    state,
    committed: false,
    projectId: null,
    progress: null,
    ...extra,
  }) as unknown as FolderCopyStatus;

beforeEach(() => resetCopyActivityForTests());

it("reads how far a copy is from the destination's counts", () => {
  const progress = {
    phase: "files",
    filesDone: 1,
    filesTotal: 4,
    bytesDone: 600,
    bytesTotal: 1000,
    bytesLocal: 0,
  };
  expect(copyActivityFromStatus(status("transferring", { progress }), "ministorm")).toEqual({
    machine: "ministorm",
    label: "Copying files",
    fraction: 0.6,
    waiting: false,
  });
  expect(copyActivityFromStatus(status("applying", { progress }), "m")?.fraction).toBe(0.25);
  expect(copyActivityFromStatus(status("scanning"), "m")?.fraction).toBeNull();
  expect(copyActivityFromStatus(status("previewed"), "m")?.waiting).toBe(true);
  expect(copyActivityFromStatus(status("applied"), "m")?.label).toBe("Finishing");
  expect(
    copyActivityFromStatus(status("applied", { committed: true, projectId: "p" }), "m"),
  ).toBeNull();
  expect(copyActivityFromStatus(status("failed"), "m")).toBeNull();
});

it("reads measuring and preparing from the source", () => {
  const source = (state: string, progress: unknown = null) =>
    ({ state, progress, summary: null, error: null }) as never;
  expect(copyActivityFromSource(source("scanning"), "m")?.label).toBe("Measuring the folder");
  expect(
    copyActivityFromSource(
      source("building", { files: 1, bytes: 50, totalFiles: 2, totalBytes: 200 }),
      "m",
    )?.fraction,
  ).toBe(0.25);
  expect(copyActivityFromSource(source("failed"), "m")).toBeNull();
});

it("says the copy in one line and only notifies on a change", () => {
  const activity = {
    machine: "ministorm",
    label: "Copying files",
    fraction: 0.426,
    waiting: false,
  };
  expect(copyActivityText(activity)).toBe("Copy to ministorm: copying files, 42%");
  setCopyActivity("a", activity);
  const first = currentCopyActivities();
  setCopyActivity("a", { ...activity });
  expect(currentCopyActivities()).toBe(first);
  setCopyActivity("a", null);
  expect(currentCopyActivities().size).toBe(0);
});

it("opens only the dialog still registered for the project", () => {
  let opened = 0;
  const unregister = registerCopyOpener("a", () => (opened += 1));
  copyOpener("a")!();
  expect(opened).toBe(1);
  unregister();
  expect(copyOpener("a")).toBeNull();
});
