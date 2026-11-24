import { describe, expect, it } from "vite-plus/test";

import { incrementCopyRoot, parentPath, pathInside } from "./boardPaths";

describe("boardPaths", () => {
  it("finds a path inside a root a segment at a time", () => {
    expect(pathInside("/work/app", "/work/app/docs/r.html")).toBe("docs/r.html");
    expect(pathInside("/work/app/", "/work/app/r.html")).toBe("r.html");
    expect(pathInside("/work/app", "/work/application/r.html")).toBeNull();
    expect(pathInside("/work/app", "/work/app")).toBeNull();
    expect(pathInside("/Work/App", "/work/app/r.html")).toBeNull();
    expect(pathInside("", "/work/app/r.html")).toBeNull();
  });

  it("ignores case in any script on a Windows path and cuts from the original", () => {
    expect(pathInside("C:\\Work\\Équipe", "c:\\work\\équipe\\Docs\\R.html")).toBe("Docs/R.html");
    expect(pathInside("C:\\Users\\İpek", "c:\\users\\İpek\\app\\r.html")).toBe("app/r.html");
    expect(pathInside("\\\\server\\Share", "\\\\SERVER\\share\\a.md")).toBe("a.md");
    // Windows keeps these apart: only one-for-one case mappings match.
    expect(pathInside("C:\\Straße", "C:\\Strasse\\r.html")).toBeNull();
    expect(pathInside("C:\\Strasse", "C:\\STRAßE\\r.html")).toBeNull();
    expect(pathInside("C:\\straße", "C:\\STRAßE\\r.html")).toBe("r.html");
  });

  it("finds the copy folder above .specweave/increments", () => {
    expect(incrementCopyRoot("/c/b96/897/.specweave/increments/1-a/reports/m.html")).toEqual({
      root: "/c/b96/897",
      relative: ".specweave/increments/1-a/reports/m.html",
    });
    expect(incrementCopyRoot("C:\\Users\\İpek\\copy\\.SpecWeave\\Increments\\1-a\\r.html")).toEqual(
      { root: "C:\\Users\\İpek\\copy", relative: ".SpecWeave/Increments/1-a/r.html" },
    );
    expect(incrementCopyRoot("/.specweave/increments/1-a/r.html")).toBeNull();
    expect(incrementCopyRoot("/work/app/docs/r.html")).toBeNull();
  });

  it("cuts a file's folder from the original path", () => {
    expect(parentPath("C:\\a\\spec.md")).toBe("C:\\a");
    expect(parentPath("/a/b/spec.md")).toBe("/a/b");
  });
});
