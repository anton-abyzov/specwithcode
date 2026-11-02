// @effect-diagnostics nodeBuiltinImport:off - expected paths use this platform's separator.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServicesPath from "@effect/platform-node/NodePath";
import { expect, it, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

import {
  makeFirstPassOfRun,
  makeRepositorySyncRuntime,
  quietRepeatedSkips,
  threadFolders,
} from "./ProjectRepositorySync.ts";

const skipped = {
  title: "Repositories not updated",
  message: "Didn't update a: it's on fix/x, not main.",
  skipped: "Didn't update a: it's on fix/x, not main.",
};

it("tells a project about the same skips once an hour", () => {
  const project = "project-quiet";
  expect(quietRepeatedSkips(project, skipped, 1_000)).toEqual(skipped);
  expect(quietRepeatedSkips(project, skipped, 2_000)).toBeNull();
  expect(quietRepeatedSkips(project, skipped, 1_000 + 60 * 60 * 1000)).toEqual(skipped);
});

it("still reports updates when only the skips repeat", () => {
  const project = "project-updates";
  quietRepeatedSkips(project, skipped, 1_000);
  const both = {
    title: "Updated repositories",
    message: `Updated from origin: b.\n${skipped.message}`,
    skipped: skipped.skipped,
  };
  expect(quietRepeatedSkips(project, both, 2_000)?.message).toBe("Updated from origin: b.");
});

it("tells again as soon as what was skipped changes", () => {
  const project = "project-changes";
  quietRepeatedSkips(project, skipped, 1_000);
  const other = { ...skipped, message: "Didn't update b: x.", skipped: "Didn't update b: x." };
  expect(quietRepeatedSkips(project, other, 2_000)).toEqual(other);
});

it("counts a running thread's saved repositories as in use", () => {
  const project = {
    workspaceRoot: "/work/app",
    workspaceSettings: {
      environment: {
        additionalFolders: ["/work/y"],
        repositories: [
          { id: "m", localPath: null },
          { id: "x", localPath: "/work/x" },
        ],
      },
    },
  } as never;
  expect(threadFolders(null, project)).toEqual([
    "/work/app",
    "/work/y",
    NodePath.join("/work/app", ".studio-repositories", "m"),
    "/work/x",
  ]);
  expect(threadFolders("/trees/a", project)).toEqual([
    "/trees/a",
    "/work/y",
    NodePath.join("/work/app", ".studio-repositories", "m"),
    "/work/x",
  ]);
  expect(threadFolders("/trees/a", null)).toEqual(["/trees/a"]);
});

it("syncs a run once across prepare, start and retries", () => {
  const firstPass = makeFirstPassOfRun();
  expect(firstPass("run-1")).toBe(true);
  expect(firstPass("run-1")).toBe(false);
  expect(firstPass("run-2")).toBe(true);
});

/** A folder holding one clean checkout that is a commit behind and one with a change. */
function folderWithCheckouts() {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-chat-")));
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const origin = NodePath.join(base, "origin.git");
  const seed = NodePath.join(base, "seed");
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(base, "clone", "--quiet", origin, seed);
  git(seed, "switch", "--quiet", "-c", "main");
  NodeFS.writeFileSync(NodePath.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "main");
  const root = NodePath.join(base, "scratch");
  const behind = NodePath.join(root, "other-chat", "behind");
  const dirty = NodePath.join(root, "other-chat", "dirty");
  git(base, "clone", "--quiet", origin, behind);
  git(base, "clone", "--quiet", origin, dirty);
  NodeFS.writeFileSync(NodePath.join(dirty, "note.txt"), "unsaved\n");
  NodeFS.writeFileSync(NodePath.join(seed, "b.txt"), "two\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "second");
  git(seed, "push", "--quiet", "origin", "main");
  return {
    base,
    root,
    head: () => git(behind, "rev-parse", "HEAD"),
    origin: git(seed, "rev-parse", "HEAD"),
  };
}

let turns = 0;

async function firstTurnIn(
  project: Record<string, unknown>,
  baseDir: string,
): Promise<{ readonly messages: ReadonlyArray<string>; readonly started: number }> {
  const turn = ++turns;
  const messages: Array<string> = [];
  const write = vi.fn((input: { readonly events: ReadonlyArray<any> }) =>
    Effect.sync(() => void messages.push(input.events[0].payload.message)),
  );
  const startTurn = vi.fn(() => Effect.succeed({} as never));
  const layer = Layer.mergeAll(
    IdAllocator.layer,
    Layer.mock(EventSink.EventSinkV2)({ write: write as never }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
    }),
    Layer.succeed(ServerConfig.ServerConfig, { baseDir } as never),
    NodeServicesPath.layer,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const wrap = yield* makeRepositorySyncRuntime;
      const session = wrap(
        { startTurn } as never,
        () => Effect.succeed(Option.some(project as never)),
        "claudeAgent" as never,
      );
      yield* session.startTurn({
        threadId: "thread",
        runId: `run-${turn}`,
        rootNodeId: "node",
        runOrdinal: 1,
        providerThread: { id: "provider-thread" },
        appThread: { projectId: `project-${turn}` },
      } as never);
    }).pipe(Effect.provide(layer)),
  );
  return { messages, started: startTurn.mock.calls.length };
}

it("leaves other chats' checkouts alone and says nothing in a chat with no project", async () => {
  const { base, root, head, origin } = folderWithCheckouts();
  const before = head();
  try {
    const turn = await firstTurnIn({ id: "scratch", workspaceRoot: root }, base);
    expect(turn).toEqual({ messages: [], started: 1 });
    expect(head()).toBe(before);
    expect(head()).not.toBe(origin);
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

it("leaves an assistant's folder alone", async () => {
  const { base, root, head } = folderWithCheckouts();
  const before = head();
  try {
    const turn = await firstTurnIn(
      { id: "aide", workspaceRoot: root, workspaceSettings: { kind: "personal" } },
      NodePath.join(base, "elsewhere"),
    );
    expect(turn).toEqual({ messages: [], started: 1 });
    expect(head()).toBe(before);
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

it("updates and reports a real project's repositories in plain words", async () => {
  const { base, root, head, origin } = folderWithCheckouts();
  try {
    const turn = await firstTurnIn(
      { id: "code", workspaceRoot: root },
      NodePath.join(base, "elsewhere"),
    );
    expect(turn.started).toBe(1);
    expect(turn.messages).toEqual([
      "Updated from origin: behind.\nDidn't update dirty: it has 1 uncommitted change.",
    ]);
    expect(head()).toBe(origin);
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
