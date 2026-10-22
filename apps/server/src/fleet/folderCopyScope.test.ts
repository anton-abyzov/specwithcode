// @effect-diagnostics nodeBuiltinImport:off - disposable real scope fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  discoverCopyScopes,
  resolveCopyScope,
  verifyCopiedProjectFolder,
} from "./folderCopyScope.ts";

const roots: string[] = [];
const fixture = (relative = "repositories/acme/app", legacy = false) => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copy-scope-")),
  );
  roots.push(root);
  const child = NodePath.join(root, relative);
  NodeFS.mkdirSync(child, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, ".specweave"));
  NodeFS.writeFileSync(
    NodePath.join(root, ".specweave/config.json"),
    JSON.stringify(
      legacy
        ? { umbrella: { enabled: true, childRepos: [{ path: relative }] } }
        : { workspace: { name: "Workspace", repos: [{ path: relative }] } },
    ),
  );
  return { root, child };
};
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("copy scope discovery", () => {
  it.each(["repositories/acme/app", "chaotic/services/api"])(
    "offers configured workspace %s without changing child identity",
    async (relative) => {
      const { root, child } = fixture(relative);
      const result = await discoverCopyScopes(child);
      expect(result.projectRoot).toBe(child);
      expect(result.recommendedCopyRoot).toBe(root);
      expect(result.scopes).toMatchObject([
        { copyRoot: child, projectRelativePath: ".", kind: "project" },
        { copyRoot: root, projectRelativePath: relative, kind: "workspace" },
      ]);
      expect(await resolveCopyScope(child)).toEqual({ copyRoot: child, projectRelativePath: "." });
      expect(await resolveCopyScope(child, root)).toEqual({
        copyRoot: root,
        projectRelativePath: relative,
      });
    },
  );
  it("recognizes legacy workspace membership", async () => {
    const { root, child } = fixture("apps/api", true);
    expect((await discoverCopyScopes(child)).recommendedCopyRoot).toBe(root);
  });
  it("canonicalizes the registered project and declared symlink path within scope", async () => {
    const { root, child } = fixture("app-link");
    NodeFS.renameSync(child, NodePath.join(root, "actual"));
    NodeFS.symlinkSync("actual", child);
    expect(await resolveCopyScope(child, root)).toEqual({
      copyRoot: root,
      projectRelativePath: "actual",
    });
  });
  it("refuses undeclared ancestors, stale membership, and configuration links outside scope", async () => {
    const { root, child } = fixture("apps/api");
    await expect(resolveCopyScope(child, NodePath.dirname(root))).rejects.toMatchObject({
      code: "invalid",
    });
    NodeFS.writeFileSync(
      NodePath.join(root, ".specweave/config.json"),
      JSON.stringify({ workspace: { repos: [{ path: "../outside" }] } }),
    );
    expect((await discoverCopyScopes(child)).scopes).toHaveLength(1);
    await expect(resolveCopyScope(child, root)).rejects.toMatchObject({ code: "invalid" });
    const other = fixture("apps/other");
    NodeFS.unlinkSync(NodePath.join(root, ".specweave/config.json"));
    NodeFS.symlinkSync(
      NodePath.join(other.root, ".specweave/config.json"),
      NodePath.join(root, ".specweave/config.json"),
    );
    expect((await discoverCopyScopes(child)).scopes).toHaveLength(1);
  });
  it("does not treat sibling repos or a marker alone as a custom workspace", async () => {
    const { root, child } = fixture("apps/api");
    NodeFS.writeFileSync(NodePath.join(root, ".specweave/config.json"), "{}");
    NodeFS.mkdirSync(NodePath.join(root, "other/.git"), { recursive: true });
    expect((await discoverCopyScopes(child)).recommendedCopyRoot).toBe(child);
  });
  it("refuses a copied project path that escapes or changes into a link", async () => {
    const { root, child } = fixture("apps/api");
    expect(await verifyCopiedProjectFolder(root, "apps/api")).toBe(child);
    await expect(verifyCopiedProjectFolder(root, "../outside")).rejects.toMatchObject({
      code: "invalid",
    });
    NodeFS.renameSync(child, `${child}-old`);
    NodeFS.symlinkSync("api-old", child);
    await expect(verifyCopiedProjectFolder(root, "apps/api")).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
