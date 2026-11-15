import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import type {
  ProjectionTimelinePage,
  ProjectionTimelinePageOptions,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/** Under an MCP client's ~25,000-token spill limit even at 2 bytes per token. */
const BUDGET_BYTES = 40_000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const projectId = ProjectId.make("project-result-budget");
const threadId = ThreadId.make("thread-result-budget");
const runId = RunId.make("run-result-budget");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-11-14T12:00:00.000Z");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-result-budget"),
  requestNamespace: "provider-session-result-budget",
  thread: {
    threadId,
    providerSessionId: "provider-session-result-budget",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const projection = {
  thread: {
    id: threadId,
    projectId,
    title: "Budget",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  },
  runs: [
    {
      id: runId,
      ordinal: 1,
      status: "completed",
      modelSelection: { instanceId, model: "gpt-5.4" },
      providerInstanceId: instanceId,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
    },
  ],
  runtimeRequests: [],
  messages: [],
  contextTransfers: [],
  subagents: [],
  providerThreads: [],
  providerTurns: [],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;

/** 50 assistant replies of 20,000 characters: the largest default page. */
const rows = Array.from({ length: 50 }, (_, position) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: threadId,
  sourceItemId: TurnItemId.make(`item-${position}`),
  item: {
    id: TurnItemId.make(`item-${position}`),
    type: "assistant_message" as const,
    messageId: MessageId.make(`message-${position}`),
    runId,
    status: "completed" as const,
    title: null,
    text: `${position}:`.padEnd(20_000, "x"),
    createdAt: now,
    updatedAt: now,
  },
}));

/** The store's paging rules on a fixed index. */
const timelinePage = (options: ProjectionTimelinePageOptions & { beforePosition?: number }) => {
  if (options.itemId !== undefined) {
    const items = rows.filter((row) => row.sourceItemId === options.itemId);
    return { items, totalItems: rows.length, hasMore: false };
  }
  const matching = rows.filter(
    (row) =>
      row.position > (options.afterPosition ?? -1) &&
      (options.beforePosition === undefined || row.position < options.beforePosition),
  );
  const items =
    options.beforePosition === undefined
      ? matching.slice(0, options.limit)
      : matching.slice(Math.max(0, matching.length - options.limit));
  return {
    items,
    totalItems: rows.length,
    hasMore:
      options.beforePosition === undefined
        ? matching.length > items.length
        : rows.some((row) => row.position > (items.at(-1)?.position ?? Infinity)),
    hasEarlier: matching.length > items.length && options.beforePosition !== undefined,
  };
};

const descriptor = (id: string, values: ReadonlyArray<string>) => ({
  id,
  label: id,
  type: "select",
  options: values.map((value, index) => ({
    id: value,
    label: `${value[0]!.toUpperCase()}${value.slice(1)} level`,
    ...(index === 1 ? { isDefault: true } : {}),
  })),
  currentValue: values[1],
});

/** The provider and model counts of the November 14, 2026 catalog. */
const catalogShape: ReadonlyArray<readonly [string, number]> = [
  ["codex", 3],
  ["claudeAgent", 15],
  ["cursor", 49],
  ["grok", 5],
  ["opencode", 0],
  ["antigravity", 0],
  ["acpRegistry_copilot", 32],
  ["copilot-0889", 30],
  ["acpRegistry_deepseek", 4],
  ["acpRegistry_devin", 145],
  ["acpRegistry_gemini", 6],
  ["muse", 8],
  ["pi", 1],
];
const catalog: ReadonlyArray<ServerProvider> = catalogShape.map(([id, count]) => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id.startsWith("acpRegistry") ? "acpRegistry" : id),
  displayName: id,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-14T00:00:00.000Z",
  models: Array.from({ length: count }, (_, index) => ({
    slug: `${id}/model-${index}-preview`,
    name: `${id} model ${index} preview`,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        descriptor("reasoningEffort", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        descriptor("contextWindow", ["default", "long", "extended"]),
        descriptor("serviceTier", ["standard", "priority", "flex"]),
      ],
    },
  })),
  slashCommands: [],
  skills: [],
})) as unknown as ReadonlyArray<ServerProvider>;

const layer = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getTimelinePage: (_threadId, options) =>
          Effect.succeed(timelinePage(options) as unknown as ProjectionTimelinePage),
        getThreadRecords: () => Effect.succeed(projection),
        getThreadShell: () =>
          Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
        getProjectThreadRecords: () => Effect.succeed(projection),
      } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(catalog),
        refreshInstance: () => Effect.succeed(catalog),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed(catalog.map((provider) => provider.instanceId)),
          get: (id) => Effect.succeed({ instanceId: id } as unknown as ProviderAdapterV2Shape),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      NodeCrypto.layer,
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, OrchestratorMcpService.OrchestratorMcpService>) =>
  effect.pipe(Effect.provide(layer), Effect.runPromise);

describe("MCP result byte budget", () => {
  it("studio_thread_read without a cursor returns the newest items of a long thread", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const page = yield* service.readThread(scope, { threadId, limit: 2, maxCharsPerItem: 10 });
        expect(page.items.map((item) => item.position)).toEqual([48, 49]);
        expect(page.nextPosition).toBe(49);
        expect(page.hasMore).toBe(false);
        expect((page as { readonly earlierPosition?: number | null }).earlierPosition).toBe(48);
      }),
    ));

  it("studio_thread_read forward paging over over-budget pages visits every item once", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const seen: Array<number> = [];
        let after = -1;
        for (let call = 0; call < 200; call++) {
          const page = yield* service.readThread(scope, { threadId, afterPosition: after });
          expect(bytes(page)).toBeLessThanOrEqual(BUDGET_BYTES);
          expect((page as { readonly omittedItems?: number }).omittedItems).toBeUndefined();
          seen.push(...page.items.map((item) => item.position));
          if (!page.hasMore || page.nextPosition === null) break;
          after = page.nextPosition;
        }
        expect(seen).toEqual(rows.map((row) => row.position));
      }),
    ));

  it("studio_thread_read refuses afterPosition with beforePosition", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .readThread(scope, { threadId, afterPosition: 1, beforePosition: 10 } as never)
          .pipe(Effect.flip);
        expect(error.code).toBe("invalid_request");
      }),
    ));

  it("studio_thread_read keeps the newest items under the budget and pages back to the rest", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.readThread(scope, { threadId });
        expect(bytes(first)).toBeLessThanOrEqual(BUDGET_BYTES);
        expect(first.items.at(-1)?.position).toBe(49);
        expect(first.nextPosition).toBe(49);
        expect(first.hasMore).toBe(false);
        const cut = first as typeof first & {
          readonly omittedItems?: number;
          readonly earlierPosition?: number | null;
        };
        expect(cut.omittedItems).toBe(50 - first.items.length);
        expect(cut.earlierPosition).toBe(first.items[0]?.position);

        // Paging back with beforePosition reaches every item exactly once.
        const seen = first.items.map((item) => item.position);
        let before = cut.earlierPosition ?? null;
        while (before !== null) {
          const page = (yield* service.readThread(scope, {
            threadId,
            beforePosition: before,
          } as never)) as typeof cut;
          expect(bytes(page)).toBeLessThanOrEqual(BUDGET_BYTES);
          seen.unshift(...page.items.map((item) => item.position));
          before = page.earlierPosition ?? null;
        }
        expect(seen).toEqual(rows.map((row) => row.position));
      }),
    ));

  it("studio_thread_read still pages forward with afterPosition and limit", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const page = yield* service.readThread(scope, {
          threadId,
          afterPosition: 9,
          limit: 1,
          maxCharsPerItem: 100,
        });
        expect(page.items.map((item) => item.position)).toEqual([10]);
        expect(page.items[0]?.text).toHaveLength(100);
        expect(page.nextPosition).toBe(10);
        expect(page.hasMore).toBe(true);
        expect((page as { readonly omittedItems?: number }).omittedItems).toBeUndefined();
      }),
    ));

  it("studio_thread_read fits one item larger than the budget and keeps its text reachable", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const big = rows[49]!;
        const saved = big.item.text;
        (big.item as { text: string }).text = "y".repeat(60_000);
        try {
          const page = yield* service.readThread(scope, {
            threadId,
            itemId: big.sourceItemId,
            maxCharsPerItem: 50_000,
          });
          expect(bytes(page)).toBeLessThanOrEqual(BUDGET_BYTES);
          expect(page.items).toHaveLength(1);
          expect(page.items[0]?.textTruncated).toBe(true);
          const next = page.items[0]?.nextTextOffset ?? 0;
          expect(next).toBe(page.items[0]?.text?.length);
        } finally {
          (big.item as { text: string }).text = saved;
        }
      }),
    ));

  it("orchestrator_capabilities fits the budget on a large catalog and serves each instance in full", () =>
    run(
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = service.capabilities as (
          scope: McpInvocationScope,
          input?: { readonly providerInstanceId?: ProviderInstanceId; readonly modelOffset?: number },
        ) => ReturnType<typeof service.capabilities>;
        const compact = yield* capabilities(scope);
        expect(bytes(compact)).toBeLessThanOrEqual(BUDGET_BYTES);
        // Every instance and model id is still listed.
        expect(
          compact.providers.map((provider) => [provider.providerInstanceId, provider.models.length]),
        ).toEqual(catalog.map((provider) => [provider.instanceId, provider.models.length]));

        // One instance's full detail, paged by modelOffset, reaches every model's options.
        const devin = ProviderInstanceId.make("acpRegistry_devin");
        const options: Array<unknown> = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page = (yield* capabilities(scope, {
            providerInstanceId: devin,
            modelOffset: offset,
          })) as typeof compact & { readonly detail?: { readonly nextModelOffset?: number | null } };
          expect(bytes(page)).toBeLessThanOrEqual(BUDGET_BYTES);
          expect(page.providers.map((provider) => provider.providerInstanceId)).toEqual([devin]);
          options.push(...page.providers[0]!.models.map((model) => model.options));
          offset = page.detail?.nextModelOffset ?? null;
        }
        expect(options).toHaveLength(145);
        expect(options.every((value) => Array.isArray(value) && value.length === 3)).toBe(true);
      }),
    ));
});
