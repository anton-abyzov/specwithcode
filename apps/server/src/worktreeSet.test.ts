// @effect-diagnostics nodeBuiltinImport:off - the planner is pure and takes Node's path for platform cases.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { worktreeFolderName, worktreeSetFolder } from "./worktreePlacement.ts";
import {
  planWorktreeSet,
  readWorktreeSet,
  worktreeSetManifestPath,
  worktreeSetMemberPath,
  writeWorktreeSet,
} from "./worktreeSet.ts";

describe("planWorktreeSet", () => {
  it.effect("mirrors paths under the project root, root first, outside repositories by name", () =>
    Effect.gen(function* () {
      // POSIX inputs and outputs, so the case reads the same on Windows.
      const path = NodePath.posix;
      const members = planWorktreeSet(
        "/work/umbrella",
        [
          { path: "repositories/acme/web" },
          { path: "/elsewhere/tools", id: "tools" },
          { path: "." },
          { path: "repositories/acme" },
          { path: "/other/tools" },
          { path: "repositories/acme/web" },
        ],
        path,
      );
      expect(members.map((member) => [member.relativePath, member.id ?? null])).toEqual([
        ["", null],
        ["repositories/acme", null],
        ["repositories/acme/web", null],
        ["tools", "tools"],
        ["tools-2", null],
      ]);
      expect(worktreeSetMemberPath("/w/set", members[0]!, path)).toBe("/w/set");
      expect(worktreeSetMemberPath("/w/set", members[2]!, path)).toBe(
        "/w/set/repositories/acme/web",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("keeps an outside repository's name clear of a top folder inside the root", () => {
    const members = planWorktreeSet(
      "/work/root",
      [{ path: "tools/cli" }, { path: "/elsewhere/tools" }],
      NodePath.posix,
    );
    expect(members.map((member) => member.relativePath)).toEqual(["tools/cli", "tools-2"]);
  });
});

describe("worktree set folder", () => {
  it.effect("sits under the managed worktrees folder by project and branch", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        worktreeSetFolder({
          setting: "",
          defaultDir: "/home/me/.specwithcode/worktrees",
          projectRoot: "/work/umbrella",
          branch: "feat/multi-repo",
          path,
        }),
      ).toBe(path.join("/home/me/.specwithcode/worktrees", "umbrella", "feat-multi-repo"));
      expect(worktreeFolderName("feat/" + "x".repeat(60))).toMatch(/^feat-x{18}-[0-9a-f]{16}$/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records its members beside the folder, so a deleted folder keeps them", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const folder = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "set-" }), "feature");
      expect(worktreeSetManifestPath(folder, path)).toBe(
        path.join(path.dirname(folder), ".feature.worktree-set.json"),
      );
      expect(yield* readWorktreeSet(folder)).toBeNull();
      yield* writeWorktreeSet(folder, [{ repository: "/r", relativePath: "", id: "root" }]);
      expect(yield* readWorktreeSet(folder)).toEqual({
        version: 1,
        members: [{ repository: "/r", relativePath: "", id: "root" }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
