import { describe, expect, it } from "vite-plus/test";

import { hostArtifactPath } from "./hostFilePreview";

describe("hostArtifactPath", () => {
  it("keeps POSIX, drive and UNC absolute paths as they are", () => {
    for (const path of [
      "/tmp/out/deck.pptx",
      "C:\\Users\\me\\deck.pptx",
      "c:/Users/me/brief.docx",
      "\\\\server\\share\\deck.pptx",
    ]) {
      expect(hostArtifactPath(path, "/Users/me/project")).toBe(path);
      expect(hostArtifactPath(path, "C:\\work\\project")).toBe(path);
    }
  });

  it("joins a relative path to the workspace root with the root's separator", () => {
    expect(hostArtifactPath("out/deck.pptx", "/Users/me/project/")).toBe(
      "/Users/me/project/out/deck.pptx",
    );
    expect(hostArtifactPath("./brief.docx", "C:\\work\\project\\")).toBe(
      "C:\\work\\project\\brief.docx",
    );
  });

  it("leaves a relative path alone without a workspace root", () => {
    expect(hostArtifactPath("out/brief.docx", undefined)).toBe("out/brief.docx");
  });
});
