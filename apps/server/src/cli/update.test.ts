import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@specweave-studio/shared/hostProcess";

import { nodeBundleLauncherScript } from "../cloud/pinnedRuntime.ts";
import { repointLauncher, resolveLaunchedAs, resolveLauncherPath } from "./update.ts";

it.layer(NodeServices.layer)("specweave-studio update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/specweave-studio");
      const newExe = path.join(root, "runtime/versions/2.0.0/specweave-studio");
      const launcher = path.join(root, "bin/specweave-studio");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/specweave-studio");
      const copy = path.join(root, "copy/specweave-studio");
      const foreign = path.join(root, "foreign/specweave-studio");
      const elsewhere = path.join(root, "elsewhere/specweave-studio");
      // Another install's versions tree: same shape, different home.
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/specweave-studio");
      const otherLauncher = path.join(root, "other/bin/specweave-studio");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-update-" });
      const launcher = path.join(root, "bin/specweave-studio");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "specweave-studio"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "./bin/specweave-studio"),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "specweave-studio"),
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect("repoints a node-bundle launcher found through STUDIO_CLI_NAME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-update-node-bundle-" });
      const versionsDir = path.join(root, "runtime/versions");
      const oldLauncher = path.join(versionsDir, "1.0.0/specweave-studio");
      const newLauncher = path.join(versionsDir, "2.0.0/specweave-studio");
      for (const file of [oldLauncher, newLauncher]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, nodeBundleLauncherScript("/usr/bin/node", false));
        yield* fs.writeFileString(path.join(path.dirname(file), "bin.mjs"), "");
      }
      const binDir = path.join(root, "bin");
      const onPath = path.join(binDir, "specwithcode");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.symlink(oldLauncher, onPath);
      // Under the launcher script argv0 is node, never the launcher.
      const underNode = <A, E, R>(effect: Effect.Effect<A, E, R>, env: Record<string, string>) =>
        effect.pipe(
          Effect.provideService(HostProcessIsExecutable, false),
          Effect.provideService(HostProcessInvokedAs, "/usr/bin/node"),
          Effect.provideService(HostProcessEnvironment, {
            PATH: `${path.join(root, "missing")}:${binDir}`,
            ...env,
          }),
          Effect.provideService(HostProcessWorkingDirectory, root),
        );

      const withoutName = yield* underNode(resolveLaunchedAs, {});
      assert.isUndefined(withoutName);
      const untouched = yield* repointLauncher({
        launchedAs: withoutName,
        versionsDir,
        targetEntryPath: newLauncher,
      });
      assert.equal(untouched._tag, "None");
      assert.equal(yield* fs.readLink(onPath), oldLauncher);

      const launchedAs = yield* underNode(resolveLaunchedAs, { STUDIO_CLI_NAME: "specwithcode" });
      assert.equal(launchedAs, onPath);
      const repointed = yield* repointLauncher({
        launchedAs,
        versionsDir,
        targetEntryPath: newLauncher,
      });
      assert.deepStrictEqual(Option.getOrUndefined(repointed), onPath);
      assert.equal(yield* fs.readLink(onPath), newLauncher);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});
