import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readSpecweaveCheckpointPreface,
  specweaveStudioCheckpointPath,
} from "./SpecweaveCheckpoint.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-specweave-" });
  const worktree = path.join(home, "repo");
  const snapshot = path.join(home, ".specweave", "checkpoints", "abc", "snapshot-1");
  yield* fs.makeDirectory(path.join(worktree, "src"), { recursive: true });
  yield* fs.makeDirectory(snapshot, { recursive: true });
  yield* fs.writeFileString(path.join(snapshot, "handoff.md"), "# Handoff\n\nNext: finish T-02.\n");
  yield* fs.writeFileString(path.join(snapshot, "handoff.diff"), "diff --git a b\n");
  const pointer = specweaveStudioCheckpointPath("thread:1", home);
  yield* fs.makeDirectory(path.dirname(pointer), { recursive: true });
  yield* fs.writeFileString(
    pointer,
    JSON.stringify({
      version: 1,
      sessionId: "s1",
      cwd: worktree,
      savedAt: "2026-10-09T18:00:00.000Z",
      docPath: path.join(snapshot, "handoff.md"),
      diffPath: path.join(snapshot, "handoff.diff"),
      incrementId: "0001-login",
    }),
  );
  return { home, worktree, path, fs, pointer };
});

it.effect("puts the checkpoint note after a header naming the increment and diff", () =>
  Effect.gen(function* () {
    const { home, worktree, path } = yield* setup;
    const preface = yield* readSpecweaveCheckpointPreface({
      threadId: "thread:1",
      cwd: path.join(worktree, "src"),
      home,
    });
    assert.ok(preface !== null);
    assert.match(preface, /^SpecWeave checkpoint .*increment 0001-login.*\. Diff: .*handoff\.diff\n# Handoff/);
    assert.ok(preface.includes("Next: finish T-02."));
    assert.equal(
      yield* readSpecweaveCheckpointPreface({ threadId: "thread:1", cwd: home, home }),
      null,
      "another worktree",
    );
    assert.equal(
      yield* readSpecweaveCheckpointPreface({ threadId: "thread:2", cwd: worktree, home }),
      null,
      "no pointer",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("truncates a long note and ignores a malformed pointer", () =>
  Effect.gen(function* () {
    const { home, worktree, fs, pointer } = yield* setup;
    const preface = yield* readSpecweaveCheckpointPreface({
      threadId: "thread:1",
      cwd: worktree,
      home,
      maxChars: 12,
    });
    assert.ok(preface?.includes("[... note truncated; read "));
    yield* fs.writeFileString(pointer, "{not json");
    assert.equal(
      yield* readSpecweaveCheckpointPreface({ threadId: "thread:1", cwd: worktree, home }),
      null,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
