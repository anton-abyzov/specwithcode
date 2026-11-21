import { describe, expect, it } from "vite-plus/test";

import { hostArtifactPath, hostFilePreview, noPreviewReason } from "./hostFilePreview";

describe("hostFilePreview", () => {
  it("routes .xlsx to workbook and .docx to document", () => {
    expect(hostFilePreview("model.xlsx")).toBe("workbook");
    expect(hostFilePreview("Q2_BUDGET.XLSX")).toBe("workbook");
    expect(hostFilePreview("brief.docx")).toBe("document");
    expect(hostFilePreview("SPEC.DOCX")).toBe("document");
    expect(hostFilePreview("deck.pptx")).toBe("deck");
    // Macro-enabled and legacy formats remain carded
    expect(hostFilePreview("macros.xlsm")).toBe("card");
    expect(hostFilePreview("macros.docm")).toBe("card");
    expect(hostFilePreview("legacy.xls")).toBe("card");
    expect(hostFilePreview("legacy.doc")).toBe("card");
    expect(noPreviewReason("macros.xlsm")).toContain("Excel");
    expect(noPreviewReason("legacy.doc")).toContain("Word");
  });
});

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
