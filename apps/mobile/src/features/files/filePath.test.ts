import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  isSvgImagePreviewFile,
  resolveWorkspaceRelativeFilePath,
  fileHeaderSubtitle,
} from "./filePath";

describe("fileRoutePathSegments", () => {
  it("round-trips workspace-relative and host paths through the route", () => {
    expect(fileRoutePathSegments("src/main.ts")).toEqual(["src", "main.ts"]);
    expect(fileRoutePathSegments("/tmp/studio-cleanup/report.md").join("/")).toBe(
      "/tmp/studio-cleanup/report.md",
    );
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

  it("converts absolute paths inside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/Users/dev/repo", "/Users/dev/repo/src/main.ts")).toBe(
      "src/main.ts",
    );
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });
});

describe("fileHeaderSubtitle", () => {
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("studio", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("studio · apps/mobile/src/features/threads");
  });

  it("shows only the directory for a host file outside the workspace", () => {
    // It is not under the project, so naming the project there would be a lie.
    expect(fileHeaderSubtitle("studio", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("studio", "README.md")).toBe("studio");
  });
});
