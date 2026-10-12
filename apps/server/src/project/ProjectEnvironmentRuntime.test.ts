import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type Project,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeEnvironmentRuntime } from "./ProjectEnvironmentRuntime.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
const turn = () =>
  ({
    appThread: { projectId: ProjectId.make("p") },
    threadId: ThreadId.make("t"),
    runId: RunId.make("r"),
    providerThread: { id: ProviderThreadId.make("pt") },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    message: { text: "user", attachments: [], createdBy: "user", creationSource: "web" },
    runtimePolicy: { cwd: "/main", runtimeMode: "auto", interactionMode: "default" },
  }) as unknown as ProviderAdapterV2TurnInput;
it.layer(NodeServices.layer)("project folder runtime boundary", (it) => {
  it.effect(
    "passes canonical approvals to both supported drivers and reflects removed approvals next turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-runtime-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = `${root}/main`;
        const extra = `${root}/extra`;
        yield* fs.makeDirectory(main);
        yield* fs.makeDirectory(extra);
        const wrap = yield* makeEnvironmentRuntime;
        const received: ProviderAdapterV2TurnInput[] = [];
        let project = {
          id: ProjectId.make("p"),
          workspaceRoot: main,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: { additionalFolders: [extra], repositories: [] },
          },
        } as unknown as Project;
        for (const driver of ["codex", "claudeAgent"]) {
          const session = {
            driver: ProviderDriverKind.make(driver),
            startTurn: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
              }),
            compactThread: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
              }),
          } as unknown as ProviderAdapterV2SessionRuntime;
          const runtime = wrap(session, () => Effect.succeed(Option.some(project)));
          yield* runtime.startTurn(turn());
          yield* runtime.compactThread!(turn());
        }
        assert.equal(received.length, 4);
        for (const input of received)
          assert.deepEqual(input.projectAdditionalDirectories, [main, extra]);
        project = {
          ...project,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: { additionalFolders: [], repositories: [] },
          },
        };
        yield* wrap(
          {
            driver: ProviderDriverKind.make("codex"),
            startTurn: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
              }),
          } as unknown as ProviderAdapterV2SessionRuntime,
          () => Effect.succeed(Option.some(project)),
        ).startTurn(turn());
        assert.isUndefined(received[4]?.projectAdditionalDirectories);
      }),
  );
  it.effect(
    "fails closed for unsupported providers, moved approved symlinks and missing projects",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-boundary-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = `${root}/main`;
        const extra = `${root}/extra`;
        yield* fs.makeDirectory(main);
        yield* fs.makeDirectory(extra);
        const wrap = yield* makeEnvironmentRuntime;
        let called = 0;
        const session = {
          driver: ProviderDriverKind.make("grok"),
          startTurn: () =>
            Effect.sync(() => {
              called++;
            }),
        } as unknown as ProviderAdapterV2SessionRuntime;
        const project = {
          id: ProjectId.make("p"),
          workspaceRoot: main,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: { additionalFolders: [extra], repositories: [] },
          },
        } as unknown as Project;
        const runtime = wrap(session, () => Effect.succeed(Option.some(project)));
        assert.equal(
          (yield* runtime.startTurn(turn()).pipe(Effect.flip))._tag,
          "ProviderAdapterTurnStartError",
        );
        yield* fs.remove(extra, { recursive: true });
        yield* fs.symlink(main, extra);
        assert.equal(
          (yield* wrap({ ...session, driver: ProviderDriverKind.make("codex") }, () =>
            Effect.succeed(Option.some(project)),
          )
            .startTurn(turn())
            .pipe(Effect.flip))._tag,
          "ProviderAdapterTurnStartError",
        );
        assert.equal(
          (yield* wrap(session, () => Effect.succeed(Option.none()))
            .startTurn(turn())
            .pipe(Effect.flip))._tag,
          "ProviderAdapterTurnStartError",
        );
        assert.equal(called, 0);
      }),
  );
  it.effect(
    "grants the configured umbrella beside a worktree and refuses unsupported drivers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-worktree-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = `${root}/umbrella`;
        const worktree = `${root}/worktree`;
        yield* fs.makeDirectory(main);
        yield* fs.makeDirectory(worktree);
        const wrap = yield* makeEnvironmentRuntime;
        const seen: ProviderAdapterV2TurnInput[] = [];
        const project = {
          id: ProjectId.make("p"),
          workspaceRoot: main,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: {
              additionalFolders: [],
              repositories: [
                { id: "code", url: "https://github.com/synthetic/code", localPath: main },
              ],
            },
          },
        } as unknown as Project;
        const input = { ...turn(), runtimePolicy: { ...turn().runtimePolicy, cwd: worktree } };
        const session = {
          driver: ProviderDriverKind.make("codex"),
          startTurn: (value: ProviderAdapterV2TurnInput) =>
            Effect.sync(() => {
              seen.push(value);
            }),
        } as unknown as ProviderAdapterV2SessionRuntime;
        yield* wrap(session, () => Effect.succeed(Option.some(project))).startTurn(input);
        assert.equal(seen[0]?.runtimePolicy.cwd, worktree);
        assert.deepEqual(seen[0]?.projectAdditionalDirectories, [main]);
        const unsupported = wrap({ ...session, driver: ProviderDriverKind.make("grok") }, () =>
          Effect.succeed(Option.some(project)),
        );
        assert.equal(
          (yield* unsupported.startTurn(input).pipe(Effect.flip))._tag,
          "ProviderAdapterTurnStartError",
        );
        const external = wrap(session, () => Effect.succeed(Option.some(project)));
        assert.equal(
          (yield* external
            .startTurn({
              ...input,
              runtimePolicy: { ...input.runtimePolicy, sandboxPolicy: { type: "externalSandbox" } },
            })
            .pipe(Effect.flip))._tag,
          "ProviderAdapterTurnStartError",
        );
        assert.equal(seen.length, 1);
      }),
  );
  it.effect("rejects a replaced primary folder before passing any grant to an adapter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "environment-main-identity-" })
        .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
      const main = `${root}/main`;
      const outside = `${root}/outside`;
      yield* fs.makeDirectory(main);
      yield* fs.makeDirectory(outside);
      const project = {
        id: ProjectId.make("p"),
        workspaceRoot: main,
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          environment: {
            additionalFolders: [],
            repositories: [
              { id: "repo", url: "https://github.com/synthetic/repo", localPath: null },
            ],
          },
        },
      } as unknown as Project;
      yield* fs.rename(main, `${root}/retained-main`);
      yield* fs.symlink(outside, main);
      let calls = 0;
      const wrap = yield* makeEnvironmentRuntime;
      const runtime = wrap(
        {
          driver: ProviderDriverKind.make("codex"),
          startTurn: () =>
            Effect.sync(() => {
              calls++;
            }),
        } as unknown as ProviderAdapterV2SessionRuntime,
        () => Effect.succeed(Option.some(project)),
      );
      assert.equal(
        (yield* runtime.startTurn(turn()).pipe(Effect.flip))._tag,
        "ProviderAdapterTurnStartError",
      );
      assert.equal(calls, 0);
    }),
  );
});
it.effect("Codex writable-root grants preserve approval, sandbox and network restrictions", () =>
  Effect.gen(function* () {
    const input = {
      nativeThreadId: "native",
      codexInput: [{ type: "text" as const, text: "test" }],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      projectAdditionalDirectories: ["/extra"],
      runtimePolicy: {
        cwd: "/main",
        runtimeMode: "auto-accept-edits" as const,
        interactionMode: "default" as const,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/existing"],
          networkAccess: false,
        },
      },
    };
    const params = yield* buildCodexTurnStartParams(input);
    assert.deepEqual(params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: ["/existing", "/main", "/extra"],
      networkAccess: false,
    });
    assert.equal(params.approvalPolicy, "on-request");
    const readonly = yield* buildCodexTurnStartParams({
      ...input,
      runtimePolicy: {
        ...input.runtimePolicy,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    assert.deepEqual(readonly.sandboxPolicy, { type: "readOnly", networkAccess: false });
  }),
);
it("Claude SDK receives additional project folders alongside cwd and attachment access", () => {
  const options = makeClaudeQueryOptions({
    nativeThreadId: "native",
    resume: false,
    cwd: "/main",
    attachmentsDir: "/attachments",
    projectAdditionalDirectories: ["/extra"],
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
  });
  assert.deepEqual(options.additionalDirectories, ["/extra", "/main", "/attachments"]);
});
