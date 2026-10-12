import type { OrchestrationV2AppThread } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";

type ResolutionGuardInput = {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "projectId"
    | "updatedAt"
    | "settledOverride"
    | "archivedAt"
    | "deletedAt"
    | "pinnedAt"
    | "autoSettleDisabledAt"
  >;
  readonly snapshotAt: DateTime.Utc;
  readonly snapshotSequence: number;
  readonly currentSequence: number;
};

/** Called under the existing thread command lock; timestamps alone can collide. */
export function canAutomaticallyResolve(input: ResolutionGuardInput): boolean {
  const { thread, snapshotSequence, currentSequence } = input;
  return (
    Number.isSafeInteger(snapshotSequence) &&
    snapshotSequence >= 0 &&
    snapshotSequence === currentSequence &&
    thread.settledOverride === null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.pinnedAt == null &&
    thread.autoSettleDisabledAt == null &&
    DateTime.toEpochMillis(thread.updatedAt) <= DateTime.toEpochMillis(input.snapshotAt)
  );
}

/** Capture the service once; read its current value under the thread command lock. */
export const makeAutomaticResolutionGuard = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  return (input: ResolutionGuardInput) =>
    canAutomaticallyResolve(input)
      ? settings.getSettings.pipe(
          Effect.map(
            (current) =>
              resolveProjectSettings(current, input.thread.projectId).settings
                .sidebarAutoSettleOnMerge,
          ),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(false);
});
