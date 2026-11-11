import { EnvironmentId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { projectPlaces } from "../components/studio/folderBrowser.logic";
import {
  forgetRecentFolder,
  readRecentFolders,
  rememberRecentFolder,
  withRememberedPlace,
} from "./useProjectFolderChoice";

describe("recent folders", () => {
  const mac = EnvironmentId.make("mac");
  const linux = EnvironmentId.make("linux");
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it("keeps up to five per machine, newest first, each once", () => {
    for (const name of ["a", "b", "c", "d", "e", "f", "c"]) rememberRecentFolder(mac, `/w/${name}`);
    rememberRecentFolder(linux, "/srv/app");
    expect(readRecentFolders(mac)).toEqual(["/w/c", "/w/f", "/w/e", "/w/d", "/w/b"]);
    expect(readRecentFolders(linux)).toEqual(["/srv/app"]);
    expect(readRecentFolders(null)).toEqual([]);
  });

  it("skips hidden folders and forgets a folder that is gone", () => {
    rememberRecentFolder(mac, "/Users/a/.specwithcode/projects/x");
    rememberRecentFolder(mac, "/w/a");
    rememberRecentFolder(mac, "/w/b");
    forgetRecentFolder(mac, "/w/a/");
    expect(readRecentFolders(mac)).toEqual(["/w/b"]);
  });

  it("survives unreadable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("full");
      },
    });
    expect(readRecentFolders(mac)).toEqual([]);
    expect(() => rememberRecentFolder(mac, "/w/a")).not.toThrow();
  });

  it("lists chosen folders before the folders projects sit in, five at most", () => {
    const places = projectPlaces({
      projectsFolder: "/Users/a/Projects",
      projectRoots: ["/work/one/app", "/Users/a/Projects/site", "/srv/two/api"],
      recent: ["/work/one/app", "/Users/a/Projects/", "/tmp/x"],
    });
    expect(places.map((place) => `${place.kind}:${place.path}`)).toEqual([
      "projects:/Users/a/Projects",
      "home:~/",
      "recent:/work/one/app",
      "recent:/tmp/x",
      "recent:/srv/two",
      "recent:/work/one",
    ]);
    // Without stored folders the list is what it was: three project parents.
    expect(
      projectPlaces({ projectsFolder: null, projectRoots: ["/a/1", "/b/2", "/c/3", "/d/4"] }),
    ).toHaveLength(4);
  });
});

describe("withRememberedPlace", () => {
  const places = [
    { kind: "projects", label: "Projects", path: "/home/a/Projects" },
    { kind: "home", label: "Home", path: "~/" },
    { kind: "recent", label: "github", path: "/home/a/Projects/github" },
  ] as const;

  it("lists the folder used last time first among the recent places", () => {
    expect(withRememberedPlace(places, "/home/a/clients/")).toEqual([
      places[0],
      places[1],
      { kind: "recent", label: "clients", path: "/home/a/clients/" },
      places[2],
    ]);
  });

  it("adds nothing for a folder already listed, a hidden one, or none", () => {
    expect(withRememberedPlace(places, "/home/a/Projects/github/")).toBe(places);
    expect(withRememberedPlace(places, "/home/a/.specwithcode/m4/projects")).toBe(places);
    expect(withRememberedPlace(places, undefined)).toBe(places);
  });
});
