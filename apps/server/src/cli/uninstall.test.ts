import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@specweave-studio/shared/hostProcess";

import { findOwnedLauncher } from "./uninstall.ts";
import { resolveLaunchedAs } from "./update.ts";

it.layer(NodeServices.layer)("specweave-studio uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/specweave-studio");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/specweave-studio");
      const copy = path.join(root, "copy/specweave-studio");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/specweave-studio");
      const theirs = path.join(root, "other/bin/specweave-studio");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
  // The node-bundle launcher is a POSIX shell script behind a symlink; Windows
  // installs a .cmd shim, found through findWindowsShim instead.
  it.effect.skipIf(process.platform === "win32")(
    "claims a node-bundle launcher only through STUDIO_CLI_NAME",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-uninstall-node-bundle-" });
        const versionsDir = path.join(root, "runtime/versions");
        const launcher = path.join(versionsDir, "1.0.0/specweave-studio");
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.writeFileString(launcher, "#!/bin/sh\n");
        const onPath = path.join(root, "bin/specwithcode");
        yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
        yield* fs.symlink(launcher, onPath);
        const launchedAs = (env: Record<string, string>) =>
          resolveLaunchedAs.pipe(
            Effect.provideService(HostProcessIsExecutable, false),
            Effect.provideService(HostProcessInvokedAs, "node"),
            Effect.provideService(HostProcessEnvironment, { PATH: path.dirname(onPath), ...env }),
            Effect.provideService(HostProcessWorkingDirectory, root),
          );

        assert.equal(
          yield* findOwnedLauncher({
            launchedAs: yield* launchedAs({ STUDIO_CLI_NAME: "specwithcode" }),
            versionsDir,
          }),
          onPath,
        );
        assert.isUndefined(
          yield* findOwnedLauncher({ launchedAs: yield* launchedAs({}), versionsDir }),
        );
      }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});
