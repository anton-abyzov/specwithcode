// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { unsafeSearchRootReason, unsafeSearchRootReasonResolved } from "./WorkspaceSearchRoots.ts";

const darwin = {
  homeDir: "/Users/anton",
  stateDir: "/Users/anton/.specwithcode/m4/userdata",
  platform: "darwin" as const,
};
const linux = {
  homeDir: "/home/anton",
  stateDir: "/srv/studio/userdata",
  platform: "linux" as const,
};

describe("unsafeSearchRootReason", () => {
  it("refuses the filesystem root, the home folder and every folder above it", () => {
    expect(unsafeSearchRootReason("/", darwin)).toBe("it is the filesystem root");
    expect(unsafeSearchRootReason("/Users", darwin)).toBe("it holds the home folder");
    expect(unsafeSearchRootReason("/Users/anton", darwin)).toBe("it is the home folder");
    expect(unsafeSearchRootReason("/Users/anton/", darwin)).toBe("it is the home folder");
    expect(unsafeSearchRootReason("/Users/anton/Projects/..", darwin)).toBe(
      "it is the home folder",
    );
    expect(unsafeSearchRootReason("/home", linux)).toBe("it holds the home folder");
    expect(unsafeSearchRootReason("/home/anton", linux)).toBe("it is the home folder");
  });

  it("sees the home folder through the macOS data volume and in any case", () => {
    expect(unsafeSearchRootReason("/System/Volumes/Data", darwin)).toBe(
      "it is the filesystem root",
    );
    expect(unsafeSearchRootReason("/System/Volumes/Data/Users", darwin)).toBe(
      "it holds the home folder",
    );
    expect(unsafeSearchRootReason("/System/Volumes/Data/Users/anton", darwin)).toBe(
      "it is the home folder",
    );
    expect(unsafeSearchRootReason("/users/ANTON", darwin)).toBe("it is the home folder");
    expect(
      unsafeSearchRootReason("C:\\Users", {
        homeDir: "C:\\Users\\anton",
        platform: "win32",
      }),
    ).toBe("it holds the home folder");
    expect(unsafeSearchRootReason("c:\\", { homeDir: "C:\\Users\\anton", platform: "win32" })).toBe(
      "it is the filesystem root",
    );
  });

  it("refuses ~/Library on macOS, where device and cloud mounts live", () => {
    expect(unsafeSearchRootReason("/Users/anton/Library", darwin)).toMatch(/inside ~\/Library/);
    expect(
      unsafeSearchRootReason("/Users/anton/Library/Developer/CoreDevice/DeviceFS/x", darwin),
    ).toMatch(/inside ~\/Library/);
    expect(unsafeSearchRootReason("/home/anton/Library", linux)).toBeUndefined();
  });

  it("refuses a root that holds the state folder", () => {
    expect(unsafeSearchRootReason("/Users/anton/.specwithcode", darwin)).toBe(
      "it holds the service's database folder",
    );
    expect(unsafeSearchRootReason("/Users/anton/.specwithcode/m4", darwin)).toBe(
      "it holds the service's database folder",
    );
    expect(unsafeSearchRootReason("/Users/anton/.specwithcode/m4/userdata", darwin)).toBe(
      "it holds the service's database folder",
    );
    // A received machine-handoff worktree lives inside it and is a project.
    expect(
      unsafeSearchRootReason(
        "/Users/anton/.specwithcode/m4/userdata/machine-handoffs/git/op-1/workspace",
        darwin,
      ),
    ).toBeUndefined();
    expect(unsafeSearchRootReason("/srv/studio", linux)).toBe(
      "it holds the service's database folder",
    );
    expect(unsafeSearchRootReason("/srv", linux)).toBe("it holds the service's database folder");
  });

  it("allows project folders, including the data folder's scratch and worktrees", () => {
    for (const root of [
      "/Users/anton/Projects/github/specwithcode-dev",
      "/Users/anton/Projects",
      "/Users/anton/.specwithcode/m4/scratch/thread-1",
      "/Users/anton/.specwithcode/m4/worktrees/repo/branch",
      "/Users/anton/.specwithcode/m4/userdata-old",
      "/Users/antonx",
      "/Volumes/SanDisk/project",
      "/private/tmp/project",
    ]) {
      expect(unsafeSearchRootReason(root, darwin), root).toBeUndefined();
    }
    expect(unsafeSearchRootReason("/home/anton/code/app", linux)).toBeUndefined();
    expect(unsafeSearchRootReason("/srv/studio/scratch", linux)).toBeUndefined();
  });

  it("checks the home folder without a state folder", () => {
    expect(
      unsafeSearchRootReason("/home/anton", { homeDir: "/home/anton", platform: "linux" }),
    ).toBe("it is the home folder");
    expect(
      unsafeSearchRootReason("/home/anton/app", { homeDir: "/home/anton", platform: "linux" }),
    ).toBeUndefined();
  });
});

describe("unsafeSearchRootReasonResolved", () => {
  it("follows symlinks to the home folder and the state folder", async () => {
    const scratch = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "search-roots-")),
    );
    try {
      const home = NodePath.join(scratch, "home");
      const stateDir = NodePath.join(home, ".studio", "userdata");
      const project = NodePath.join(home, "code", "app");
      await NodeFSP.mkdir(stateDir, { recursive: true });
      await NodeFSP.mkdir(project, { recursive: true });
      await NodeFSP.symlink(home, NodePath.join(scratch, "home-link"), "junction");
      await NodeFSP.symlink(
        NodePath.join(home, ".studio"),
        NodePath.join(scratch, "studio-link"),
        "junction",
      );
      await NodeFSP.symlink(project, NodePath.join(scratch, "project-link"), "junction");
      const options = { homeDir: home, stateDir, platform: process.platform };

      await expect(
        unsafeSearchRootReasonResolved(NodePath.join(scratch, "home-link"), options),
      ).resolves.toBe("it is the home folder");
      await expect(
        unsafeSearchRootReasonResolved(NodePath.join(scratch, "studio-link"), options),
      ).resolves.toBe("it holds the service's database folder");
      await expect(
        unsafeSearchRootReasonResolved(NodePath.join(scratch, "project-link"), options),
      ).resolves.toBeUndefined();
      await expect(
        unsafeSearchRootReasonResolved(NodePath.join(scratch, "missing"), options),
      ).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  });
});
