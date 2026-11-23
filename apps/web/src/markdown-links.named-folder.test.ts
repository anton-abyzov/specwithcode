import { describe, expect, it } from "vite-plus/test";

import { fileReferenceSpans, resolveInlineCodeFileLinks } from "./markdown-links";

const CWD = "/Users/me/Projects/umbrella";
const INCREMENT = `${CWD}/.specweave/increments/1442-offline-thread-banner`;
const OTHER = `${CWD}/.specweave/increments/1441-ultracode-tracks`;

// The report from November 23, 2026 whose chips opened another increment's spec.md.
const REPORT = `The \`reports\` folder is ignored by Git, so the mockup and screenshots exist on this machine only.

Files are in \`${INCREMENT}/\`:
- \`spec.md\`
- \`reports/mockup-continue-chooser.html\`
- \`reports/screens/mockup-dark.png\`
- \`reports/screens/banner-today.png\``;

describe("files listed under a folder the message names inside the workspace", () => {
  const links = resolveInlineCodeFileLinks(fileReferenceSpans(REPORT), CWD);

  it("tries the named folder before the workspace root", () => {
    expect(links.get("spec.md")).toMatchObject({ filePath: `${INCREMENT}/spec.md` });
    expect(links.get("spec.md")?.candidates).toEqual([`${INCREMENT}/spec.md`, `${CWD}/spec.md`]);
    expect(links.get("reports/screens/banner-today.png")?.candidates).toEqual([
      `${INCREMENT}/reports/screens/banner-today.png`,
      `${CWD}/reports/screens/banner-today.png`,
    ]);
    expect(links.get("reports/mockup-continue-chooser.html")?.filePath).toBe(
      `${INCREMENT}/reports/mockup-continue-chooser.html`,
    );
  });

  it("searches by name only in the named folder, never the whole workspace", () => {
    expect(links.get("spec.md")?.search?.roots).toEqual([INCREMENT]);
    expect(links.get("reports/screens/mockup-dark.png")?.search?.roots).toEqual([INCREMENT]);
  });

  it("puts the folder named last first when a message names two", () => {
    const text = `Old files are in \`${OTHER}/\`: \`notes.md\`.\n\nNew files are in \`${INCREMENT}/\`: \`spec.md\`.`;
    const both = resolveInlineCodeFileLinks(fileReferenceSpans(text), CWD);
    expect(both.get("notes.md")?.candidates?.[0]).toBe(`${OTHER}/notes.md`);
    expect(both.get("spec.md")?.candidates?.[0]).toBe(`${INCREMENT}/spec.md`);
  });

  it("leaves workspace-relative folders and files as they were", () => {
    const text = "See `apps/web/` and `README.md`.";
    const plain = resolveInlineCodeFileLinks(fileReferenceSpans(text), CWD);
    expect(plain.get("README.md")?.filePath).toBe(`${CWD}/README.md`);
    expect(plain.get("README.md")?.candidates).toBeUndefined();
    expect(plain.get("README.md")?.search?.roots).toEqual([CWD]);
  });
});
