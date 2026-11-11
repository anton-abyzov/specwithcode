import { describe, expect, it } from "vite-plus/test";
import {
  collapseCrumbs,
  displayPath,
  folderOutcome,
  pathCrumbs,
  projectPlaces,
  recentParents,
  typeAheadIndex,
} from "./folderBrowser.logic";

describe("pathCrumbs", () => {
  it("starts at Home for folders under it and at the root otherwise", () => {
    expect(pathCrumbs("/Users/a/Projects/github/", "/Users/a")).toEqual([
      { label: "Home", path: "/Users/a" },
      { label: "Projects", path: "/Users/a/Projects" },
      { label: "github", path: "/Users/a/Projects/github" },
    ]);
    expect(pathCrumbs("/srv/www", "/home/a").map((crumb) => crumb.label)).toEqual([
      "/",
      "srv",
      "www",
    ]);
    expect(pathCrumbs("C:\\Users\\a", null).map((crumb) => crumb.path)).toEqual([
      "C:\\",
      "C:\\Users",
      "C:\\Users\\a",
    ]);
  });
  it("keeps the first and last two crumbs of a deep path", () => {
    const crumbs = pathCrumbs("/Users/a/b/c/d/e", "/Users/a");
    const { head, hidden, tail } = collapseCrumbs(crumbs);
    expect(head.map((crumb) => crumb.label)).toEqual(["Home"]);
    expect(hidden.map((crumb) => crumb.label)).toEqual(["b", "c"]);
    expect(tail.map((crumb) => crumb.label)).toEqual(["d", "e"]);
    expect(collapseCrumbs(crumbs.slice(0, 4)).hidden).toEqual([]);
  });
  it("shortens paths under home", () => {
    expect(displayPath("/Users/a/Projects", "/Users/a")).toBe("~/Projects");
    expect(displayPath("/Users/ab", "/Users/a")).toBe("/Users/ab");
    expect(displayPath("/Users/a", "/Users/a")).toBe("~");
  });
});

describe("typeAheadIndex", () => {
  const names = ["api", "apps", "docs", "Scripts", "static"];
  it("jumps to the next match and cycles on a repeated letter", () => {
    expect(typeAheadIndex(names, "s", 0)).toBe(3);
    expect(typeAheadIndex(names, "ss", 3)).toBe(4);
    expect(typeAheadIndex(names, "ap", 0)).toBe(0);
    expect(typeAheadIndex(names, "app", 0)).toBe(1);
    expect(typeAheadIndex(names, "a", 1)).toBe(0);
    expect(typeAheadIndex(names, "z", 0)).toBe(-1);
  });
});

describe("folderOutcome", () => {
  const at = (
    entries: Array<{ name: string; kind?: string }>,
    folder = "/p",
    name = "Fable Test",
  ) => folderOutcome({ folder, name, entries });
  it("makes a subfolder named after the project", () => {
    expect(at([{ name: "other" }])).toEqual({ kind: "create", path: "/p/fable-test", note: null });
    expect(at([], "/p", " ")).toBeNull();
  });
  it("says an empty folder named like the project is set up as a new one", () => {
    expect(at([], "/p/fable-test")).toMatchObject({
      kind: "use",
      path: "/p/fable-test",
      note: expect.stringContaining("If it is empty"),
    });
    expect(at([{ name: "src" }], "/p/fable-test")?.note).toBe("Its name matches the project.");
  });
  it("uses a folder that already is a project", () => {
    expect(at([{ name: ".git" }])).toMatchObject({ kind: "use", path: "/p" });
    expect(at([{ name: ".specweave" }])).toMatchObject({ kind: "use", path: "/p" });
    expect(at([], "/p/fable-test")).toMatchObject({ kind: "use", path: "/p/fable-test" });
    expect(at([{ name: "fable-test", kind: "git" }])).toMatchObject({
      kind: "use",
      path: "/p/fable-test",
    });
  });
  it("numbers the folder when the plain name is taken", () => {
    expect(at([{ name: "fable-test", kind: "folder" }, { name: "fable-test-2" }])).toMatchObject({
      kind: "create",
      path: "/p/fable-test-3",
    });
  });
});

describe("places", () => {
  it("lists the newest project parents once, without app storage", () => {
    expect(
      recentParents(
        ["/a/one/x", "/a/two/y", "/Users/a/.specwithcode/m4/projects/z", "/a/one/w", "/a/skip/q"],
        ["/a/skip"],
      ),
    ).toEqual(["/a/one", "/a/two"]);
  });
  it("offers the projects folder, home, then recent parents", () => {
    expect(
      projectPlaces({ projectsFolder: "/Users/a/Projects", projectRoots: ["/work/client/app"] }),
    ).toEqual([
      { kind: "projects", label: "Projects", path: "/Users/a/Projects" },
      { kind: "home", label: "Home", path: "~/" },
      { kind: "recent", label: "client", path: "/work/client" },
    ]);
  });
});
