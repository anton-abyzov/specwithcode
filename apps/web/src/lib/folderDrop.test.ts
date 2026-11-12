import { describe, expect, it } from "vite-plus/test";
import { droppedFolder, folderDropRefusal, resolveDroppedFolderPath } from "./folderDrop";

const file = (name: string) => ({ name }) as File;
const paths: Record<string, string> = {
  app: "/Users/you/code/app",
  "notes.md": "/Users/you/docs/notes.md",
};
const getPathForFile = (dropped: File) => paths[dropped.name] ?? "";

describe("droppedFolder", () => {
  it("takes a dropped folder as it is", () => {
    expect(
      droppedFolder({ files: [file("app")], isDirectory: () => true, getPathForFile }),
    ).toEqual({ path: "/Users/you/code/app", fromFile: false });
  });

  it("uses the folder of a dropped file and says so", () => {
    expect(
      droppedFolder({ files: [file("notes.md")], isDirectory: () => false, getPathForFile }),
    ).toEqual({ path: "/Users/you/docs", fromFile: true });
  });

  it("prefers a folder over a file dropped with it", () => {
    expect(
      droppedFolder({
        files: [file("notes.md"), file("app")],
        isDirectory: (index) => index === 1,
        getPathForFile,
      }),
    ).toEqual({ path: "/Users/you/code/app", fromFile: false });
  });

  it("gives nothing when no path can be read", () => {
    expect(
      droppedFolder({ files: [file("app")], isDirectory: () => true, getPathForFile: undefined }),
    ).toBeNull();
    expect(droppedFolder({ files: [], isDirectory: () => null, getPathForFile })).toBeNull();
    expect(resolveDroppedFolderPath(file("unknown"), getPathForFile)).toBeNull();
  });
});

describe("folderDropRefusal", () => {
  it("allows a drop only in the desktop app onto this device", () => {
    expect(
      folderDropRefusal({ inDesktopApp: true, targetIsThisDevice: true, machineLabel: "Mac" }),
    ).toBeNull();
  });

  it("says to type or paste the path for another machine or a browser", () => {
    expect(
      folderDropRefusal({ inDesktopApp: true, targetIsThisDevice: false, machineLabel: "Mini" }),
    ).toBe(
      "The dropped folder is on this device, not on Mini. Type or paste a path on that machine instead.",
    );
    expect(
      folderDropRefusal({ inDesktopApp: false, targetIsThisDevice: true, machineLabel: null }),
    ).toContain("Type or paste the path instead.");
  });
});
