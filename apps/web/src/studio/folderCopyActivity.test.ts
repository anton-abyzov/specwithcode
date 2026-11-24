import { beforeEach, expect, it } from "vite-plus/test";
import type { FolderCopyStatus } from "@specweave-studio/contracts";
import {
  copyActivityFromSource,
  copyActivityFromStatus,
  copyActivityText,
  copyDetailsOpener,
  copyOpener,
  currentCopyActivities,
  isMovingDestination,
  moveDestination,
  withoutMovingDestinations,
  registerCopyNavigator,
  registerCopyOpener,
  requestCopyReview,
  resetCopyActivityForTests,
  setCopyActivity,
  type CopyActivity,
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

const moving = (destination: CopyActivity["destination"]): CopyActivity => ({
  machine: "ministorm",
  label: "Copying files",
  fraction: 0.5,
  waiting: false,
  move: true,
  ...(destination ? { destination } : {}),
});

it("says Move for a move in the sidebar line, and names where it lands", () => {
  expect(copyActivityText(moving(undefined))).toBe("Hand off to ministorm: copying files, 50%");
  const activity = copyActivityFromStatus(
    status("transferring", {
      mode: "copy-and-move",
      targetFolder: "/Users/me/work",
      projectRelativePath: "app",
      projectFolder: null,
    }),
    "ministorm",
    "env-mini",
  );
  expect(activity).toMatchObject({
    move: true,
    destination: { environmentId: "env-mini", projectId: null, folder: "/Users/me/work/app" },
  });
  // Copy files only: no move and no destination to hide.
  expect(
    copyActivityFromStatus(status("transferring", { mode: "copy-only" }), "ministorm", "env-mini"),
  ).not.toHaveProperty("move");
  expect(
    moveDestination(
      { mode: "copy-only", projectId: null, projectFolder: null, targetFolder: "/x" } as never,
      "env-mini",
    ),
  ).toBeNull();
});

it("recognises the project a running move registers, by id or by folder, never the source", () => {
  const activities = new Map([
    [
      "env-m4:source",
      moving({ environmentId: "env-mini", projectId: null, folder: "/Users/me/work/" }),
    ],
  ]);
  expect(
    isMovingDestination(
      { environmentId: "env-mini", id: "new", workspaceRoot: "/Users/me/work" },
      activities,
    ),
  ).toBe(true);
  expect(
    isMovingDestination(
      { environmentId: "env-m4", id: "other", workspaceRoot: "/Users/me/work" },
      activities,
    ),
  ).toBe(false);
  const byId = new Map([
    [
      "env-m4:source",
      moving({ environmentId: "env-mini", projectId: "new", folder: "/elsewhere" }),
    ],
  ]);
  expect(
    isMovingDestination({ environmentId: "env-mini", id: "new", workspaceRoot: "/x" }, byId),
  ).toBe(true);
  // A copy of files only never hides a project.
  const copyOnly = new Map([
    [
      "env-m4:source",
      { ...moving({ environmentId: "env-mini", projectId: "new", folder: "/x" }), move: false },
    ],
  ]);
  expect(
    isMovingDestination({ environmentId: "env-mini", id: "new", workspaceRoot: "/x" }, copyOnly),
  ).toBe(false);
});

it("keeps listing a project while the move waits for review, or when it already lived there", () => {
  const project = { environmentId: "env-mini", id: "earlier", workspaceRoot: "/Users/me/app" };
  const at = (activity: CopyActivity) => new Map([["env-m4:source", activity]]);
  const destination = { environmentId: "env-mini", projectId: "earlier", folder: "/Users/me/app" };
  expect(isMovingDestination(project, at(moving(destination)))).toBe(true);
  // A choose-first move that is not reviewed yet hides nothing.
  expect(isMovingDestination(project, at({ ...moving(destination), waiting: true }))).toBe(false);
  // A move into a folder that already held a project keeps that project and its threads listed.
  expect(isMovingDestination(project, at(moving({ ...destination, existing: true })))).toBe(false);
  expect(
    copyActivityFromStatus(
      status("transferring", { mode: "copy-and-move", targetFolder: "/Users/me/app" }),
      "ministorm",
      "env-mini",
      true,
    )?.destination,
  ).toMatchObject({ existing: true });
});

it("shows a moving project once in the sidebar, on its source row", () => {
  const group = (projectKey: string, members: Array<[string, string, string]>) => ({
    projectKey,
    memberProjects: members.map(([environmentId, id, workspaceRoot]) => ({
      environmentId,
      id,
      workspaceRoot,
    })),
  });
  const source = group("source", [["env-m4", "source", "/Users/me/app"]]);
  const landing = group("landing", [["env-mini", "new", "/Users/me/app"]]);
  const other = group("other", [["env-mini", "other", "/Users/me/other"]]);
  const visible = { pinned: [landing], unpinned: [source, other] };
  const listedKeys = { pinned: ["landing"], unpinned: ["source", "other"] };
  const activities = new Map([
    [
      "env-m4:source",
      moving({ environmentId: "env-mini", projectId: "new", folder: "/Users/me/app" }),
    ],
  ]);
  expect(withoutMovingDestinations(visible, listedKeys, activities)).toEqual({
    visible: { pinned: [], unpinned: [source, other] },
    listedKeys: { pinned: [], unpinned: ["source", "other"] },
  });
  // Nothing moving: the same lists come back untouched.
  const idle = withoutMovingDestinations(visible, listedKeys, new Map());
  expect(idle.visible).toBe(visible);
  expect(idle.listedKeys).toBe(listedKeys);
});

it("says a copy waiting for review is waiting for the person", () => {
  const waiting: CopyActivity = {
    machine: "M1",
    label: "Ready to review",
    fraction: null,
    waiting: true,
  };
  expect(copyActivityText(waiting)).toBe("Copy to M1 is waiting for your review");
  expect(copyActivityText({ ...waiting, move: true })).toBe(
    "Hand off to M1 is waiting for your review",
  );
});

it("opens a requested review once its project's dialog registers", async () => {
  let opened = 0;
  requestCopyReview("env:project");
  const unregister = registerCopyOpener("env:project", () => {
    opened += 1;
  });
  await Promise.resolve();
  expect(opened).toBe(1);
  // Opened once: a later registration does not reopen it.
  unregister();
  registerCopyOpener("env:project", () => {
    opened += 1;
  });
  await Promise.resolve();
  expect(opened).toBe(1);
  // Registered already: the request opens at once.
  requestCopyReview("env:project");
  expect(opened).toBe(2);
});

it("does not open a review for another project's dialog", async () => {
  let opened = 0;
  requestCopyReview("env:one");
  registerCopyOpener("env:two", () => {
    opened += 1;
  });
  await Promise.resolve();
  expect(opened).toBe(0);
});

it("opens a copy's details from another project: its page first, then its dialog", async () => {
  expect(copyDetailsOpener("env:project")).toBeNull();
  const steps: string[] = [];
  registerCopyNavigator("env:project", () => steps.push("navigate"));
  copyDetailsOpener("env:project")!();
  expect(steps).toEqual(["navigate"]);
  // The page mounts its dialog, which then opens.
  registerCopyOpener("env:project", () => steps.push("open"));
  await Promise.resolve();
  expect(steps).toEqual(["navigate", "open"]);
  // On the page already: the dialog opens without navigating.
  copyDetailsOpener("env:project")!();
  expect(steps).toEqual(["navigate", "open", "open"]);
});

it("shows the source's reading counts while the destination compares (1332 AC-03)", () => {
  const hashing = { step: "hashing", files: 469, bytes: 21_100_000, totalFiles: 121_868, totalBytes: 7_500_000_000 } as const;
  const activity = copyActivityFromStatus(status("scanning"), "m5", undefined, false, "m4", hashing);
  expect(activity?.progress).toMatchObject({
    phase: "measure",
    step: "Reading files on m4",
    bytes: { done: 21_100_000, total: 7_500_000_000 },
    files: { done: 469, total: 121_868 },
  });
  expect(copyActivityText(activity!)).toBe("Copy to m5: reading files on m4, 0%");
  // Listing on the source says nothing about the compare: the destination's step stays.
  expect(
    copyActivityFromStatus(status("scanning"), "m5", undefined, false, "m4", {
      files: 3,
      bytes: 9,
    } as never)?.progress?.step,
  ).toBe("Comparing with m5");
});

it("measures the speed once, for the sidebar line and the toast (1332 AC-03)", () => {
  const sending = (done: number): CopyActivity => ({
    machine: "m5",
    label: "Copying files",
    fraction: done / 8_000_000_000,
    waiting: false,
    progress: {
      phase: "send",
      step: "Sending files to m5",
      fraction: done / 8_000_000_000,
      bytes: { done, total: 8_000_000_000 },
      files: { done: 1, total: 4 },
      bytesLocal: 0,
      rateKey: "send:files",
      outcome: "running",
    },
  });
  setCopyActivity("m4:source", sending(1_000_000_000), 0);
  expect(currentCopyActivities().get("m4:source")?.rate).toBeNull();
  setCopyActivity("m4:source", sending(1_400_000_000), 4_000);
  const activity = currentCopyActivities().get("m4:source")!;
  expect(activity.rate).toBe(100_000_000);
  expect(copyActivityText(activity)).toBe("Copy to m5: sending files to m5, 17%, 100 MB/s");
  // Nothing moving for a while: the speed goes, though the reported counts did not change.
  for (let at = 5_000; at <= 13_000; at += 1_000)
    setCopyActivity("m4:source", sending(1_400_000_000), at);
  expect(currentCopyActivities().get("m4:source")?.rate).toBeNull();
});
