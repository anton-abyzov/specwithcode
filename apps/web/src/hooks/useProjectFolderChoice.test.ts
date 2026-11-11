import { describe, expect, it } from "vite-plus/test";

import { withRememberedPlace } from "./useProjectFolderChoice";

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
