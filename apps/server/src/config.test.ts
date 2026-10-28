import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

it.layer(NodeServices.layer)("ensureServerDirectories", (it) => {
  const ensureIn = (platform: NodeJS.Platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-config-test-" });
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* ServerConfig.ensureServerDirectories(derivedPaths).pipe(
        Effect.provideService(HostProcessPlatform, platform),
      );
      const marker = path.join(derivedPaths.worktreesDir, ServerConfig.SPOTLIGHT_NEVER_INDEX_FILE);
      return { fs, derivedPaths, marker };
    });

  it.effect("keeps Spotlight out of the worktrees folder on macOS", () =>
    Effect.gen(function* () {
      const { fs, marker } = yield* ensureIn("darwin");
      assert.isTrue(yield* fs.exists(marker));
      assert.equal(yield* fs.readFileString(marker), "");
    }),
  );

  it.effect("leaves the worktrees folder alone on other platforms", () =>
    Effect.gen(function* () {
      const { fs, derivedPaths, marker } = yield* ensureIn("linux");
      assert.isTrue(yield* fs.exists(derivedPaths.worktreesDir));
      assert.isFalse(yield* fs.exists(marker));
    }),
  );

  it.effect("never fails startup when the marker cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-config-test-" });
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      // A folder where the marker file belongs makes the write fail.
      yield* fs.makeDirectory(
        path.join(derivedPaths.worktreesDir, ServerConfig.SPOTLIGHT_NEVER_INDEX_FILE),
        { recursive: true },
      );
      yield* ServerConfig.ensureServerDirectories(derivedPaths).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
    }),
  );

  it.effect("keeps an existing marker's contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-config-test-" });
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const marker = path.join(derivedPaths.worktreesDir, ServerConfig.SPOTLIGHT_NEVER_INDEX_FILE);
      yield* fs.makeDirectory(derivedPaths.worktreesDir, { recursive: true });
      yield* fs.writeFileString(marker, "kept");
      yield* ServerConfig.ensureServerDirectories(derivedPaths).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      assert.equal(yield* fs.readFileString(marker), "kept");
    }),
  );
});
