import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { decodeWorktreeBindings, pathSpellings, worktreeOwnersOf } from "./worktreeOwnership.ts";

const threadRow = (threadId: string, worktreePath: string) => ({
  thread_id: threadId,
  payload_json: JSON.stringify({ worktreePath }),
  deleted_at: null,
  archived_at: null,
  cleanup_failed: 0,
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-owners-" }));
  return { fs, path, root };
});

describe("worktree ownership", () => {
  it.effect("matches a folder recorded through a symlinked parent by its real path", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      const real = path.join(root, "real");
      yield* fs.makeDirectory(path.join(real, "wt"), { recursive: true });
      yield* fs.symlink(real, path.join(root, "link"));
      const linked = path.join(root, "link", "wt");
      const bindings = yield* decodeWorktreeBindings({
        projects: [],
        threads: [threadRow("linked", linked), threadRow("real", path.join(real, "wt"))],
        sessions: [],
      });
      // Either spelling of the target finds both threads.
      for (const target of [linked, path.join(real, "wt")]) {
        const owners = yield* worktreeOwnersOf(bindings, yield* pathSpellings(target), {
          match: "within",
        });
        expect(owners.threads.map((owner) => owner.threadId)).toEqual(["linked", "real"]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a missing folder behind a symlink inside the target bound to it", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      const target = path.join(root, "wt");
      const elsewhere = path.join(root, "elsewhere");
      yield* fs.makeDirectory(target);
      yield* fs.makeDirectory(elsewhere);
      yield* fs.symlink(elsewhere, path.join(target, "link"));
      const bindings = yield* decodeWorktreeBindings({
        projects: [],
        threads: [threadRow("behind-link", path.join(target, "link", "missing"))],
        sessions: [],
      });
      // Removing the target deletes the link, so the recorded folder could no longer resolve.
      expect(bindings.threads[0]!.path).toBe(path.join(elsewhere, "missing"));
      const owners = yield* worktreeOwnersOf(bindings, target, { match: "within" });
      expect(owners.threads.map((owner) => owner.threadId)).toEqual(["behind-link"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
