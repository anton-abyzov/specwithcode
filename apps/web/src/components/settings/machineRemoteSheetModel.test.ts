import { describe, expect, it } from "vite-plus/test";
import {
  buildRemoteSheetModel,
  describeTemporaryWorkspace,
  isTemporaryWorkspace,
  shortenHomePath,
  type RemoteSheetCheckout,
  type RemoteSheetThread,
} from "./machineRemoteSheetModel";

const HOME = "/Users/you";
const checkout = (
  name: string,
  path: string,
  projectId = `${name}:${path}`,
  archived = false,
): RemoteSheetCheckout<null, null> => ({
  key: `${projectId}`,
  name,
  path,
  projectId,
  archived,
  project: null,
  search: null,
});
const thread = (
  id: string,
  title: string,
  projectId: string,
  activityAt: string,
): RemoteSheetThread => ({ id, title, projectId, activityAt });

describe("isTemporaryWorkspace", () => {
  it.each([
    `${HOME}/.specwithcode/m1/userdata/machine-handoffs/git/0b6c-uuid/workspace`,
    `${HOME}/.specwithcode/m4/scratch/2026-11-04-probe`,
    "C:\\Users\\anton\\.specwithcode\\m1\\scratch\\x",
  ])("hides %s", (path) => expect(isTemporaryWorkspace(path)).toBe(true));
  it.each([
    `${HOME}/Projects/github/easychamp`,
    `${HOME}/Projects/scratch`,
    `${HOME}/.specwithcode/m1/userdata/projects/x`,
    null,
  ])("keeps %s", (path) => expect(isTemporaryWorkspace(path)).toBe(false));
});

describe("describeTemporaryWorkspace", () => {
  it("names a handoff copy by its id and a scratch folder by its name", () => {
    expect(
      describeTemporaryWorkspace(
        `${HOME}/.specwithcode/m1/userdata/machine-handoffs/git/7f3c2a91-4b1e-4d7a-9a63-0c5e8b2f1d44/workspace`,
      ),
    ).toBe("Handoff copy · 7f3c2a91");
    expect(describeTemporaryWorkspace(`${HOME}/.specwithcode/m1/userdata/machine-handoffs`)).toBe(
      "Handoff copy",
    );
    expect(
      describeTemporaryWorkspace(`${HOME}/.specwithcode/m4/scratch/2026-11-03-probe/sub`),
    ).toBe("Scratch · 2026-11-03-probe");
  });
});

describe("shortenHomePath", () => {
  it("shortens macOS, Linux and Windows home folders", () => {
    expect(shortenHomePath(`${HOME}/Projects/a`)).toBe("~/Projects/a");
    expect(shortenHomePath("/home/anton/code")).toBe("~/code");
    expect(shortenHomePath("C:\\Users\\anton\\code")).toBe("~\\code");
    expect(shortenHomePath(HOME)).toBe("~");
  });
  it("leaves other paths alone", () => {
    expect(shortenHomePath("/opt/work")).toBe("/opt/work");
    expect(shortenHomePath("/Users")).toBe("/Users");
    expect(shortenHomePath("/Users/Shared/specwithcode-demo")).toBe(
      "/Users/Shared/specwithcode-demo",
    );
    expect(shortenHomePath("C:\\Users\\Public\\x")).toBe("C:\\Users\\Public\\x");
    expect(shortenHomePath(null)).toBeNull();
  });
});

describe("buildRemoteSheetModel", () => {
  const checkouts = [
    checkout("EasyChamp", `${HOME}/Projects/sw-easychamp`, "ec-1"),
    checkout("EasyChamp", `${HOME}/Projects/github/easychamp`, "ec-2"),
    checkout("greet-app", `${HOME}/Projects/greet-app`, "greet-1"),
    checkout(
      "greet-app",
      `${HOME}/.specwithcode/m1/userdata/machine-handoffs/git/a1b2c3d4-0000-4000-8000-000000000000/workspace`,
      "greet-2",
    ),
    checkout("greet-app", `${HOME}/.specwithcode/m1/scratch/greet`, "greet-3"),
    checkout("Old site", `${HOME}/Projects/old`, "old", true),
    checkout("specweave", `${HOME}/Projects/github/specweave-umb`, "sw"),
  ];
  const threads = [
    thread("t1", "EasyChamp coordinator", "ec-1", "2026-11-04T10:00:00Z"),
    thread("t2", "EasyChamp coordinator", "ec-2", "2026-11-04T12:00:00Z"),
    thread("t3", "easychamp coordinator ", "ec-1", "2026-11-03T12:00:00Z"),
    thread("t4", "Complete match card ordering", "ec-1", "2026-11-02T12:00:00Z"),
    thread("t5", "Complete match card ordering", "ec-1", "2026-11-04T08:00:00Z"),
    thread("t6", "", "sw", "2026-11-01T00:00:00Z"),
    thread("t7", "Fix greeting", "greet-2", "2026-11-04T11:00:00Z"),
  ];

  it("merges same-named projects into one row with each folder", () => {
    const model = buildRemoteSheetModel({ checkouts, threads });
    const easychamp = model.projects.find((project) => project.name === "EasyChamp")!;
    expect(model.projects.filter((project) => project.name === "EasyChamp")).toHaveLength(1);
    expect(easychamp.folders.map((folder) => folder.shortPath)).toEqual([
      "~/Projects/github/easychamp",
      "~/Projects/sw-easychamp",
    ]);
    expect(easychamp.threadCount).toBe(5);
    expect(easychamp.activityAt).toBe("2026-11-04T12:00:00Z");
  });

  it("keeps handoff copies and scratch folders apart from the person's projects", () => {
    const model = buildRemoteSheetModel({ checkouts, threads });
    const greet = model.projects.find((project) => project.name === "greet-app")!;
    expect(greet.folders.map((folder) => folder.shortPath)).toEqual(["~/Projects/greet-app"]);
    expect(model.temporary).toHaveLength(1);
    expect(model.temporary[0]!.folders).toHaveLength(2);
    expect(model.temporary[0]!.key).not.toBe(greet.key);
    expect(model.temporary[0]!.folders.map((folder) => folder.shortPath).toSorted()).toEqual([
      "Handoff copy · a1b2c3d4",
      "Scratch · greet",
    ]);
  });

  it("sorts recent projects first and archived projects last", () => {
    const model = buildRemoteSheetModel({ checkouts, threads });
    expect(model.projects.map((project) => project.name)).toEqual([
      "EasyChamp",
      "specweave",
      "greet-app",
      "Old site",
    ]);
    expect(model.projects.at(-1)!.archived).toBe(true);
  });

  it("shows each thread title once, newest first, with its repeat count", () => {
    const model = buildRemoteSheetModel({ checkouts, threads });
    expect(model.threads.map((row) => [row.title, row.id, row.repeats])).toEqual([
      ["EasyChamp coordinator", "t2", 3],
      ["Fix greeting", "t7", 1],
      ["Complete match card ordering", "t5", 2],
      ["Untitled thread", "t6", 1],
    ]);
    expect(model.threads[0]!.projectName).toBe("EasyChamp");
    expect(model.threads[1]!.projectName).toBe("greet-app");
  });

  it("filters projects by name or folder, and threads by title or project", () => {
    const byName = buildRemoteSheetModel({ checkouts, threads, query: "  GREET " });
    expect(byName.projects.map((project) => project.name)).toEqual(["greet-app"]);
    expect(byName.temporary).toHaveLength(1);
    expect(byName.threads.map((row) => row.title)).toEqual(["Fix greeting"]);

    const byFolder = buildRemoteSheetModel({ checkouts, threads, query: "sw-easychamp" });
    expect(byFolder.projects.map((project) => project.name)).toEqual(["EasyChamp"]);
    expect(byFolder.threads).toEqual([]);

    const byProject = buildRemoteSheetModel({ checkouts, threads, query: "easychamp" });
    expect(byProject.threads.map((row) => row.title)).toEqual([
      "EasyChamp coordinator",
      "Complete match card ordering",
    ]);
    expect(byProject.totalRows).toBe(8);
  });

  it("finds an older thread by its own project when a newer one shares its title", () => {
    const model = buildRemoteSheetModel({
      checkouts,
      threads: [
        thread("old", "Release notes", "sw", "2026-11-01T00:00:00Z"),
        thread("new", "Release notes", "ec-1", "2026-11-04T00:00:00Z"),
      ],
      query: "specweave",
    });
    expect(model.threads.map((row) => [row.id, row.projectName, row.repeats])).toEqual([
      ["old", "specweave", 1],
    ]);
  });

  it("is empty without projects or threads", () => {
    expect(buildRemoteSheetModel({ checkouts: [], threads: [] })).toEqual({
      projects: [],
      temporary: [],
      threads: [],
      totalRows: 0,
    });
  });
});
