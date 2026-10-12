import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { refreshProjectUpstreams } from "./automaticPullSafety.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-safe-refresh-home-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("isolates failed and unavailable upstreams while refreshing other projects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-failed-refresh-" });
      const seed = path.join(root, "seed");
      const remote = path.join(root, "remote.git");
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        git
          .execute({ operation: "automaticPullSafety.failure.test", cwd, args, timeoutMs: 10_000 })
          .pipe(Effect.map((result) => result.stdout.trim()));
      yield* run(root, ["init", "--initial-branch=main", seed]);
      yield* run(seed, ["config", "user.email", "test@example.invalid"]);
      yield* run(seed, ["config", "user.name", "Test"]);
      yield* fs.writeFileString(path.join(seed, "README.md"), "original\n");
      yield* run(seed, ["add", "README.md"]);
      yield* run(seed, ["commit", "-m", "base"]);
      yield* run(root, ["init", "--bare", "--initial-branch=main", remote]);
      yield* run(seed, ["remote", "add", "origin", remote]);
      yield* run(seed, ["push", "-u", "origin", "main"]);
      const headBefore = yield* run(seed, ["rev-parse", "HEAD"]);
      const states = ["broken-config", "offline", "healthy"] as const;
      const checkouts = states.map((state) => path.join(root, state));
      const before = new Map<string, { index: string; status: string }>();
      for (const checkout of checkouts) {
        yield* run(root, ["clone", remote, checkout]);
        yield* fs.writeFileString(path.join(checkout, "README.md"), "local agent edit\n");
        yield* fs.writeFileString(path.join(checkout, "staged.txt"), "staged work\n");
        yield* run(checkout, ["add", "staged.txt"]);
        yield* fs.writeFileString(path.join(checkout, "untracked.txt"), "untracked work\n");
        before.set(checkout, {
          index: yield* run(checkout, ["write-tree"]),
          status: yield* run(checkout, ["status", "--porcelain=v1"]),
        });
      }
      yield* fs.writeFileString(path.join(seed, "README.md"), "upstream update\n");
      yield* run(seed, ["add", "README.md"]);
      yield* run(seed, ["commit", "-m", "upstream work"]);
      yield* run(seed, ["push", "origin", "main"]);
      const remoteHead = yield* run(seed, ["rev-parse", "HEAD"]);
      const brokenConfigPath = path.join(checkouts[0]!, ".git", "config");
      const configBefore = yield* fs.readFileString(brokenConfigPath);
      yield* fs.writeFileString(brokenConfigPath, `${configBefore}\n[unfinished-section\n`);
      yield* run(checkouts[1]!, [
        "remote",
        "set-url",
        "origin",
        path.join(root, "unavailable.git"),
      ]);
      const warnings: string[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => warnings.push(String(message)));

      yield* refreshProjectUpstreams(
        checkouts.map((workspaceRoot, index) => ({
          id: ProjectId.make(`test-${states[index]}`),
          workspaceRoot,
        })),
        { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
      ).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.ensuring(fs.writeFileString(brokenConfigPath, configBefore).pipe(Effect.orDie)),
      );

      assert.isTrue(
        warnings.some((warning) => warning.includes("Automatic project upstream refresh failed")),
      );
      assert.isTrue(warnings.some((warning) => warning.includes("Background Git fetch failed")));
      for (const [index, checkout] of checkouts.entries()) {
        assert.equal(
          yield* run(checkout, ["rev-parse", "origin/main"]),
          index === 2 ? remoteHead : headBefore,
        );
        assert.equal(yield* run(checkout, ["rev-parse", "HEAD"]), headBefore);
        assert.equal(yield* run(checkout, ["write-tree"]), before.get(checkout)!.index);
        assert.equal(
          yield* run(checkout, ["status", "--porcelain=v1"]),
          before.get(checkout)!.status,
        );
        assert.equal(
          yield* fs.readFileString(path.join(checkout, "README.md")),
          "local agent edit\n",
        );
        assert.equal(
          yield* fs.readFileString(path.join(checkout, "untracked.txt")),
          "untracked work\n",
        );
      }
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["clean", "dirty", "diverged"] as const)(
  "fetches latest refs while preserving a %s checkout; explicit pulls stay fast-forward only",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-safe-refresh-" });
        const seed = path.join(root, "seed");
        const remote = path.join(root, "remote.git");
        const checkout = path.join(root, "checkout");
        const run = (cwd: string, args: ReadonlyArray<string>) =>
          git
            .execute({
              operation: "automaticPullSafety.test",
              cwd,
              args,
              timeoutMs: 10_000,
            })
            .pipe(Effect.map((result) => result.stdout.trim()));
        const identity = (cwd: string) =>
          run(cwd, ["config", "user.email", "test@example.invalid"]).pipe(
            Effect.andThen(run(cwd, ["config", "user.name", "Test"])),
          );
        yield* run(root, ["init", "--initial-branch=main", seed]);
        yield* identity(seed);
        yield* fs.writeFileString(path.join(seed, "README.md"), "original\n");
        yield* run(seed, ["add", "README.md"]);
        yield* run(seed, ["commit", "-m", "base"]);
        yield* run(root, ["init", "--bare", "--initial-branch=main", remote]);
        yield* run(seed, ["remote", "add", "origin", remote]);
        yield* run(seed, ["push", "-u", "origin", "main"]);
        yield* run(root, ["clone", remote, checkout]);
        yield* identity(checkout);

        if (state === "dirty") {
          yield* fs.writeFileString(path.join(checkout, "README.md"), "agent edit\n");
          yield* fs.writeFileString(path.join(checkout, "staged.txt"), "staged work\n");
          yield* run(checkout, ["add", "staged.txt"]);
          yield* fs.writeFileString(path.join(checkout, "untracked.txt"), "untracked work\n");
        } else if (state === "diverged") {
          yield* fs.writeFileString(path.join(checkout, "local.txt"), "local commit\n");
          yield* run(checkout, ["add", "local.txt"]);
          yield* run(checkout, ["commit", "-m", "local work"]);
        }
        const headBefore = yield* run(checkout, ["rev-parse", "HEAD"]);
        const indexBefore = yield* run(checkout, ["write-tree"]);
        const statusBefore = yield* run(checkout, ["status", "--porcelain=v1"]);
        const contentsBefore = yield* fs.readFileString(path.join(checkout, "README.md"));

        yield* fs.writeFileString(path.join(seed, "README.md"), "upstream update\n");
        yield* run(seed, ["add", "README.md"]);
        yield* run(seed, ["commit", "-m", "upstream work"]);
        yield* run(seed, ["push", "origin", "main"]);
        const remoteHead = yield* run(seed, ["rev-parse", "HEAD"]);
        assert.notEqual(yield* run(checkout, ["rev-parse", "origin/main"]), remoteHead);

        yield* refreshProjectUpstreams(
          [{ id: ProjectId.make("test-project"), workspaceRoot: checkout }],
          { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
        );

        assert.equal(yield* run(checkout, ["rev-parse", "origin/main"]), remoteHead);
        assert.equal(yield* run(checkout, ["rev-parse", "HEAD"]), headBefore);
        assert.equal(yield* run(checkout, ["write-tree"]), indexBefore);
        assert.equal(yield* run(checkout, ["status", "--porcelain=v1"]), statusBefore);
        assert.equal(yield* fs.readFileString(path.join(checkout, "README.md")), contentsBefore);
        if (state === "dirty") {
          assert.equal(
            yield* fs.readFileString(path.join(checkout, "untracked.txt")),
            "untracked work\n",
          );
        } else if (state === "clean") {
          assert.equal((yield* git.pullCurrentBranch(checkout)).status, "pulled");
          assert.equal(yield* run(checkout, ["rev-parse", "HEAD"]), remoteHead);
        } else {
          assert.isTrue(Exit.isFailure(yield* git.pullCurrentBranch(checkout).pipe(Effect.exit)));
          assert.equal(yield* run(checkout, ["rev-parse", "HEAD"]), headBefore);
          assert.equal(yield* run(checkout, ["status", "--porcelain=v1"]), statusBefore);
        }
      }),
    ).pipe(Effect.provide(layerTest)),
);
