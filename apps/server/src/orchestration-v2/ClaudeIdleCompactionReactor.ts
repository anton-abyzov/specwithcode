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

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Claude Code compacts an idle session itself only in its interactive
 * terminal and desktop app, behind a server flag; the SDK sessions Studio
 * runs never do. Its auto-compact waits for the window (400K in Studio), so
 * a thread left at 100-400K stays full, and the next message after the hour
 * rewrites all of it into a cold cache. This reactor does what Claude Code's
 * idle compaction does: shortly before the 1-hour prompt cache lapses, it
 * sends /compact to an idle Claude thread that is large enough, so the
 * summary is written from a warm cache and the next message starts small.
 */

/** Claude Code's 1-hour prompt cache. */
export const CLAUDE_PROMPT_CACHE_TTL_MS = 60 * 60_000;
/** Claude Code fires idle compaction at 90% of the cache lifetime. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60_000;
/** Past this the cache has lapsed or is about to; compacting gains nothing then. */
export const IDLE_COMPACT_BEFORE_MS = 59 * 60_000;
/**
 * Claude Code's floor for CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, and the size
 * at which it asks to compact on resume.
 */
export const IDLE_COMPACT_MIN_TOKENS = 100_000;
const SWEEP_SECONDS = 60;

/** CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, read the way Claude Code reads it: never below 100K. */
export function idleCompactMinTokens(value: string | undefined): number {
  const parsed = Number(value?.trim() || Number.NaN);
  return Number.isFinite(parsed)
    ? Math.max(IDLE_COMPACT_MIN_TOKENS, parsed)
    : IDLE_COMPACT_MIN_TOKENS;
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
  >,
  now: number,
): boolean {
  if (
    thread.archivedAt !== null ||
    thread.status !== "idle" ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    thread.activeProviderThreadId === null ||
    thread.latestRunCompletedAt === null ||
    thread.latestRunCompletedAt === undefined ||
    // Finished work and delegated subagents are rarely written to again.
    (thread.settledAt !== null && thread.settledOverride !== "active") ||
    thread.lineage.relationshipToParent === "subagent"
  ) {
    return false;
  }
  const idleMs = now - DateTime.toEpochMillis(thread.latestRunCompletedAt);
  return idleMs >= IDLE_COMPACT_AFTER_MS && idleMs < IDLE_COMPACT_BEFORE_MS;
}

/**
 * The context the provider thread holds now: the last finished turn's usage.
 * Null when the last turn was a /compact, so a compacted thread is left alone.
 */
export function idleCompactionUsedTokens(
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "ordinal" | "status" | "tokenUsage">
  >,
  providerThreadId: string,
  lastUserText: string | undefined,
): number | null {
  if (lastUserText?.trim().toLowerCase() === "/compact") return null;
  const last = providerTurns
    .filter((turn) => turn.providerThreadId === providerThreadId && turn.status === "completed")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return last?.tokenUsage?.usedTokens ?? null;
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
  if (Option.isNone(decoded) || !decoded.value.idleCompaction) return null;
  const fromInstance = entry.environment?.findLast(
    (variable) => variable.name === "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS",
  )?.value;
  return {
    minTokens: idleCompactMinTokens(
      fromInstance ?? process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS,
    ),
  };
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
      const usedTokens = idleCompactionUsedTokens(
        records.providerTurns,
        thread.activeProviderThreadId!,
        lastUserText,
      );
      if (usedTokens === null || usedTokens < minTokens) return;
      const now = yield* Clock.currentTimeMillis;
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
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
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
