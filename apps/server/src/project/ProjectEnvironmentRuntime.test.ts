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
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeEnvironmentRuntime } from "./ProjectEnvironmentRuntime.ts";
import { makeProviderFailure } from "../orchestration-v2/ProviderFailure.ts";
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
    "rejects ACP folder grants with actionable diagnostics before start or compaction",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-acp-boundary-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = path.join(root, "main");
        const extra = path.join(root, "extra");
        yield* fs.makeDirectory(main);
        yield* fs.makeDirectory(extra);
        const project = {
          id: ProjectId.make("p"),
          workspaceRoot: main,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            kind: "personal",
            environment: { additionalFolders: [extra], repositories: [] },
          },
        } as unknown as Project;
        let providerCalls = 0;
        const called = () => Effect.sync(() => providerCalls++);
        const wrap = yield* makeEnvironmentRuntime;
        const runtime = wrap(
          {
            driver: ProviderDriverKind.make("acpRegistry"),
            startTurn: called,
            compactThread: called,
            prepareTurn: () => called().pipe(Effect.as([])),
          } as unknown as ProviderAdapterV2SessionRuntime,
          () => Effect.succeed(Option.some(project)),
        );
        const input = { ...turn(), runtimePolicy: { ...turn().runtimePolicy, cwd: main } };
        for (const operation of [
          runtime.startTurn(input),
          runtime.compactThread!(input),
          runtime.prepareTurn!(input),
        ]) {
          const error = yield* operation.pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterTurnStartError");
          assert.include(
            makeProviderFailure({ cause: error }).message,
            "additional project folders under the current permissions",
          );
          assert.include(makeProviderFailure({ cause: error }).message, "Full access");
        }
        assert.equal(providerCalls, 0);
      }),
  );
  it.effect(
    "passes canonical approvals to both supported drivers and reflects removed approvals next turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-runtime-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = path.join(root, "main");
        const extra = path.join(root, "extra");
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
        for (const driver of ["codex", "claudeAgent", "muse"]) {
          const session = {
            driver: ProviderDriverKind.make(driver),
            startTurn: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
              }),
            prepareTurn: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
                return [];
              }),
            compactThread: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input);
              }),
          } as unknown as ProviderAdapterV2SessionRuntime;
          const runtime = wrap(session, () => Effect.succeed(Option.some(project)));
          yield* runtime.prepareTurn!(turn());
          yield* runtime.startTurn(turn());
          yield* runtime.compactThread!(turn());
        }
        assert.equal(received.length, 9);
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
        assert.isUndefined(received[9]?.projectAdditionalDirectories);
      }),
  );
  it.effect(
    "allows the Aide ACP coordinator's approved folders only with effective Full access",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "aide-acp-folders-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = path.join(root, "aide"),
          first = path.join(root, "specweave"),
          second = path.join(root, "easychamp");
        yield* fs.makeDirectory(main);
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        const project = {
          id: ProjectId.make("p"),
          workspaceRoot: main,
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: { additionalFolders: [first, second], repositories: [] },
          },
        } as unknown as Project;
        const received: ProviderAdapterV2TurnInput[] = [];
        const wrap = yield* makeEnvironmentRuntime;
        const session = {
          driver: ProviderDriverKind.make("acpRegistry"),
          startTurn: (value: ProviderAdapterV2TurnInput) =>
            Effect.sync(() => {
              received.push(value);
            }),
        } as unknown as ProviderAdapterV2SessionRuntime;
        const runtime = wrap(session, () => Effect.succeed(Option.some(project)));
        const input = {
          ...turn(),
          runtimePolicy: {
            ...turn().runtimePolicy,
            cwd: main,
            runtimeMode: "full-access" as const,
          },
        };
        yield* runtime.startTurn(input);
        yield* runtime.startTurn({
          ...input,
          runtimePolicy: {
            ...input.runtimePolicy,
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        });
        assert.equal(received.length, 2);
        assert.deepEqual(received[0]?.projectAdditionalDirectories, [first, second]);
        assert.include(received[0]!.message.text, JSON.stringify([first, second]));
        assert.isTrue(received[0]!.message.text.endsWith("\n\nuser"));
        assert.deepEqual(received[0]!.message.attachments, input.message.attachments);
        for (const override of [
          { runtimeMode: "approval-required" as const },
          { interactionMode: "plan" as const },
          { approvalPolicy: "on-request" },
          { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
          { sandboxPolicy: { type: "workspaceWrite", writableRoots: [first, second] } },
          { sandboxPolicy: { type: "externalSandbox" } },
          { sandboxPolicy: { type: "unknown" } },
          { sandboxPolicy: null },
          { approvalPolicy: null },
        ]) {
          const error = yield* runtime
            .startTurn({ ...input, runtimePolicy: { ...input.runtimePolicy, ...override } })
            .pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterTurnStartError");
          assert.equal((error.cause as { code: string }).code, "unsupported_provider");
        }
        assert.equal(received.length, 2);
        yield* fs.remove(second, { recursive: true });
        yield* fs.symlink(first, second);
        const moved = yield* runtime.startTurn(input).pipe(Effect.flip);
        assert.equal((moved.cause as { code: string }).code, "path_not_approved");
        assert.equal(received.length, 2);
      }),
  );
  it.effect(
    "fails closed for unsupported providers, moved approved symlinks and missing projects",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-boundary-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = path.join(root, "main");
        const extra = path.join(root, "extra");
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
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "environment-worktree-" })
          .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
        const main = path.join(root, "umbrella");
        const worktree = path.join(root, "worktree");
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
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "environment-main-identity-" })
        .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
      const main = path.join(root, "main");
      const outside = path.join(root, "outside");
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
      yield* fs.rename(main, path.join(root, "retained-main"));
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

it.layer(NodeServices.layer)("logical coordinator runtime fence", (it) => {
  it.effect(
    "blocks native start and compaction after transfer while allowing acknowledged source workers",
    () =>
      Effect.gen(function* () {
        const wrap = yield* makeEnvironmentRuntime;
        let state: "transferring" | "transferred" = "transferring";
        const received: string[] = [];
        const runtime = wrap(
          {
            driver: "codex",
            startTurn: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input.threadId);
              }),
            compactThread: (input: ProviderAdapterV2TurnInput) =>
              Effect.sync(() => {
                received.push(input.threadId);
              }),
          } as unknown as ProviderAdapterV2SessionRuntime,
          () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("p"),
                workspaceRoot: "/main",
                workspaceSettings: {
                  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                  coordinatorThreadId: ThreadId.make("t"),
                  coordinatorBinding: { epoch: 0, state },
                },
              } as Project),
            ),
        );
        for (const phase of ["transferring", "transferred"] as const) {
          state = phase;
          assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.startTurn(turn()))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.compactThread!(turn()))));
        }
        assert.deepEqual(received, []);
        const worker = { ...turn(), threadId: ThreadId.make("worker") };
        yield* runtime.startTurn(worker);
        yield* runtime.compactThread!(worker);
        assert.deepEqual(received, ["worker", "worker"]);
        state = "transferring";
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.startTurn(worker))));
      }),
  );
});
