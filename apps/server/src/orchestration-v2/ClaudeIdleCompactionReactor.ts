import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { claudeMainThreadPromptCacheTtl } from "../provider/ClaudePromptCache.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Claude Code compacts an idle session itself only in its interactive
 * terminal and desktop app, behind a server flag; the SDK sessions
 * SpecWithCode runs never do. By default SpecWithCode leaves an idle thread alone and
 * Claude Code asks, when the person returns to a large one, whether to
 * compact it (the resume prompt in ClaudeAdapterV2). With
 * compactBeforeCacheExpires on,
 * this reactor compacts ahead of time instead: shortly before the 1-hour
 * prompt cache lapses, it sends /compact to an idle top-level Claude thread
 * that is large enough, so the summary is written from a warm cache.
 */

/** Claude Code's 1-hour prompt cache, which SpecWithCode asks for on every thread. */
export const CLAUDE_PROMPT_CACHE_TTL_MS = 60 * 60_000;
/** Claude Code fires idle compaction at 90% of the cache lifetime. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60_000;
/** Past this the cache has lapsed or is about to; compacting gains nothing then. */
export const IDLE_COMPACT_BEFORE_MS = 59 * 60_000;
/** Claude Code's floor for CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS. */
export const IDLE_COMPACT_MIN_TOKENS = 100_000;
/**
 * Claude Code's default idle-compaction size. Below it a cold re-read is
 * cheap, so compacting mostly loses context for little saving.
 */
export const IDLE_COMPACT_DEFAULT_MIN_TOKENS = 200_000;
/** The cache must outlive the compaction's own request by this much. */
const IDLE_COMPACT_CACHE_MARGIN_MS = 2 * 60_000;
const SWEEP_SECONDS = 60;

/**
 * CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, read the way Claude Code reads it:
 * 200K when unset, never below 100K.
 */
export function idleCompactMinTokens(value: string | undefined): number {
  const parsed = Number(value?.trim() || Number.NaN);
  return Number.isFinite(parsed)
    ? Math.max(IDLE_COMPACT_MIN_TOKENS, parsed)
    : IDLE_COMPACT_DEFAULT_MIN_TOKENS;
}

/** Whether a quiet thread's shell makes it a candidate, before its records are read. */
export function isIdleCompactionCandidate(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "archivedAt"
    | "status"
    | "activeRunId"
    | "pendingRuntimeRequest"
    | "activeProviderThreadId"
    | "latestRunCompletedAt"
    | "settledAt"
    | "settledOverride"
    | "lineage"
    | "heldQueuedCount"
    | "pendingBackgroundTasks"
    | "snoozedUntil"
  >,
  now: number,
): boolean {
  if (
    thread.archivedAt !== null ||
    // A shell reads its latest run's status: a thread waiting after a finished
    // turn is "completed", and "idle" only before its first run. An
    // interrupted, failed or cancelled turn is left for the person.
    (thread.status !== "idle" && thread.status !== "completed") ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    // A held queue waits for the person; a /compact would run right after
    // their next message instead of before it.
    (thread.heldQueuedCount ?? 0) > 0 ||
    thread.activeProviderThreadId === null ||
    thread.latestRunCompletedAt === null ||
    thread.latestRunCompletedAt === undefined ||
    // Background work reports into the next turn; a compaction would swallow it.
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > now) ||
    (thread.settledAt !== null && thread.settledOverride !== "active") ||
    // Subagents, delegated workers included, mostly finish and are never
    // written to again; a follow-up that does come gets the resume prompt.
    thread.lineage.relationshipToParent === "subagent"
  ) {
    return false;
  }
  const idleMs = now - DateTime.toEpochMillis(thread.latestRunCompletedAt);
  return idleMs >= IDLE_COMPACT_AFTER_MS && idleMs < IDLE_COMPACT_BEFORE_MS;
}

/**
 * The context the provider thread holds now: the last finished turn's usage.
 * Null when the last turn was a /compact, so a compacted thread is left alone,
 * or when its cache will have lapsed before a compaction could read it: the
 * last request, not the run's end, starts the cache's hour.
 */
export function idleCompactionUsedTokens(
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "ordinal" | "status" | "tokenUsage">
  >,
  providerThreadId: string,
  lastUserText: string | undefined,
  now: number,
): number | null {
  if (lastUserText?.trim().toLowerCase() === "/compact") return null;
  const usage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThreadId && turn.status === "completed")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.tokenUsage;
  if (usage === undefined) return null;
  const lastRequestAt = Date.parse(usage.updatedAt);
  if (
    !Number.isFinite(lastRequestAt) ||
    lastRequestAt + CLAUDE_PROMPT_CACHE_TTL_MS - now < IDLE_COMPACT_CACHE_MARGIN_MS
  ) {
    return null;
  }
  return usage.usedTokens;
}

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** The Claude instance's idle-compaction policy, or null when it is not Claude or turned off. */
export function claudeIdleCompactionPolicy(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): { readonly minTokens: number } | null {
  const entry = deriveProviderInstanceConfigMap(settings)[instanceId];
  if (entry === undefined || entry.driver !== "claudeAgent" || entry.enabled === false) return null;
  const decoded = decodeClaudeSettings(entry.config ?? {});
  if (Option.isNone(decoded) || !decoded.value.compactBeforeCacheExpires) return null;
  const environment = mergeProviderInstanceEnvironment(entry.environment, process.env);
  // At 54 minutes a 5-minute cache is long gone: the summary would be written
  // from a cold cache and save nothing over the next message's own rewrite.
  if (claudeMainThreadPromptCacheTtl(environment) !== "1h") return null;
  return { minTokens: idleCompactMinTokens(environment.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) };
}

export class ClaudeIdleCompactionReactor extends Context.Service<
  ClaudeIdleCompactionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over the idle Claude threads. */
    readonly sweep: Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/ClaudeIdleCompactionReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  const updateHold = yield* ServiceUpdateHold.optional;
  // The run each thread was compacted after, so one quiet spell sends one /compact.
  const compactedAfterRun = new Map<string, string>();

  const compactThread = (thread: OrchestrationV2ThreadShell, minTokens: number) =>
    Effect.gen(function* () {
      const latestRunId = thread.latestRunId;
      if (latestRunId === null || compactedAfterRun.get(thread.id) === latestRunId) return;
      const target = { projectId: ProjectId.make(thread.projectId), threadId: thread.id };
      const records = yield* threads.getProjectThreadRecords(
        target,
        ["providerTurns", "messages"],
        {
          messageRunIds: [latestRunId],
          messageRoles: ["user"],
        },
      );
      compactedAfterRun.set(thread.id, latestRunId);
      const lastUserText = records.messages.at(-1)?.text;
      const now = yield* Clock.currentTimeMillis;
      const usedTokens = idleCompactionUsedTokens(
        records.providerTurns,
        thread.activeProviderThreadId!,
        lastUserText,
        now,
      );
      if (usedTokens === null || usedTokens < minTokens) return;
      // The sweep's snapshot can be half a minute old; a message, settle or
      // archive since then means the thread is no longer idle.
      const current = yield* threads.getThreadShell(thread.id);
      if (
        current === null ||
        current.latestRunId !== latestRunId ||
        !isIdleCompactionCandidate(current, now)
      ) {
        return;
      }
      yield* threads.sendToThread({
        ...target,
        commandId: CommandId.make(`server:idle-compact:${thread.id}:${latestRunId}`),
        messageId: MessageId.make(`message:idle-compact:${thread.id}:${now}`),
        text: "/compact",
        attachments: [],
        // A message that lands meanwhile goes first; this one never interrupts.
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
      yield* Effect.logInfo("compacted idle Claude thread", { threadId: thread.id, usedTokens });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("idle compaction failed", { threadId: thread.id, cause }),
      ),
    );

  const sweep: ClaudeIdleCompactionReactor["Service"]["sweep"] = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* threads.getShellSnapshot({
      location: "active",
      maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
    });
    const live = new Set(snapshot.threads.map((thread) => thread.id as string));
    for (const id of compactedAfterRun.keys()) if (!live.has(id)) compactedAfterRun.delete(id);
    const policies = new Map<ProviderInstanceId, { readonly minTokens: number } | null>();
    const due = snapshot.threads.flatMap((thread) => {
      if (!isIdleCompactionCandidate(thread, now)) return [];
      const instanceId = thread.modelSelection.instanceId;
      if (!policies.has(instanceId)) {
        policies.set(instanceId, claudeIdleCompactionPolicy(settings, instanceId));
      }
      const policy = policies.get(instanceId);
      return policy ? [{ thread, minTokens: policy.minTokens }] : [];
    });
    yield* Effect.forEach(due, ({ thread, minTokens }) => compactThread(thread, minTokens), {
      concurrency: 2,
      discard: true,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("idle compaction sweep failed", { cause }),
    ),
    Effect.withSpan("ClaudeIdleCompactionReactor.sweep"),
  );

  const start: ClaudeIdleCompactionReactor["Service"]["start"] = () =>
    forkParked(
      sweep.pipe(
        ServiceUpdateHold.skipWhileHeld(updateHold),
        Effect.repeat(Schedule.spaced(`${SWEEP_SECONDS} seconds`)),
        Effect.asVoid,
      ),
    );

  return { start, sweep } satisfies ClaudeIdleCompactionReactor["Service"];
});

export const layer = Layer.effect(ClaudeIdleCompactionReactor, make);
