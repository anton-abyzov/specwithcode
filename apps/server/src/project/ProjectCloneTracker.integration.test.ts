import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { OrchestrationDispatchCommandError, ProjectId } from "@specweave-studio/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native Git creates the independent repository fixture for the Effect clone tracker.
import { execFileSync } from "node:child_process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as Registry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Tracker from "./ProjectCloneTracker.ts";

// The transport is real git against a test-owned local repository. No remote,
// authentication helper, personal Git configuration, or native AI process runs.
const layer = Repositories.layer.pipe(
  Layer.provide(Git.layer),
  Layer.provide(
    Layer.mock(Registry.SourceControlProviderRegistry)({ resolveLink: () => undefined }),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "clone-integration-config-" }),
  ),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);
const pid = ProjectId.make("clone-integration");
const tick = Effect.promise(() => Effect.runPromise(Effect.sleep(10)));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "clone-boundary-" })
    .pipe(Effect.flatMap(fs.realPath));
  const source = `${root}/source`;
  const destination = `${root}/checkout`;
  const seed = (at: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(at, { recursive: true });
      yield* fs.writeFileString(`${at}/owned.txt`, "repository contents\n");
      yield* Effect.sync(() => {
        const options = {
          cwd: at,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          stdio: "pipe" as const,
        };
        execFileSync("git", ["init", "-q"], options);
        execFileSync("git", ["add", "owned.txt"], options);
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "Owned fixture",
          ],
          options,
        );
      });
    });
  yield* seed(source);
  const real = yield* Repositories.SourceControlRepositoryService;
  const release = yield* Deferred.make<void>();
  const entered = yield* Deferred.make<void>();
  let gated = false;
  let partial = false;
  const repositories = Repositories.SourceControlRepositoryService.of({
    ...real,
    cloneRepository: (input, options) =>
      Effect.gen(function* () {
        if (gated) {
          if (partial) {
            yield* fs.makeDirectory(input.destinationPath, { recursive: true }).pipe(Effect.orDie);
            yield* Effect.sync(() =>
              execFileSync("git", ["init", "-q", input.destinationPath], {
                env: {
                  PATH: process.env.PATH,
                  GIT_CONFIG_GLOBAL: "/dev/null",
                  GIT_CONFIG_NOSYSTEM: "1",
                  HOME: root,
                },
              }),
            );
            yield* fs
              .writeFileString(`${input.destinationPath}/partial`, "incomplete")
              .pipe(Effect.orDie);
          }
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return yield* real.cloneRepository(input, options);
      }),
  });
  const tracker = yield* Tracker.make.pipe(
    Effect.provideService(Repositories.SourceControlRepositoryService, repositories),
  );
  const created: string[] = [];
  const refreshed: string[] = [];
  const hooks: Tracker.ProjectCloneHooks = {
    createProject: ({ workspaceRoot }) =>
      Effect.sync(() => {
        created.push(workspaceRoot);
      }),
    onCloned: ({ workspaceRoot }) =>
      Effect.sync(() => {
        refreshed.push(workspaceRoot);
      }),
  };
  const input = {
    projectId: pid,
    title: "Owned clone",
    createdAt: "2026-10-09T00:00:00.000Z",
    remoteUrl: source,
    destinationPath: destination,
  };
  const wait = (phase: string) =>
    Effect.gen(function* () {
      for (let n = 0; n < 300; n++) {
        const state = yield* tracker.get(pid);
        if (state?.phase === phase) return state;
        yield* tick;
      }
      throw new Error(`Clone did not reach ${phase}`);
    });
  return {
    fs,
    root,
    source,
    destination,
    seed,
    tracker,
    input,
    hooks,
    created,
    refreshed,
    wait,
    entered,
    release,
    gate: (writePartial = false) => {
      gated = true;
      partial = writePartial;
    },
    ungate: () => {
      gated = false;
    },
  };
});

it.effect(
  "clones real content, publishes progress and keeps a completed checkout after discard",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const updates = yield* f.tracker.stream.pipe(
        Stream.takeUntil((rows) => rows[0]?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const result = yield* f.tracker.start(f.input, f.hooks);
      expect(result.cwd).toBe(f.destination);
      expect(f.created).toEqual([f.destination]);
      yield* f.wait("done");
      const observed = yield* Fiber.join(updates);
      expect(observed.some((rows) => rows[0]?.phase === "running")).toBe(true);
      expect(observed.at(-1)?.[0]).toMatchObject({ phase: "done", percent: 100, error: null });
      expect(yield* f.fs.readFileString(`${f.destination}/owned.txt`)).toBe(
        "repository contents\n",
      );
      expect(yield* f.tracker.cancel(pid)).toBe(false);
      expect(yield* f.tracker.retry(pid)).toBe(false);
      yield* Tracker.rejectCommandsDuringClone(f.tracker, {
        type: "thread.create",
        projectId: pid,
      });
      yield* f.tracker.discard(pid);
      expect(yield* f.tracker.get(pid)).toBeNull();
      expect(yield* f.fs.exists(`${f.destination}/.git`)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect("retains git's failure then retries once the local source becomes available", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const delayedSource = `${f.root}/later-source`;
    yield* f.tracker.start({ ...f.input, remoteUrl: delayedSource }, f.hooks);
    expect((yield* f.wait("failed")).error).toContain("does not exist");
    expect(
      (yield* Effect.flip(
        Tracker.rejectCommandsDuringClone(f.tracker, { type: "thread.create", projectId: pid }),
      )).message,
    ).toContain("Retry the clone first");
    yield* f.seed(delayedSource);
    expect(yield* f.tracker.retry(pid)).toBe(true);
    yield* f.wait("done");
    expect(yield* f.fs.readFileString(`${f.destination}/owned.txt`)).toBe("repository contents\n");
    expect(f.created).toHaveLength(1);
    yield* TestClock.adjust("31 seconds");
    expect(yield* f.tracker.get(pid)).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("cancel clears only the owned partial contents and retry creates a complete clone", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(`${f.root}/neighbor`, "keep");
    f.gate(true);
    yield* f.tracker.start(f.input, f.hooks);
    yield* Deferred.await(f.entered);
    expect(yield* f.fs.exists(`${f.destination}/partial`)).toBe(true);
    expect(yield* f.tracker.cancel(pid)).toBe(true);
    expect((yield* f.tracker.get(pid))?.phase).toBe("cancelled");
    expect(yield* f.fs.readDirectory(f.destination)).toEqual([]);
    expect(yield* f.fs.readFileString(`${f.root}/neighbor`)).toBe("keep");
    expect(yield* f.tracker.cancel(pid)).toBe(false);
    f.ungate();
    expect(yield* f.tracker.retry(pid)).toBe(true);
    yield* f.wait("done");
    expect(yield* f.fs.exists(`${f.destination}/owned.txt`)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("serializes competing starts and discards an in-flight checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.gate();
    yield* f.tracker.start(f.input, f.hooks);
    yield* Deferred.await(f.entered);
    expect(
      (yield* Effect.flip(
        Tracker.rejectCommandsDuringClone(f.tracker, { type: "thread.create", projectId: pid }),
      )).message,
    ).toContain("still being cloned");
    expect(
      (yield* Effect.flip(
        Tracker.rejectCommandsDuringClone(f.tracker, {
          type: "thread.turn.start",
          bootstrap: { createThread: { projectId: pid } },
        }),
      )).message,
    ).toContain("still being cloned");
    yield* Tracker.rejectCommandsDuringClone(f.tracker, {
      type: "thread.turn.start",
      bootstrap: null,
    });
    yield* Tracker.rejectCommandsDuringClone(f.tracker, { type: "project.update", projectId: pid });
    const duplicate = yield* Effect.flip(
      f.tracker.start({ ...f.input, projectId: ProjectId.make("other") }, f.hooks),
    );
    expect(duplicate).toMatchObject({
      detail: "A clone into this destination is already in progress.",
    });
    expect(f.created).toHaveLength(1);
    expect(yield* f.tracker.retry(pid)).toBe(false);
    yield* f.tracker.discard(pid);
    expect(yield* f.tracker.get(pid)).toBeNull();
    expect(yield* f.fs.readDirectory(f.destination)).toEqual([]);
    expect(yield* f.tracker.cancel(pid)).toBe(false);
    expect(yield* f.tracker.retry(pid)).toBe(false);
    yield* f.tracker.discard(pid);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects a nonempty destination before project creation and releases a failed project claim",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(f.destination);
      yield* f.fs.writeFileString(`${f.destination}/keep`, "owned existing content");
      expect(yield* Effect.flip(f.tracker.start(f.input, f.hooks))).toMatchObject({
        detail: "Destination path already exists and is not empty.",
      });
      expect(f.created).toHaveLength(0);
      expect(yield* f.fs.readFileString(`${f.destination}/keep`)).toBe("owned existing content");
      const input = { ...f.input, destinationPath: `${f.root}/second` };
      const rejected = yield* Effect.flip(
        f.tracker.start(input, {
          ...f.hooks,
          createProject: () =>
            Effect.fail(
              new OrchestrationDispatchCommandError({ message: "project transaction rejected" }),
            ),
        }),
      );
      expect(rejected.message).toContain("transaction rejected");
      expect(yield* f.tracker.get(pid)).toBeNull();
      expect(yield* f.fs.exists(input.destinationPath)).toBe(false);
      yield* f.tracker.start(input, f.hooks);
      yield* f.wait("done");
      expect(yield* f.fs.exists(`${input.destinationPath}/owned.txt`)).toBe(true);
    }).pipe(Effect.provide(layer)),
);
