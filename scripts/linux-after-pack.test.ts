// @effect-diagnostics nodeBuiltinImport:off - Applies real file modes in a temporary app folder.
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import afterPack, { removeSharedWriteAccess } from "./linux-after-pack.ts";

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("removeSharedWriteAccess", () => {
  it("removes group and other write access from the packed app only", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-after-pack-"));
    try {
      const appOutDir = NodePath.join(root, "app");
      const modes = {
        "app/specweave-studio-desktop": [0o777, 0o755],
        "app/resources.pak": [0o666, 0o644],
        "app/chrome-sandbox": [0o4777, 0o4755],
        "app/resources/app.asar": [0o644, 0o644],
        "outside/file": [0o666, 0o666],
      } as const;
      await NodeFSP.mkdir(NodePath.join(appOutDir, "resources"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "outside"));
      for (const [file, [before]] of Object.entries(modes)) {
        await NodeFSP.writeFile(NodePath.join(root, file), "");
        await NodeFSP.chmod(NodePath.join(root, file), before);
      }
      await NodeFSP.chmod(NodePath.join(appOutDir, "resources"), 0o777);
      await NodeFSP.symlink("../outside", NodePath.join(appOutDir, "linked-dir"));

      await removeSharedWriteAccess(appOutDir);

      for (const [file, [, after]] of Object.entries(modes)) {
        const { mode } = await NodeFSP.stat(NodePath.join(root, file));
        expect([file, mode & 0o7777]).toEqual([file, after]);
      }
      const { mode: resourcesMode } = await NodeFSP.stat(NodePath.join(appOutDir, "resources"));
      expect(resourcesMode & 0o7777).toBe(0o755);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("runs as electron-builder's afterPack hook on the unpacked app", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-after-pack-"));
    try {
      const binary = NodePath.join(root, "specweave-studio-desktop");
      await NodeFSP.writeFile(binary, "");
      await NodeFSP.chmod(binary, 0o777);

      await afterPack({ appOutDir: root });

      expect((await NodeFSP.stat(binary)).mode & 0o7777).toBe(0o755);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
