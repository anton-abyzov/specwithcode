import { describe, expect, it } from "vite-plus/test";

import { previewTestPackageRoot } from "./previewTestPaths.ts";

describe("preview fixture package roots", () => {
  it.each([
    ["/repo/node_modules/react/index.js", "react", "/repo/node_modules/react"],
    [
      "/repo/node_modules/.pnpm/react@19/node_modules/react/index.js",
      "react",
      "/repo/node_modules/.pnpm/react@19/node_modules/react",
    ],
    [
      String.raw`D:\a\repo\node_modules\.pnpm\react@19\node_modules\react\index.js`,
      "react",
      String.raw`D:\a\repo\node_modules\.pnpm\react@19\node_modules\react`,
    ],
    [
      String.raw`D:\a\repo\node_modules\react-dom\server.node.js`,
      "react-dom",
      String.raw`D:\a\repo\node_modules\react-dom`,
    ],
    [
      String.raw`D:\a\repo\node_modules\esbuild\lib\main.js`,
      "esbuild",
      String.raw`D:\a\repo\node_modules\esbuild`,
    ],
    [
      String.raw`D:\a\repo\node_modules\@scope\kit\dist\index.js`,
      "@scope/kit",
      String.raw`D:\a\repo\node_modules\@scope\kit`,
    ],
  ])("resolves %s without altering its separators", (entry, name, expected) => {
    expect(previewTestPackageRoot(entry!, name!)).toBe(expected);
  });

  it.each([
    ["/repo/vendor/react/index.js", "react"],
    [String.raw`D:\repo\vendor\react\index.js`, "react"],
    ["/repo/node_modules/react-dom/index.js", "react"],
    ["/repo/node_modules/reactivity/index.js", "react"],
  ])("rejects an absent package boundary in %s", (entry, name) => {
    expect(previewTestPackageRoot(entry!, name!)).toBeNull();
  });
});
