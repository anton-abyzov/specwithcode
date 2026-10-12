import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layer = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-remote-paths-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("lists and reuses local remotes with spaces without creating another remote", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcs = yield* VcsDriver.VcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio remote paths " });
    const repo = path.join(root, "checkout");
    const fetchUrl = path.join(root, "fetch repository (fetch).git");
    const pushUrl = path.join(root, "push repository (push).git");
    yield* fs.makeDirectory(repo);
    const run = (args: ReadonlyArray<string>) =>
      git.execute({
        cwd: repo,
        args,
        operation: "GitRemotePaths.fixture",
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    yield* run(["init", "--initial-branch=main"]);
    yield* run(["remote", "add", "existing", fetchUrl]);
    yield* run(["remote", "set-url", "--push", "existing", pushUrl]);
    const snapshot = yield* vcs.listRemotes(repo);
    assert.equal(snapshot.remotes.length, 1);
    assert.equal(snapshot.remotes[0]?.name, "existing");
    assert.equal(snapshot.remotes[0]?.url, fetchUrl);
    assert.deepEqual(snapshot.remotes[0]?.pushUrl, Option.some(pushUrl));
    assert.equal(
      yield* git.ensureRemote({ cwd: repo, preferredName: "new-owner", url: fetchUrl }),
      "existing",
    );
    assert.equal((yield* run(["remote"])).stdout.trim(), "existing");
  }).pipe(Effect.provide(layer)),
);
