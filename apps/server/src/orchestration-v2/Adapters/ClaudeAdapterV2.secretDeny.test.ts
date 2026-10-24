import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  claudeAgentSecretDenyForConfig,
  claudeRulePath,
  type ClaudeAgentSecretDeny,
} from "../../provider/AgentProtectedPaths.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-claude-secret-deny-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const configuredDeny = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const deny = yield* claudeAgentSecretDenyForConfig({
    fileSystem: yield* FileSystem.FileSystem,
    path,
    config: serverConfig,
    homeDir: undefined,
  });
  return {
    deny,
    secretsDir: serverConfig.secretsDir,
    fleetFile: path.join(serverConfig.baseDir, "studio-fleet.json"),
  };
});

function assertDenied(
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  expected: { readonly secretsDir: string; readonly fleetFile: string },
  label: string,
) {
  const settings = options.settings;
  if (settings === undefined || typeof settings === "string") {
    throw new Error(`${label}: expected inline Claude settings`);
  }
  const deny = settings.permissions?.deny ?? [];
  for (const rule of [
    `Read(${claudeRulePath(expected.secretsDir)}/**)`,
    `Edit(${claudeRulePath(expected.secretsDir)}/**)`,
    `Read(${claudeRulePath(expected.fleetFile)})`,
    `Edit(${claudeRulePath(expected.fleetFile)})`,
    `Bash(*${expected.secretsDir}/*)`,
    `Bash(*${expected.secretsDir})`,
    `Bash(*${expected.fleetFile}*)`,
  ]) {
    assert.include(deny, rule, `${label}: ${rule}`);
  }
  assert.isFalse(
    deny.some((rule) => rule.startsWith("Write(")),
    `${label}: no Write rules, which Claude Code does not match`,
  );
  assert.include(settings.sandbox?.filesystem?.denyRead ?? [], expected.secretsDir, label);
  assert.include(settings.sandbox?.filesystem?.denyRead ?? [], expected.fleetFile, label);
}

const RUNTIME_POLICIES = [
  ["approval-required", { runtimeMode: "approval-required" }],
  ["auto-accept-edits", { runtimeMode: "auto-accept-edits" }],
  ["auto", { runtimeMode: "auto" }],
  ["full-access", { runtimeMode: "full-access" }],
  ["plan", { runtimeMode: "full-access", interactionMode: "plan" }],
  [
    "read-only never",
    {
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    },
  ],
  [
    "danger-full-access never",
    {
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  ],
] as const;

describe("ClaudeAdapterV2 credential store deny rules", () => {
  it.effect("are in the query options in every runtime mode, bypass included", () =>
    Effect.gen(function* () {
      const expected = yield* configuredDeny;
      const modes = new Set<string>();
      for (const [label, policy] of RUNTIME_POLICIES) {
        const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
          ProviderAdapterV2RuntimePolicy.make({
            interactionMode: "default",
            cwd: "/workspace",
            ...policy,
          } as never),
        );
        modes.add(queryPolicy.permissionMode);
        const options = ClaudeAdapterV2.makeClaudeQueryOptions({
          modelSelection: MODEL_SELECTION,
          nativeThreadId: `secret-deny-${label}`,
          resume: false,
          cwd: "/workspace",
          settings: DEFAULT_CLAUDE_SETTINGS,
          permissionMode: queryPolicy.permissionMode,
          ...(queryPolicy.allowedTools === undefined
            ? {}
            : { allowedTools: queryPolicy.allowedTools }),
          ...(queryPolicy.allowDangerouslySkipPermissions === undefined
            ? {}
            : { allowDangerouslySkipPermissions: true }),
          agentSecretDeny: expected.deny,
        });
        assert.equal(options.permissionMode, queryPolicy.permissionMode, label);
        assertDenied(options, expected, `${label} (${queryPolicy.permissionMode})`);
      }
      assert.deepEqual(
        [...modes].sort(),
        ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"],
        "every Claude permission mode the app chooses is covered",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("survive launch flags that skip permissions and a user --settings flag", () =>
    Effect.gen(function* () {
      const expected = yield* configuredDeny;
      const options = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: MODEL_SELECTION,
        nativeThreadId: "secret-deny-launch-args",
        resume: false,
        cwd: "/workspace",
        settings: {
          ...DEFAULT_CLAUDE_SETTINGS,
          launchArgs: '--dangerously-skip-permissions --settings \'{"permissions":{"deny":[]}}\'',
        },
        sdkSettings: { permissions: { deny: ["Bash(curl:*)"], allow: ["Read"] } },
        agentSecretDeny: expected.deny,
      });
      assert.equal(options.permissionMode, "bypassPermissions");
      assertDenied(options, expected, "launch args");
      const settings = options.settings;
      if (settings === undefined || typeof settings === "string") throw new Error("inline");
      assert.include(settings.permissions?.deny ?? [], "Bash(curl:*)");
      assert.deepEqual(settings.permissions?.allow, ["Read"]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("reach the query a full-access turn opens", () =>
    Effect.gen(function* () {
      const expected = yield* configuredDeny;
      const serverConfig = yield* ServerConfig.ServerConfig;
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const deny: ClaudeAgentSecretDeny = expected.deny;
      const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CLAUDE_SETTINGS,
        environment: {},
        attachmentsDir: serverConfig.attachmentsDir,
        agentSecretDeny: deny,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed("native-thread-secret-deny"),
          open: (input) =>
            Effect.sync(() => {
              openedOptions = input.options;
              return {
                messages: Stream.never,
                offer: () => Effect.void,
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              };
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      });
      const threadId = ThreadId.make("thread-secret-deny");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-secret-deny"),
        modelSelection: MODEL_SELECTION,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: MODEL_SELECTION,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const attemptId = RunAttemptId.make("attempt-secret-deny");
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-secret-deny"),
          title: "Secret deny",
          providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-secret-deny"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId,
        rootNodeId: NodeId.make("node-secret-deny"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-secret-deny"),
          text: "cat the secrets folder",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        runtimePolicy,
      });
      if (openedOptions === undefined) throw new Error("the turn did not open a query");
      assert.equal(openedOptions.permissionMode, "bypassPermissions");
      assertDenied(openedOptions, expected, "full-access turn");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
