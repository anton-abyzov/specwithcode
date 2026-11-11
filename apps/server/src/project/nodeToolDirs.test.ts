// @effect-diagnostics nodeBuiltinImport:off - Plain temp folders shaped like a version manager's home.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { nodeToolDirs, pickNvmVersion } from "./nodeToolDirs.ts";

const tempHome = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "node-tool-dirs-"));

describe("pickNvmVersion", () => {
  const installed = ["v18.20.4", "v22.9.0", "v22.20.0", "v20.11.1", "system", ".DS_Store"];

  it("takes the version the default alias names, exactly or by prefix", () => {
    expect(pickNvmVersion(installed, "v20.11.1\n")).toBe("v20.11.1");
    expect(pickNvmVersion(installed, "18")).toBe("v18.20.4");
    expect(pickNvmVersion(installed, "22")).toBe("v22.20.0");
  });

  it("falls back to the newest for a named alias, a missing one or no match", () => {
    expect(pickNvmVersion(installed, "lts/*")).toBe("v22.20.0");
    expect(pickNvmVersion(installed, null)).toBe("v22.20.0");
    expect(pickNvmVersion(installed, "16")).toBe("v22.20.0");
    expect(pickNvmVersion(["system"], "node")).toBeNull();
  });
});

describe("nodeToolDirs", () => {
  it.live(
    "lists fnm, nvm, volta and npm folders under the home, ahead of the Node binary's own",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(tempHome);
        const versions = NodePath.join(home, ".nvm", "versions", "node");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(versions, "v20.11.1", "bin"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(versions, "v24.22.0", "bin"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(home, ".nvm", "alias"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(home, ".nvm", "alias", "default"), "20\n");
        });
        const execPath = NodePath.join(home, "runtime", "node");

        const dirs = yield* nodeToolDirs({ home, platform: "linux", execPath });

        // The service's Node is the last resort, so the person's Node runs their CLI.
        expect(dirs.at(-1)).toBe(NodePath.join(home, "runtime"));
        expect(dirs).toContain(
          NodePath.join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
        );
        expect(dirs).toContain(NodePath.join(versions, "v20.11.1", "bin"));
        expect(dirs).not.toContain(NodePath.join(versions, "v24.22.0", "bin"));
        expect(dirs).toContain(NodePath.join(home, ".volta", "bin"));
        expect(dirs).toContain(NodePath.join(home, ".npm-global", "bin"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("honours FNM_DIR, NVM_DIR and VOLTA_HOME, and ignores relative values", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(tempHome);
      const nvmDir = NodePath.join(home, "custom-nvm");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(nvmDir, "versions", "node", "v22.20.0", "bin"), {
          recursive: true,
        }),
      );

      const dirs = yield* nodeToolDirs({
        home,
        platform: "linux",
        fnmDir: NodePath.join(home, "custom-fnm"),
        nvmDir,
        voltaHome: "relative/volta",
      });

      expect(dirs[0]).toBe(NodePath.join(home, "custom-fnm", "aliases", "default", "bin"));
      expect(dirs).toContain(NodePath.join(nvmDir, "versions", "node", "v22.20.0", "bin"));
      expect(dirs).toContain(NodePath.join(home, ".volta", "bin"));
      expect(dirs.some((dir) => dir.includes("relative"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
