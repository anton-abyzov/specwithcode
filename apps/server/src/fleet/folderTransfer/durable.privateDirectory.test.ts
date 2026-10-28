// @effect-diagnostics nodeBuiltinImport:off - disposable folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { privateDirectory } from "./durable.ts";

it("names a private folder behind a link and where it leads, so the app can say what to fix", async () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-link-")));
  try {
    const real = NodePath.join(root, "elsewhere");
    const linked = NodePath.join(root, "staging");
    NodeFS.mkdirSync(real);
    NodeFS.symlinkSync(real, linked, "dir");
    await expect(privateDirectory(linked)).rejects.toThrow(
      `Private folder resolves elsewhere: ${linked} -> ${real}`,
    );
    // A folder below a linked parent names where it really is, too.
    await expect(privateDirectory(NodePath.join(linked, "inner"))).rejects.toThrow(
      `Private folder resolves elsewhere: ${NodePath.join(linked, "inner")} -> ${NodePath.join(real, "inner")}`,
    );
    // A real folder is still made private and returned.
    await expect(privateDirectory(NodePath.join(root, "plain"))).resolves.toBe(
      NodePath.join(root, "plain"),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
