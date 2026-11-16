import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  decodeWorktreeBindings,
  isOpenThreadOwner,
  ownWorktreeThreadState,
  pathSpellings,
  withBusyThreads,
  worktreeOwnersOf,
  worktreeThreadState,
} from "./worktreeOwnership.ts";

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

  it.effect(
    "gives a quiet sub-chat in its parent's folder the parent's state, along the chain",
    () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* fixture;
        const folder = path.join(root, "worker");
        const elsewhere = path.join(root, "elsewhere");
        yield* fs.makeDirectory(folder);
        yield* fs.makeDirectory(elsewhere);
        const row = (
          threadId: string,
          worktreePath: string,
          options: {
            readonly parent?: string;
            /** The parent is the chat it was forked from, not the one that started it. */
            readonly fork?: boolean;
            readonly settled?: boolean;
            readonly archived?: boolean;
            readonly deleted?: boolean;
            readonly busy?: boolean;
          } = {},
        ) => ({
          thread_id: threadId,
          payload_json: JSON.stringify({
            worktreePath,
            ...(options.settled ? { settledOverride: "settled" } : {}),
            ...(options.parent === undefined
              ? {}
              : {
                  lineage: {
                    parentThreadId: options.parent,
                    relationshipToParent: options.fork === true ? "fork" : "subagent",
                    rootThreadId: "worker",
                  },
                }),
          }),
          deleted_at: options.deleted ? "2026-11-01T00:00:00.000Z" : null,
          archived_at: options.archived ? "2026-11-01T00:00:00.000Z" : null,
          cleanup_failed: 0,
          busy: options.busy ? 1 : 0,
        });
        const bindings = yield* decodeWorktreeBindings({
          projects: [],
          threads: [
            row("worker", folder, { settled: true }),
            row("review", folder, { parent: "worker" }),
            row("review-of-review", folder, { parent: "review" }),
            row("busy-review", folder, { parent: "worker", busy: true }),
            // Archived itself, but a run of it is in progress.
            row("busy-archived-review", folder, { parent: "worker", archived: true, busy: true }),
            row("moved-review", elsewhere, { parent: "worker" }),
            row("orphan-review", folder, { parent: "gone" }),
            // Forked from the worker: a chat of its own in the same folder.
            row("fork", folder, { parent: "worker", fork: true }),
            row("cycle-a", elsewhere, { parent: "cycle-b" }),
            row("cycle-b", elsewhere, { parent: "cycle-a", settled: true }),
            row("deleted-parent", elsewhere, { deleted: true }),
            row("child-of-deleted", elsewhere, { parent: "deleted-parent", settled: true }),
          ],
          sessions: [],
        });
        const state = (id: string) =>
          worktreeThreadState(bindings.threads.find((owner) => owner.threadId === id)!);
        expect(state("review")).toBe("settled");
        expect(state("review-of-review")).toBe("settled");
        expect(state("busy-review")).toBe("open");
        expect(state("busy-archived-review")).toBe("open");
        // Another folder, a parent that is not listed, or a deleted parent: its own state.
        expect(state("moved-review")).toBe("open");
        expect(state("orphan-review")).toBe("open");
        expect(state("child-of-deleted")).toBe("settled");
        // A fork never follows the chat it came from.
        expect(state("fork")).toBe("open");
        // A cycle ends; neither thread loops or loses its record.
        expect(["open", "settled"]).toContain(state("cycle-a"));
        expect(state("cycle-b")).toBe("settled");
        // The raw state stays readable.
        const review = bindings.threads.find((owner) => owner.threadId === "review")!;
        expect(ownWorktreeThreadState(review)).toBe("open");
        expect(review.parentThreadId).toBe("worker");
        // The folder is in use only through the busy reviews.
        const owners = yield* worktreeOwnersOf(bindings, folder, { match: "within" });
        expect(owners.threads.filter(isOpenThreadOwner).map((owner) => owner.threadId)).toEqual([
          "busy-review",
          "busy-archived-review",
          "orphan-review",
          "fork",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a sub-chat row without a run reading as busy", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* fixture;
      const folder = path.join(root, "worker");
      yield* fs.makeDirectory(folder);
      const bindings = yield* decodeWorktreeBindings({
        projects: [],
        threads: [
          {
            ...threadRow("worker", folder),
            payload_json: JSON.stringify({ worktreePath: folder, settledOverride: "settled" }),
          },
          {
            ...threadRow("review", folder),
            payload_json: JSON.stringify({
              worktreePath: folder,
              lineage: { parentThreadId: "worker", relationshipToParent: "subagent" },
            }),
          },
        ],
        sessions: [],
      });
      expect(bindings.threads.map(worktreeThreadState)).toEqual(["settled", "open"]);
      // Marked from the runs table, the finished review follows its worker.
      const marked = yield* decodeWorktreeBindings({
        projects: [],
        threads: withBusyThreads(
          [
            {
              ...threadRow("worker", folder),
              payload_json: JSON.stringify({ worktreePath: folder, settledOverride: "settled" }),
            },
            {
              ...threadRow("review", folder),
              payload_json: JSON.stringify({
                worktreePath: folder,
                lineage: { parentThreadId: "worker", relationshipToParent: "subagent" },
              }),
            },
          ],
          [{ thread_id: "someone-else" }],
        ),
        sessions: [],
      });
      expect(marked.threads.map(worktreeThreadState)).toEqual(["settled", "settled"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
