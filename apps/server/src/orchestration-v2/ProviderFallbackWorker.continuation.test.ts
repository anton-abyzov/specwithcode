import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import {
  makeSweep,
  ProviderFallbackEnv,
  providerFallbackCommand,
  providerLimitStep,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { automaticFallbackContinuation } from "./automaticFallbackContinuation.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

const at = Date.parse("2026-10-27T18:34:05Z");
const resetsAt = "2026-10-27T22:00:00Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("continuation-project");
const thread = {
  id: ThreadId.make("continuation-thread"),
  projectId,
  providerInstanceId: claudeId,
  modelSelection: { instanceId: claudeId, model: "claude-opus-5-5" },
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  lastError: "Credit balance is too low",
  usageLimitResetAt: resetsAt,
  latestRunId: RunId.make("r47"),
  latestRunCompletedAt: DateTime.makeUnsafe(at),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};
const target = { instanceId: codexId, model: "gpt-6.1-sol" };
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: target,
  providerLimitWaitUnderMinutes: 0,
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: null,
};
const withUsage = (
  id: ProviderInstanceId,
  driver: "claudeAgent" | "codex",
  used: number,
): ServerProvider => {
  const base = provider(id, driver, at);
  return {
    ...base,
    models: [
      {
        slug: driver === "codex" ? target.model : thread.modelSelection.model,
        name: "Model",
        isDefault: true,
        isCustom: false,
        capabilities: null,
      },
    ],
    usageLimits: {
      ...base.usageLimits!,
      windows: [{ id: "session", kind: "session", label: "Session", usedPercent: used, resetsAt }],
    },
  };
};
const providers = [withUsage(claudeId, "claudeAgent", 100), withUsage(codexId, "codex", 20)];
const staleRequest =
  "Implement the task only with Claude. Stop on Credit balance is too low. Never switch the implementer.";
const attachments = [{ type: "file", id: "fixture-attachment" }];

function expectAuthorization(command: OrchestrationV2ServerCommand | null) {
  expect(command).toMatchObject({
    type: "message.dispatch",
    modelSelection: target,
    manualContinuationOfRunId: thread.latestRunId,
    creationSource: "server",
  });
  if (command?.type !== "message.dispatch") throw new Error("Expected fallback dispatch");
  expect(command.text).toContain("codex / gpt-6.1-sol");
  expect(command.text).toContain("Do not ask for provider-substitution confirmation");
  expect(command.text).toContain("older assignment");
  expect(command.text).toContain("actual Stop holds");
  expect(command.text).toContain("billing restrictions, grants");
  expect(command.text).toContain("answering pending approval cards");
  return command;
}

describe("automatic fallback continuation authorization", () => {
  it("replaces an earlier hop's note instead of stacking a second one", () => {
    const hop1 = automaticFallbackContinuation(
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
      "Fix the login bug.",
    );
    const hop2 = automaticFallbackContinuation(
      { instanceId: ProviderInstanceId.make("grok"), model: "grok-5" },
      hop1,
    );
    expect(hop2.match(/\[Automatic fallback continuation\]/g)).toHaveLength(1);
    expect(hop2.startsWith("Fix the login bug.\n\n")).toBe(true);
    expect(hop2).toContain("selected grok / grok-5");
    expect(hop2).not.toContain("gpt-6");
  });

  it("continues the same assignment on the eligible configured model without another substitution question", () => {
    expect(providerFallbackCommand(thread, providers, rule, at)).toMatchObject({
      type: "message.dispatch",
      modelSelection: target,
      creationSource: "server",
    });
  });

  it.each(["ask", "wait"] as const)("does not override the %s policy", (action) => {
    expect(
      providerFallbackCommand(thread, providers, { ...rule, providerLimitAction: action }, at),
    ).toBeNull();
  });

  it("does not fabricate authorization when no eligible fallback exists or a question is pending", () => {
    expect(providerFallbackCommand(thread, [providers[0]!], rule, at)).toBeNull();
    expect(
      providerFallbackCommand(
        { ...thread, pendingRuntimeRequest: { status: "pending" } as never },
        providers,
        rule,
        at,
      ),
    ).toBeNull();
  });

  it("keeps same-provider API billing recovery free of cross-provider authorization", () => {
    const apiClaude = {
      ...providers[0]!,
      auth: { status: "authenticated" as const, type: "apiKey", apiKeyBilling: true },
      usageLimits: undefined,
    };
    const step = providerLimitStep(thread, [apiClaude], rule, at, {
      resetAttempted: false,
      planLimitOutlived: true,
    });
    expect(step?.type).toBe("resume-api");
    if (step?.type !== "resume-api") throw new Error("Expected billing recovery");
    expect(step.command).toMatchObject({
      text: "Continue where you left off.",
      modelSelection: thread.modelSelection,
    });
  });

  for (const firstRequest of [false, true]) {
    itEffect.effect(
      `preserves authorization through the sweep (${firstRequest ? "first-request replay" : "native history"})`,
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(at + 1_000);
          const dispatched: OrchestrationV2ServerCommand[] = [];
          const deps = Layer.mergeAll(
            Layer.mock(Projects.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({
                    id: projectId,
                    title: "Fixture",
                    workspaceRoot: "/fixture",
                    defaultModelSelection: null,
                    workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                    scripts: [],
                    createdAt: "2026-10-01T00:00:00Z",
                    updatedAt: "2026-10-01T00:00:00Z",
                    deletedAt: null,
                  }),
                ),
            }),
            fallbackPolicyTestLayer({ ...DEFAULT_SERVER_SETTINGS, ...rule }),
            Layer.mock(Providers.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
              refreshInstance: () => Effect.succeed(providers),
            }),
            Layer.mock(Instances.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(undefined),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
              getThreadShell: () => Effect.succeed(thread as never),
              getThreadRecords: (_id, _fields, filter) =>
                Effect.succeed({
                  thread,
                  runs: [],
                  providerThreads: firstRequest
                    ? []
                    : [
                        {
                          appThreadId: thread.id,
                          nativeThreadRef: { nativeId: "existing-session" },
                        },
                      ],
                  turnItems: filter?.turnItemTypes?.includes("run_interrupt_request")
                    ? []
                    : [
                        {
                          type: "user_message",
                          runId: thread.latestRunId,
                          ordinal: 0,
                          text: staleRequest,
                          attachments,
                        },
                      ],
                  messages: [],
                } as never),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          );
          yield* Effect.gen(function* () {
            const sweep = yield* makeSweep;
            yield* sweep();
          }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
          expect(dispatched).toHaveLength(1);
          const command = expectAuthorization(dispatched[0]!);
          if (firstRequest) {
            expect(
              command.text.startsWith(`${staleRequest}\n\n[Automatic fallback continuation]`),
            ).toBe(true);
            expect(command.attachments).toEqual(attachments);
          } else {
            expect(command.text.startsWith("Continue where you left off.")).toBe(true);
          }
        }),
    );
  }
});
