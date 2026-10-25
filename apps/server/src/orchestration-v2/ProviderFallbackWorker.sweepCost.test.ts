import { it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { provider } from "../studio/fixtures.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

const at = Date.parse("2026-10-19T03:00:00Z");
const projectId = ProjectId.make("cost-project");
const claudeId = ProviderInstanceId.make("cost-claude");
const codexId = ProviderInstanceId.make("cost-codex");
const THREADS = 200;

const preferences: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitWaitUnderMinutes: 0,
  providerLimitFallbackModelSelection: { instanceId: codexId, model: "gpt-6" },
};

// Idle threads with no limit stop and no API-credit move behind them: the
// state of nearly every unsettled thread on a busy machine.
const idleThread = (index: number) =>
  ({
    id: ThreadId.make(`cost-thread-${index}`),
    projectId,
    providerInstanceId: claudeId,
    modelSelection: { instanceId: claudeId, model: "opus" },
    status: "completed",
    lastErrorClass: null,
    latestRunId: RunId.make(`cost-run-${index}`),
    latestRunCompletedAt: DateTime.makeUnsafe(at - 60_000),
    activeRunId: null,
    pendingRuntimeRequest: null,
    settledOverride: null,
    snoozedUntil: null,
    limitRecovery: null,
  }) as unknown as OrchestrationV2ThreadShell;

it.effect("a sweep over idle threads takes no lock and re-reads no thread", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const settings = yield* Settings.ServerSettingsService;
    const admission = yield* ProjectAdmission.ProjectAdmission;
    const threads = Array.from({ length: THREADS }, (_, index) => idleThread(index));
    const counts = {
      snapshots: 0,
      threadShells: 0,
      records: 0,
      locks: 0,
      settingsSnapshots: 0,
      projectReads: 0,
    };
    const snapshotOptions: Array<unknown> = [];
    const deps = Layer.mergeAll(
      Layer.succeed(ProjectAdmission.ProjectAdmission, {
        ...admission,
        withLock: (id, effect) =>
          Effect.suspend(() => {
            counts.locks += 1;
            return admission.withLock(id, effect);
          }),
      }),
      Layer.succeed(Settings.ServerSettingsService, {
        ...settings,
        withSettingsSnapshot: (use) =>
          Effect.suspend(() => {
            counts.settingsSnapshots += 1;
            return settings.withSettingsSnapshot(use);
          }),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.sync(() => {
            counts.projectReads += 1;
            return Option.some({
              id: projectId,
              title: "Cost test",
              workspaceRoot: "/cost-test",
              defaultModelSelection: null,
              workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              scripts: [],
              createdAt: "2026-10-19T00:00:00Z",
              updatedAt: "2026-10-19T00:00:00Z",
              deletedAt: null,
            });
          }) as never,
      }),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([
          provider(claudeId, "claudeAgent", at),
          provider(codexId, "codex", at),
        ]),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: (options) =>
          Effect.sync(() => {
            counts.snapshots += 1;
            snapshotOptions.push(options);
            return { threads } as never;
          }),
        getThreadShell: (id) =>
          Effect.sync(() => {
            counts.threadShells += 1;
            return threads.find((thread) => thread.id === id) ?? null;
          }),
        getThreadRecords: (id) =>
          Effect.sync(() => {
            counts.records += 1;
            const thread = threads.find((candidate) => candidate.id === id)!;
            return {
              thread,
              runs: [
                {
                  id: thread.latestRunId,
                  ordinal: 1,
                  status: "completed",
                  providerInstanceId: claudeId,
                  modelSelection: thread.modelSelection,
                  userMessageId: "typed-by-a-person",
                },
              ],
              turnItems: [],
            } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: () => Effect.die("an idle thread must not be moved"),
      }),
    );
    const sweep = yield* makeSweep.pipe(
      Effect.provide(deps),
      Effect.provideService(ProviderFallbackEnv, {}),
    );

    yield* sweep();
    // The sweep shares the recent snapshot other sweeps read.
    expect(snapshotOptions).toEqual([
      { location: "active", unsettledOnly: true, maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS },
    ]);
    // Before: one admission lock, settings snapshot, project read and shell
    // transaction per thread, every sweep.
    expect(counts).toEqual({
      snapshots: 1,
      threadShells: 0,
      records: THREADS,
      locks: 0,
      settingsSnapshots: 0,
      projectReads: 1,
    });

    // Each thread's runs are read once per latest run, not once per sweep.
    yield* TestClock.adjust("31 seconds");
    yield* sweep();
    expect(counts).toEqual({
      snapshots: 2,
      threadShells: 0,
      records: THREADS,
      locks: 0,
      settingsSnapshots: 0,
      projectReads: 2,
    });

    // Within the interval the sweep waits, unless a failed run woke it: then
    // it runs on the next tick and reads past the cache to see that failure.
    yield* TestClock.adjust("5 seconds");
    yield* sweep();
    expect(counts.snapshots).toBe(2);
    yield* sweep.wake;
    yield* sweep();
    expect(counts.snapshots).toBe(3);
    expect(snapshotOptions.at(-1)).toEqual({
      location: "active",
      unsettledOnly: true,
      maxAgeMs: 0,
    });
    // One wake, one early sweep.
    yield* TestClock.adjust("5 seconds");
    yield* sweep();
    expect(counts.snapshots).toBe(3);
  }).pipe(Effect.provide(fallbackPolicyTestLayer(preferences))),
);
