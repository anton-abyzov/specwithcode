import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OpenCodeSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ServerConfig from "../../config.ts";
import type { OpenCodeRuntimeShape } from "../../provider/opencodeRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  makeOpenCodeAdapterV2,
  openCodeChildPermissionRules,
  openCodePermissionRules,
} from "./OpenCodeAdapterV2.ts";

type Rules = ReturnType<typeof openCodePermissionRules>;

const settings = Schema.decodeSync(OpenCodeSettings)({ serverUrl: "http://test.invalid" });

const policy = (runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"]) =>
  ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
  });

/** OpenCode applies the last rule that matches. */
const action = (rules: Rules, permission: string) =>
  rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)?.action;

describe("OpenCode after a thread is lowered from Full access", () => {
  it("a Task child does not keep the external_directory allow its parent once had", () => {
    // A child session copies its parent's external_directory and deny rules;
    // a parent created on Full access carries the allow.
    const inherited = openCodePermissionRules(policy("full-access")).filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    );
    const child = openCodeChildPermissionRules(policy("approval-required"), inherited);
    assert.equal(action(child, "external_directory"), "ask");
    assert.equal(action(child, "bash"), "ask");
  });

  it("a Task child keeps its own external_directory deny under Full access", () => {
    const deny = { permission: "external_directory", pattern: "*", action: "deny" } as const;
    const child = openCodeChildPermissionRules(policy("full-access"), [deny]);
    assert.equal(action(child, "external_directory"), "deny");
  });

  it.effect("a resumed session gets the current mode's rules before the next prompt", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly permission?: Rules }> = [];
      const session = { id: "root", time: { created: 1, updated: 1 } };
      const client = {
        // The event stream stays open: an ended stream fails the turn first.
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              await new Promise<never>(() => {});
            })(),
          }),
        },
        session: {
          create: async (input: { permission: Rules }) => {
            calls.push({ method: "create", permission: input.permission });
            return { data: session };
          },
          get: async () => ({ data: session }),
          update: async (input: { permission: Rules }) => {
            calls.push({ method: "update", permission: input.permission });
            return { data: session };
          },
          promptAsync: async () => {
            calls.push({ method: "prompt" });
            return { data: true };
          },
          messages: async () => ({ data: [] }),
        },
      };
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const instanceId = ProviderInstanceId.make("opencode-downgrade");
      const threadId = ThreadId.make("thread-opencode-downgrade");
      const modelSelection = { instanceId, model: "anthropic/claude-sonnet", options: [] };
      const adapter = makeOpenCodeAdapterV2({
        instanceId,
        settings,
        environment: {},
        runtime: {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntimeShape,
        idAllocator,
        serverConfig: {
          cwd: "/workspace",
          attachmentsDir: "/tmp/attachments",
        } as ServerConfig.ServerConfig["Service"],
      });
      const open = (mode: ProviderAdapterV2RuntimePolicy["runtimeMode"], suffix: string) =>
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-opencode-downgrade-${suffix}`),
          modelSelection,
          runtimePolicy: policy(mode),
        });
      // The thread ran on Full access: its native session holds those rules.
      const first = yield* open("full-access", "first");
      const created = yield* first.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy("full-access"),
      });
      // Lowered to Supervised, the next session resumes the same native session.
      const lowered = policy("approval-required");
      const second = yield* open("approval-required", "second");
      const providerThread = yield* second.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: lowered,
        existingProviderThread: created,
      });
      const now = yield* DateTime.now;
      yield* second.startTurn({
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-opencode-downgrade"),
          title: "downgrade",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-opencode-downgrade"),
        runOrdinal: 2,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-opencode-downgrade"),
        rootNodeId: NodeId.make("node-opencode-downgrade"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-opencode-downgrade"),
          text: "hello",
          attachments: [],
        },
        modelSelection,
        runtimePolicy: lowered,
      });
      const prompt = calls.findIndex((call) => call.method === "prompt");
      const update = calls.findIndex((call) => call.method === "update");
      assert.isAtLeast(prompt, 0);
      assert.isAtLeast(update, 0, "the resumed session's rules are replaced");
      assert.isBelow(update, prompt);
      const installed = calls[update]!.permission!;
      assert.equal(action(installed, "bash"), "ask");
      assert.equal(action(installed, "external_directory"), "ask");
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
});
