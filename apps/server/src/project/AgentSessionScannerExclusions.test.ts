import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeProjectExclusionFilter } from "./AgentSessionScannerExclusions.ts";

it.effect.skipIf(!symlinksSupported)(
  "excludes canonical and symlink spellings of configured roots without excluding siblings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-exclusion-alias-" });
      const root = path.join(temp, "actual"),
        alias = path.join(temp, "configured-alias");
      yield* fs.makeDirectory(path.join(root, "worktrees"), { recursive: true });
      yield* fs.symlink(root, alias);
      const excluded = yield* makeProjectExclusionFilter({
        baseDir: alias,
        worktreesDir: path.join(alias, "worktrees"),
        homeDir: path.join(temp, "home"),
        tempDir: temp,
        caseFold: false,
      });
      const canonical = yield* fs.realPath(root);
      for (const candidate of [
        alias,
        canonical,
        path.join(canonical, "worktrees", "sandbox"),
        path.join(alias, "other-state"),
      ])
        assert.isTrue(excluded(candidate));
      assert.isTrue(excluded(root) || excluded(yield* fs.realPath(root)));
      assert.isFalse(excluded(path.join(temp, "actual-sibling", "project")));
      assert.isFalse(excluded(path.join(temp, "normal-project")));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("normalizes both sides, preserves path boundaries, and folds only Windows case", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "studio-exclusion-case-" });
    const baseDir = path.join(temp, "State");
    yield* fs.makeDirectory(baseDir);
    const input = {
      baseDir,
      worktreesDir: path.join(temp, "external-worktrees"),
      homeDir: path.join(temp, "Home"),
      tempDir: temp,
      caseFold: false,
    };
    const sensitive = yield* makeProjectExclusionFilter(input);
    const insensitive = yield* makeProjectExclusionFilter({ ...input, caseFold: true });
    assert.isFalse(sensitive(path.join(temp, "state", "project")));
    assert.isTrue(insensitive(path.join(temp, "state", "project").replaceAll("/", "\\")));
    assert.isFalse(insensitive(path.join(temp, "StateSibling", "project")));
    assert.isTrue(sensitive(path.join(input.homeDir, "Downloads", "unpacked")));
    assert.isTrue(
      sensitive(path.join(temp, "another-home", ".specweave-studio", "worktrees", "owned")),
    );
    assert.isTrue(sensitive(input.homeDir));
    assert.isFalse(sensitive(path.join(input.homeDir, "source-project")));
  }).pipe(Effect.provide(NodeServices.layer)),
);
