import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  type ModelSelection,
  type ServerSettings,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as AdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Capacity from "../studio/Capacity.ts";
import { CodexNativeRouteCheckError } from "../provider/CodexProvider.ts";
import * as NativeRoute from "../studio/NativeRoute.ts";
import { SwitchFetch } from "../studio/SwitchClient.ts";
import { provider, settings } from "../studio/fixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";

const cwd = "/owned/project/worktree";
const message = "Review https://github.com/owned/project/issues/1";
type Service = TextGeneration.TextGeneration["Service"];
const operations: ReadonlyArray<{
  operation: keyof Service;
  call: (generation: Service, model: ModelSelection) => Effect.Effect<unknown, TextGenerationError>;
}> = [
  {
    operation: "generateCommitMessage",
    call: (g, modelSelection) =>
      g.generateCommitMessage({
        cwd,
        modelSelection,
        branch: "owned",
        stagedSummary: "summary",
        stagedPatch: "patch",
      }),
  },
  {
    operation: "generatePrContent",
    call: (g, modelSelection) =>
      g.generatePrContent({
        cwd,
        modelSelection,
        baseBranch: "main",
        headBranch: "owned",
        commitSummary: "summary",
        diffSummary: "summary",
        diffPatch: "patch",
      }),
  },
  {
    operation: "generateBranchName",
    call: (g, modelSelection) => g.generateBranchName({ cwd, modelSelection, message }),
  },
  {
    operation: "generateThreadTitle",
    call: (g, modelSelection) => g.generateThreadTitle({ cwd, modelSelection, message }),
  },
];

function snapshot(allowed: boolean, id = "codex") {
  const base = provider(id);
  return {
    ...base,
    usageLimits: {
      ...base.usageLimits!,
      ordinaryUsageAllowed: allowed,
      nativeAllowanceObservedAt: new Date().toISOString(),
      credits: { hasCredits: true, unlimited: false, balance: "5867.0123456789" },
      resetCredits: { availableCount: 3 },
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100,
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    },
  } satisfies ServerProvider;
}

async function harness(
  input: {
    native?: ServerProvider;
    config?: ServerSettings;
    instanceId?: string;
    absent?: boolean;
    rawFailure?: TextGenerationError;
    routeVerified?: boolean;
    routeFailure?: "timeout" | "unavailable";
  } = {},
) {
  const instanceId = ProviderInstanceId.make(input.instanceId ?? "codex");
  const native = input.native ?? snapshot(false, instanceId);
  const calls = {
    resolve: 0,
    links: 0,
    raw: [] as Array<{ operation: keyof Service; modelSelection: ModelSelection; cwd: string }>,
    admissions: [] as Array<{ instanceId: string; cwd: string | null }>,
    routes: [] as Array<{ cwd: string | null; config: unknown }>,
  };
  const record = <A>(
    operation: keyof Service,
    value: A,
    request: { modelSelection: ModelSelection; cwd: string },
  ) => {
    calls.raw.push({ operation, modelSelection: request.modelSelection, cwd: request.cwd });
    return input.rawFailure ? Effect.fail(input.rawFailure) : Effect.succeed(value);
  };
  const raw: Service = {
    generateCommitMessage: (request) =>
      record("generateCommitMessage", { subject: "Owned subject", body: "Owned body" }, request),
    generatePrContent: (request) =>
      record("generatePrContent", { title: "Owned PR", body: "Owned body" }, request),
    generateBranchName: (request) =>
      record("generateBranchName", { branch: "owned-branch" }, request),
    generateThreadTitle: (request) =>
      record("generateThreadTitle", { title: "Owned title" }, request),
  };
  const instance = {
    instanceId,
    driverKind: native.driver,
    continuationIdentity: { driverKind: native.driver, continuationKey: "owned" },
    displayName: "Owned",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: raw,
  } satisfies ProviderInstance;
  const capacity = Capacity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed(input.config ?? settings),
        }),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.succeed([native]),
          refreshInstance: () => Effect.succeed([native]),
        }),
        Layer.succeed(NativeRoute.NativeRoute, {
          verify: (entry, path) =>
            Effect.sync(() => {
              calls.routes.push({ cwd: path, config: entry.config });
              return input.routeVerified !== false;
            }).pipe(Effect.flatMap((verified) => input.routeFailure
              ? Effect.fail(new CodexNativeRouteCheckError({ reason: input.routeFailure }))
              : Effect.succeed(verified))),
        }),
        Layer.succeed(HostProcessEnvironment, {}),
        Layer.succeed(SwitchFetch, (() =>
          Promise.reject(new Error("Optional companion unavailable"))) as typeof fetch),
      ),
    ),
  );
  const observedCapacity = Layer.effect(
    Capacity.Capacity,
    Effect.gen(function* () {
      const real = yield* Capacity.Capacity;
      return {
        ...real,
        assertNativeStart: (id: ProviderInstanceId, path: string | null) => {
          calls.admissions.push({ instanceId: id, cwd: path });
          return real.assertNativeStart(id, path);
        },
      };
    }),
  ).pipe(Layer.provide(capacity));
  const generation = await Effect.runPromise(
    TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          observedCapacity,
          Layer.succeed(Instances.ProviderInstanceRegistry, {
            getInstance: (id) => {
              calls.resolve++;
              return Effect.succeed(!input.absent && id === instanceId ? instance : undefined);
            },
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
          Layer.mock(SourceControl.SourceControlProviderRegistry)({
            resolveLink: () => {
              calls.links++;
              return Effect.succeed({ title: "Owned link", body: "Owned context" } as never);
            },
          }),
        ),
      ),
    ),
  );
  return {
    generation,
    calls,
    modelSelection: { instanceId, model: "gpt-6-astra" } satisfies ModelSelection,
  };
}

describe("auxiliary generation uses native admission before provider resolution", () => {
  for (const { operation, call } of operations) {
    it(`${operation}: fresh native denial overrides credits and 100%-used quota before any raw call`, async () => {
      const h = await harness();
      await expect(Effect.runPromise(call(h.generation, h.modelSelection))).rejects.toMatchObject({
        _tag: "TextGenerationError",
        operation,
        detail: expect.stringMatching(/no remaining permitted usage.*Next observed reset/),
      });
      expect(h.calls.resolve).toBe(0);
      expect(h.calls.raw).toEqual([]);
      expect(h.calls.links).toBe(0);
      expect(h.calls.admissions).toEqual([{ instanceId: "codex", cwd }]);
      expect(h.calls.routes).toEqual([{ cwd, config: settings.providers.codex }]);
    });
    it(`${operation}: fresh ordinary allowance at 100% reaches only the exact requested generator`, async () => {
      const h = await harness({ native: snapshot(true) });
      await Effect.runPromise(call(h.generation, h.modelSelection));
      expect(h.calls.resolve).toBe(1);
      expect(h.calls.raw).toEqual([{ operation, modelSelection: h.modelSelection, cwd }]);
      expect(h.calls.links).toBe(operation === "generateThreadTitle" ? 1 : 0);
    });
    it(`${operation}: disabled native provider fails before raw resolution`, async () => {
      const config = {
        ...settings,
        providers: {
          ...settings.providers,
          codex: { ...settings.providers.codex, enabled: false },
        },
      };
      const h = await harness({ native: snapshot(true), config });
      await expect(Effect.runPromise(call(h.generation, h.modelSelection))).rejects.toMatchObject({
        _tag: "TextGenerationError",
        operation,
        detail: "This provider instance is disabled.",
      });
      expect(h.calls.resolve).toBe(0);
      expect(h.calls.raw).toEqual([]);
      expect(h.calls.links).toBe(0);
    });
    it(`${operation}: forwards the existing typed provider error after successful admission`, async () => {
      const rawFailure = new TextGenerationError({ operation, detail: "Owned transport failure" });
      const h = await harness({ native: snapshot(true), rawFailure });
      await expect(Effect.runPromise(call(h.generation, h.modelSelection))).rejects.toBe(
        rawFailure,
      );
      expect(h.calls.raw).toHaveLength(1);
    });
  }
  for (const state of ["error", "unknown"] as const)
    it(`unverified ${state} remains denied after the native refresh`, async () => {
      const native = {
        ...snapshot(true),
        ...(state === "error"
          ? { status: "error" as const }
          : { auth: { status: "unknown" as const } }),
      };
      const h = await harness({ native });
      await expect(
        Effect.runPromise(
          h.generation.generateThreadTitle({ cwd, message, modelSelection: h.modelSelection }),
        ),
      ).rejects.toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateThreadTitle",
        detail: expect.stringMatching(/failed|unverified/),
      });
      expect(h.calls.resolve).toBe(0);
      expect(h.calls.raw).toEqual([]);
      expect(h.calls.links).toBe(0);
    });
  it("preserves the exact custom native instance and worktree cwd", async () => {
    const instanceId = "codex-owned";
    const config = {
      ...settings,
      providerInstances: {
        [instanceId]: { driver: snapshot(true).driver, config: { homePath: "/owned/custom-home" } },
      },
    };
    const h = await harness({ native: snapshot(true, instanceId), config, instanceId });
    await Effect.runPromise(
      h.generation.generateBranchName({ cwd, message, modelSelection: h.modelSelection }),
    );
    expect(h.calls.admissions).toEqual([{ instanceId, cwd }]);
    expect(h.calls.routes).toEqual([{ cwd, config: config.providerInstances[instanceId]!.config }]);
    expect(h.calls.raw).toEqual([
      { operation: "generateBranchName", modelSelection: h.modelSelection, cwd },
    ]);
  });
  it("keeps unknown-instance failures typed without falling back", async () => {
    const h = await harness({ instanceId: "unknown", absent: true });
    await expect(
      Effect.runPromise(
        h.generation.generateBranchName({ cwd, message, modelSelection: h.modelSelection }),
      ),
    ).rejects.toMatchObject({
      _tag: "TextGenerationError",
      operation: "generateBranchName",
      detail: expect.stringContaining("unknown"),
    });
    expect(h.calls.raw).toEqual([]);
    expect(h.calls.links).toBe(0);
  });
  it.each(["timeout", "unavailable"] as const)("rejects %s workspace route checks before raw generation or link resolution", async (routeFailure) => {
    const h = await harness({ native: snapshot(true), routeFailure });
    await expect(Effect.runPromise(h.generation.generateThreadTitle({ cwd, message, modelSelection: h.modelSelection })))
      .rejects.toMatchObject({ _tag: "TextGenerationError", detail: expect.stringContaining(
        routeFailure === "timeout" ? "route check timed out" : "route check failed",
      ) });
    expect(h.calls.resolve).toBe(0);
    expect(h.calls.raw).toEqual([]);
    expect(h.calls.links).toBe(0);
  });
  it("rejects a workspace route mismatch before resolving title links", async () => {
    const h = await harness({ native: snapshot(true), routeVerified: false });
    await expect(
      Effect.runPromise(
        h.generation.generateThreadTitle({ cwd, message, modelSelection: h.modelSelection }),
      ),
    ).rejects.toMatchObject({
      _tag: "TextGenerationError",
      detail: expect.stringContaining("effective Codex route"),
    });
    expect(h.calls.resolve).toBe(0);
    expect(h.calls.raw).toEqual([]);
    expect(h.calls.links).toBe(0);
  });
});

it("actual deferred title generation keeps the seed and temporary branch without raw generation", async () => {
  const h = await harness();
  const projectId = ProjectId.make("owned-aux-project"),
    threadId = ThreadId.make("owned-aux-thread");
  const commandId = CommandId.make("owned-aux-submit"),
    messageId = MessageId.make("owned-aux-message");
  const adapter = {
    instanceId: h.modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Deferred root must not open"),
  } as ProviderAdapterV2Shape;
  // Thread creation is admitted only for a registered project.
  const database = fixtureProjectDatabase([projectId]);
  const orchestrator = Replay.layerWithRegistry(
    { name: "aux-denied-title" },
    AdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const titleService = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threads,
        Settings.layerTest({ textGenerationModelSelection: h.modelSelection }),
        Layer.succeed(TextGeneration.TextGeneration, h.generation),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(Option.some({ projectId, workspaceRoot: "/owned/project" } as never)),
        }),
      ),
    ),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const management = yield* ThreadManagement.ThreadManagementService;
        yield* management.dispatch({
          type: "thread.create",
          commandId: CommandId.make("owned-aux-create"),
          threadId,
          projectId,
          title: "Original title",
          modelSelection: h.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: "studio/owned-temporary",
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* management.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId,
          text: message,
          titleSeed: "Owned seed title",
          attachments: [],
          modelSelection: h.modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* management.getThreadProjection(threadId);
        expect(before.runs[0]?.status).toBe("preparing");
        expect(before.runs[0]?.startedAt).toBeNull();
        expect(before.providerTurns).toEqual([]);
        const pending = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(commandId);
        expect(pending.some((effect) => effect.request.type === "thread-title.generate")).toBe(
          true,
        );
        yield* (yield* ThreadTitleRegeneration.ThreadTitleRegenerationService).execute({
          threadId,
          requestId: commandId,
          kind: { type: "initial", messageId },
        });
        const after = yield* management.getThreadProjection(threadId);
        expect(after.thread.title).toBe("Owned seed title");
        expect(after.thread.titleRegeneration).toBeNull();
        expect(after.thread.branch).toBe("studio/owned-temporary");
        expect(after.thread.worktreePath).toBe(cwd);
        expect(after.runs[0]?.startedAt).toBeNull();
        expect(after.providerTurns).toEqual([]);
        expect(h.calls.admissions).toEqual(
          Array.from({ length: 3 }, () => ({ instanceId: "codex", cwd })),
        );
        expect(h.calls.resolve).toBe(0);
        expect(h.calls.links).toBe(0);
        expect(h.calls.raw).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(threads, titleService, outbox))),
    ),
  );
});

it("cannot construct the central service without its required admission dependency", async () => {
  const missingCapacity = TextGeneration.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Instances.ProviderInstanceRegistry)({
          getInstance: () => Effect.die("No provider lookup expected"),
        }),
        Layer.mock(SourceControl.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("No link lookup expected"),
        }),
      ),
    ),
  );
  // @ts-expect-error The required Capacity service is deliberately absent.
  await expect(Effect.runPromise(missingCapacity)).rejects.toThrow(/Capacity/);
});
