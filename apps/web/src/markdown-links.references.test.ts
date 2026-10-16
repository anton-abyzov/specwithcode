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
    // A bare name also tries the folder of the files named beside it.
    expect(links.get("README.md")?.candidates).toEqual([
      `${LOGO}/README.md`,
      `${LOGO}/png/README.md`,
      `${CWD}/README.md`,
    ]);
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

describe("line references", () => {
  it("opens a file:line range at its first line", () => {
    expect(
      resolveInlineCodeFileLinkMeta("apps/server/src/serverRuntimeStartup.ts:353-357", CWD),
    ).toMatchObject({
      filePath: `${CWD}/apps/server/src/serverRuntimeStartup.ts`,
      line: 353,
      endLine: 357,
    });
  });

  it("links a bare :line or :range to the file named before it", () => {
    const spans = [
      "apps/server/src/serverRuntimeStartup.ts:353-357",
      ":396-399",
      "prepareForShutdown",
      "ProviderRuntimeRecoveryService.ts:71-81",
      ":238",
    ];
    const links = resolveInlineCodeFileLinks(spans, CWD);
    expect(links.get(":396-399")).toMatchObject({
      filePath: `${CWD}/apps/server/src/serverRuntimeStartup.ts`,
      line: 396,
      endLine: 399,
      label: ":396–399",
    });
    expect(links.get(":238")).toMatchObject({
      filePath: `${CWD}/ProviderRuntimeRecoveryService.ts`,
      line: 238,
      label: ":238",
    });
    expect(links.has("prepareForShutdown")).toBe(false);
  });

  it("leaves a bare :line alone when no file came before it", () => {
    expect(resolveInlineCodeFileLinks([":12", "a/b.ts"], CWD).has(":12")).toBe(false);
  });
});
