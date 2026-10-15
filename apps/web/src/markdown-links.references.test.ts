import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCodeFileLinkMeta, resolveInlineCodeFileLinks } from "./markdown-links";

const CWD = "/Users/me/Projects/specweave";
const LOGO = "/Users/me/Projects/swc-logo";

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links folders written with a trailing slash", () => {
    expect(resolveInlineCodeFileLinkMeta("png/app/", CWD)).toMatchObject({
      filePath: `${CWD}/png/app`,
      basename: "app",
      directory: true,
    });
    expect(resolveInlineCodeFileLinkMeta("explorations/", CWD)).toMatchObject({
      filePath: `${CWD}/explorations`,
      directory: true,
    });
  });

  it("links bare document and media names, but not code or product names", () => {
    expect(resolveInlineCodeFileLinkMeta("README.md", CWD)?.filePath).toBe(`${CWD}/README.md`);
    expect(resolveInlineCodeFileLinkMeta("logo.svg", CWD)?.filePath).toBe(`${CWD}/logo.svg`);
    for (const text of ["Node.js", "index.ts", "glm-5.3", "origin/", "github.com/", "e.g."]) {
      expect(resolveInlineCodeFileLinkMeta(text, CWD), text).toBeNull();
    }
  });
});

describe("resolveInlineCodeFileLinks", () => {
  it("resolves a report's relative paths against the folder it names, then the workspace", () => {
    const spans = [
      `${LOGO}/png/contact-sheet.png`,
      "svg/icon.svg",
      "png/icon-4k.png",
      "png/app/",
      "explorations/",
      "README.md",
    ];
    const links = resolveInlineCodeFileLinks(spans, CWD);
    expect(links.get(spans[0]!)).toMatchObject({ filePath: `${LOGO}/png/contact-sheet.png` });
    expect(links.get(spans[0]!)?.candidates).toBeUndefined();
    expect(links.get("svg/icon.svg")).toMatchObject({
      filePath: `${LOGO}/svg/icon.svg`,
      candidates: [`${LOGO}/svg/icon.svg`, `${CWD}/svg/icon.svg`],
    });
    expect(links.get("png/app/")).toMatchObject({ filePath: `${LOGO}/png/app`, directory: true });
    expect(links.get("explorations/")?.filePath).toBe(`${LOGO}/explorations`);
    expect(links.get("README.md")?.candidates).toEqual([`${LOGO}/README.md`, `${CWD}/README.md`]);
  });

  it("keeps workspace paths when no relative path matches a folder the message names", () => {
    const links = resolveInlineCodeFileLinks(["/tmp/out/report.html", "src/app.ts"], CWD);
    expect(links.get("src/app.ts")).toEqual(
      expect.objectContaining({
        filePath: `${CWD}/src/app.ts`,
        workspaceRelativePath: "src/app.ts",
      }),
    );
    expect(links.get("src/app.ts")?.candidates).toBeUndefined();
  });
});
