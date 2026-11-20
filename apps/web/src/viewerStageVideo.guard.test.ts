// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

/**
 * A video opened from a thread plays on the viewer's stage. The player wraps the
 * video in an auto-height span, so a percentage max-height on the video has no
 * definite height to resolve against and a portrait file is drawn as tall as
 * itself, below the stage and its controls. The stage's own room has to come
 * from container units. The layout is checked in a browser by
 * `tests/viewer-video/verify.mjs`.
 */
const sourceRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const read = (file: string) => NodeFS.readFileSync(NodePath.join(sourceRoot, file), "utf8");

it("sizes the thread video's room from its stage, not from a percentage", () => {
  const rule = /\.viewer-media-video\s*\{([^}]*)\}/.exec(read("index.css"))?.[1] ?? "";
  expect(rule).toContain("container-type: size");
  expect(rule).toContain("--media-height: 100cqh");
  expect(rule).toContain("--media-width: 100cqw");
  const dialog = read("components/chat/ExpandedImageDialog.tsx");
  expect(dialog).not.toMatch(/viewer-media-video[^"]*--media-(height|width):calc\(100%/);
});
