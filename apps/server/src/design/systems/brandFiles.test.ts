// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { BRAND_FILES_MAX_COUNT, findBrandFiles, storedFileName } from "./brandFiles.ts";
import { listFolders } from "./proposal.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});

const checkout = async (files: Record<string, string>) => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "brand-files-")),
  );
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return root;
};

const KIT = {
  "packages/kit/package.json": "{}",
  "packages/kit/README.md": "# Kit",
  "packages/kit/docs/usage.md": "usage",
  "packages/kit/src/styles/tokens.css": ":root { --kit-ink: #111; }",
  "packages/kit/src/primitives/index.ts": "export {};",
  "packages/kit/src/brand/mark.svg": "<svg id='mark'/>",
  "packages/kit/src/brand/notes.txt": "not an image",
  "packages/kit/public/favicon.svg": "<svg id='favicon'/>",
  "packages/kit/assets/fonts/Inter.woff2": "font-bytes",
  "packages/kit/assets/fonts/Inter-LICENSE.txt": "OFL",
  "packages/kit/.storybook/public/logo.svg": "<svg id='hidden'/>",
  "packages/kit/node_modules/x/brand/logo.svg": "<svg id='dep'/>",
  "apps/site/package.json": "{}",
  "apps/site/README.md": "# Site",
  "apps/site/public/assets/brand/kit-tokens.css": ":root { --kit-ink: #111; }",
  "apps/site/public/assets/brand/wordmark-dark.svg": "<svg id='dark'/>",
  "apps/site/public/assets/brand/wordmark-copy.svg": "<svg id='mark'/>",
  "apps/site/public/assets/brand/.env": "SECRET=1",
  "apps/site/public/assets/fonts/Inter Tight.woff2": "tight-bytes",
  "apps/site/public/assets/videos/clip.png": "<png/>",
};
const PATHS = ["packages/kit/src/styles/tokens.css", "packages/kit/src/primitives/index.ts"];
const COPIES = ["apps/site/public/assets/brand/kit-tokens.css"];

describe("findBrandFiles", () => {
  it("offers the package's README, docs, brand images and fonts, and those beside copies", async () => {
    const root = await checkout(KIT);
    const offer = await findBrandFiles(root, await listFolders(root), PATHS, COPIES);
    expect(offer.files.map((file) => [file.source, file.path])).toEqual([
      ["packages/kit/README.md", "README.md"],
      ["packages/kit/docs/usage.md", "docs/usage.md"],
      ["packages/kit/public/favicon.svg", "assets/Brand/favicon.svg"],
      ["packages/kit/assets/fonts/Inter.woff2", "fonts/Inter.woff2"],
      ["packages/kit/assets/fonts/Inter-LICENSE.txt", "fonts/Inter-LICENSE.txt"],
      ["packages/kit/src/brand/mark.svg", "assets/Brand/mark.svg"],
      ["apps/site/public/assets/brand/wordmark-dark.svg", "assets/Brand/wordmark-dark.svg"],
      ["apps/site/public/assets/fonts/Inter Tight.woff2", "fonts/Inter Tight.woff2"],
    ]);
    const readme = offer.files[0]!;
    expect(readme.bytes).toBe(5);
    expect(readme.sha256).toMatch(/^[a-f0-9]{64}$/);
    // The copy's own README, the identical wordmark, hidden folders, dependencies,
    // secrets and images outside brand folders are not offered.
    expect(offer.files.map((file) => file.source).join("\n")).not.toMatch(
      /site\/README|wordmark-copy|storybook|node_modules|\.env|clip\.png|notes\.txt/,
    );
    expect(offer.findings).toEqual([]);
  });

  it("is the same for the same files and skips names the system already stores", async () => {
    const root = await checkout(KIT);
    const folders = await listFolders(root);
    const first = await findBrandFiles(root, folders, PATHS, COPIES);
    expect(await findBrandFiles(root, folders, PATHS.toReversed(), COPIES)).toEqual(first);
    const offer = await findBrandFiles(root, folders, PATHS, COPIES, [
      "readme.md",
      "assets/Brand/mark.svg",
    ]);
    expect(offer.files.map((file) => file.path)).not.toContain("README.md");
    expect(offer.files.map((file) => file.path)).not.toContain("assets/Brand/mark.svg");
    // Stored names are only known by name, so the wordmark identical to the stored mark is offered.
    expect(offer.files.map((file) => file.path).sort()).toEqual(
      [
        ...first.files
          .map((file) => file.path)
          .filter((path) => path !== "README.md" && path !== "assets/Brand/mark.svg"),
        "assets/Brand/wordmark-copy.svg",
      ].sort(),
    );
  });

  it("leaves nested packages out, numbers clashing names and reads font subfolders", async () => {
    const root = await checkout({
      "package.json": "{}",
      "design/tokens.css": ":root { --a: 1px; }",
      "brand/logo.svg": "<svg id='root'/>",
      "brand/dark/logo.svg": "<svg id='dark'/>",
      "assets/fonts/inter/Inter.woff2": "inter",
      "apps/other/package.json": "{}",
      "apps/other/brand/other.svg": "<svg id='other'/>",
    });
    const offer = await findBrandFiles(root, await listFolders(root), ["design/tokens.css"]);
    expect(offer.files.map((file) => [file.source, file.path])).toEqual([
      ["assets/fonts/inter/Inter.woff2", "fonts/Inter.woff2"],
      ["brand/logo.svg", "assets/Brand/logo.svg"],
      ["brand/dark/logo.svg", "assets/Brand/logo 2.svg"],
    ]);
  });

  it("refuses a brand file linked from outside the project", async () => {
    const outside = await checkout({ "secret.svg": "<svg id='outside'/>" });
    const root = await checkout({
      "package.json": "{}",
      "src/tokens.css": ":root { --a: 1px; }",
    });
    await NodeFSP.mkdir(NodePath.join(root, "brand"));
    await NodeFSP.symlink(
      NodePath.join(outside, "secret.svg"),
      NodePath.join(root, "brand/logo.svg"),
    );
    const offer = await findBrandFiles(root, await listFolders(root), ["src/tokens.css"]);
    expect(offer.files).toEqual([]);
  });

  it("caps the offer and says how many files were left out", async () => {
    const files: Record<string, string> = { "package.json": "{}", "tokens.css": ":root{}" };
    for (let index = 0; index < BRAND_FILES_MAX_COUNT + 3; index += 1) {
      files[`brand/logo-${String(index).padStart(3, "0")}.svg`] = `<svg id='${index}'/>`;
    }
    const root = await checkout(files);
    const offer = await findBrandFiles(root, await listFolders(root), ["tokens.css"]);
    expect(offer.files).toHaveLength(BRAND_FILES_MAX_COUNT);
    expect(offer.findings).toEqual([
      expect.objectContaining({ code: "brand-files", message: expect.stringMatching(/^3 more/) }),
    ]);
  });

  it("turns a source name into a name a stored path can hold", () => {
    expect(storedFileName("Logo (Dark)@2x.PNG")).toBe("Logo (Dark)-2x.png");
    expect(storedFileName("_mark.svg")).toBe("mark.svg");
    expect(storedFileName("Écusson.svg")).toBe("Ecusson.svg");
    expect(storedFileName("README")).toBeNull();
  });
});
