// @effect-diagnostics nodeBuiltinImport:off - Plain temp folders shaped like a version manager's home.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NODE_VERSION } from "../provision/manifest.ts";
import { nodeToolDirs, orderNvmVersions, pickNvmVersion } from "./nodeToolDirs.ts";

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

describe("orderNvmVersions", () => {
  it("lists every version, the default's first and the rest newest first", () => {
    expect(orderNvmVersions(["v18.20.4", "v24.1.0", "v22.20.0", "system"], "22")).toEqual([
      "v22.20.0",
      "v24.1.0",
      "v18.20.4",
    ]);
    expect(orderNvmVersions(["system"], "node")).toEqual([]);
  });
});

describe("nodeToolDirs", () => {
  it.live("searches the Node.js first-run setup installed, after the person's own", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(tempHome);
      const studioHome = NodePath.join(home, ".specwithcode");
      const execPath = NodePath.join(home, "service", "node");
      const dirs = yield* nodeToolDirs({
        home,
        platform: "linux",
        arch: "x64",
        glibc: true,
        execPath,
        studioHome,
      });
      // A Linux folder, joined as Linux joins it, whatever machine runs the test.
      const managed = NodePath.posix.join(
        studioHome,
        "runtime",
        "node",
        `node-v${NODE_VERSION}-linux-x64`,
        "bin",
      );
      expect(dirs).toContain(managed);
      expect(dirs.indexOf(managed)).toBeGreaterThan(
        dirs.indexOf(NodePath.join(home, ".volta", "bin")),
      );
      expect(dirs.at(-1)).toBe(NodePath.join(home, "service"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
        // The default's folder comes first; a newer version is still searched after it.
        expect(dirs).toContain(NodePath.join(versions, "v24.22.0", "bin"));
        expect(dirs.indexOf(NodePath.join(versions, "v20.11.1", "bin"))).toBeLessThan(
          dirs.indexOf(NodePath.join(versions, "v24.22.0", "bin")),
        );
        expect(dirs).toContain(NodePath.join(home, ".volta", "bin"));
        expect(dirs).toContain(NodePath.join(home, ".npm-global", "bin"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("follows an nvm default of lts/* to the version it names, not the newest", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(tempHome);
      const versions = NodePath.join(home, ".nvm", "versions", "node");
      const alias = NodePath.join(home, ".nvm", "alias");
      // nvm's `lts/*` alias is a file named `*`, which Windows cannot hold (and nvm
      // does not run there), so a Windows host starts the chain one hop later.
      const starAlias = HostProcessPlatform.defaultValue() !== "win32";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(versions, "v22.20.0", "bin"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(versions, "v25.1.0", "bin"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(alias, "lts"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(alias, "default"),
          starAlias ? "lts/*\n" : "lts/jod\n",
        );
        if (starAlias) await NodeFSP.writeFile(NodePath.join(alias, "lts", "*"), "lts/jod\n");
        await NodeFSP.writeFile(NodePath.join(alias, "lts", "jod"), "v22.20.0\n");
      });

      const dirs = yield* nodeToolDirs({ home, platform: "linux" });

      expect(dirs.indexOf(NodePath.join(versions, "v22.20.0", "bin"))).toBeLessThan(
        dirs.indexOf(NodePath.join(versions, "v25.1.0", "bin")),
      );
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

  it.live(
    "on Windows adds the Node.js installer's folder, nvm-windows' link and Volta (1452 AC-04)",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(tempHome);
        // Host-absolute stand-ins: the host's path module judges them, as on a real Windows server.
        const programFiles = NodePath.join(home, "Program Files");
        const localAppData = NodePath.join(home, "AppData", "Local");
        const nvmSymlink = NodePath.join(home, "nvm4w", "nodejs");
        const execPath = NodePath.join(home, "SpecWithCode", "SpecWithCode.exe");
        const dirs = yield* nodeToolDirs({
          home,
          platform: "win32",
          execPath,
          programFiles,
          localAppData,
          nvmSymlink,
        });
        const installer = NodePath.join(programFiles, "nodejs");
        expect(dirs).toContain(installer);
        expect(dirs).toContain(nvmSymlink);
        expect(dirs).toContain(NodePath.join(localAppData, "Volta", "bin"));
        // Where win had it: the per-user installer's folder.
        expect(dirs).toContain(NodePath.join(localAppData, "Programs", "nodejs"));
        // A version manager's Node comes before the installer's, and both before the app's own.
        expect(dirs.indexOf(nvmSymlink)).toBeLessThan(dirs.indexOf(installer));
        expect(dirs.at(-1)).toBe(NodePath.dirname(execPath));

        const elsewhere = yield* nodeToolDirs({
          home,
          platform: "linux",
          programFiles,
          nvmSymlink,
        });
        expect(elsewhere).not.toContain(installer);
        expect(elsewhere).not.toContain(nvmSymlink);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
