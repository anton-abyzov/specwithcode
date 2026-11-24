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

  it("ignores only ASCII case on a Windows path and cuts from the original", () => {
    expect(pathInside("C:\\Work\\App", "c:\\WORK\\app\\Docs\\R.html")).toBe("Docs/R.html");
    expect(pathInside("C:\\Users\\İpek", "c:\\users\\İpek\\app\\r.html")).toBe("app/r.html");
    expect(pathInside("\\\\server\\Share", "\\\\SERVER\\share\\a.md")).toBe("a.md");
    // Folders a volume may keep apart never match: Straße/Strasse, ος/οσ, and
    // non-ASCII case at all (the page is then served by its exact path).
    expect(pathInside("C:\\Straße", "C:\\Strasse\\r.html")).toBeNull();
    expect(pathInside("C:\\Work\\ος", "C:\\Work\\οσ\\r.html")).toBeNull();
    expect(pathInside("C:\\Work\\Équipe", "c:\\work\\équipe\\r.html")).toBeNull();
    // Case still counts on a POSIX path.
    expect(pathInside("/Work/App", "/work/app/r.html")).toBeNull();
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
