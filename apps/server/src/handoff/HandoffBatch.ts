/**
 * The hand off batch (1390). Stubs only: this commit holds the failing tests.
 */
import type {
  HandoffBatchInput,
  HandoffBatchRun,
  HandoffCheckpoint,
  HandoffModeError,
  HandoffTransferTrigger,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { HandoffPlan } from "./handoffPlan.ts";
import type { HandoffRefusal, ReceiverCaller } from "./HandoffReceiver.ts";
import type { FolderWorkRequest, FolderWorkResponse, TakeoverRequest } from "./handoffWire.ts";

export const coordinatorStays = (label: string) => `stub ${label}`;

export function batchInputFromPlan(
  plan: HandoffPlan,
  _trigger?: HandoffTransferTrigger,
): HandoffBatchInput {
  return { destinationEnvironmentId: plan.target.environmentId, start: plan.start, threads: [] };
}

export function batchArrival(input: {
  readonly batch: TakeoverRequest["batch"];
  readonly sequence: number;
  readonly checkpoint: Pick<HandoffCheckpoint, "sequence" | "commit">;
  readonly resumable: boolean;
}): { readonly kind: "take"; readonly resume: boolean } | { readonly kind: "refuse" } {
  return { kind: "take", resume: input.resumable };
}

export async function applyFolderWork(_input: {
  readonly root: string;
  readonly branch: string;
  readonly operationId: string;
}): Promise<{ readonly applied: boolean; readonly reason: string | null }> {
  return { applied: false, reason: "stub" };
}

export class FolderWorkReceiver extends Context.Service<
  FolderWorkReceiver,
  {
    readonly apply: (
      caller: ReceiverCaller,
      request: FolderWorkRequest,
    ) => Effect.Effect<FolderWorkResponse, HandoffRefusal>;
  }
>()("specweave-studio/handoff/FolderWorkReceiver") {}

export const makeFolderWorkReceiver = Effect.succeed(
  FolderWorkReceiver.of({
    apply: () => Effect.succeed({ machineLabel: "stub", applied: false, reason: "stub" }),
  }),
);

export interface FolderWorkOutcome {
  readonly state: "ready" | "stayed" | "failed";
  readonly detail: string;
}

export const makeFolderWorkSender =
  (_deps: unknown) =>
  (_input: unknown): Effect.Effect<FolderWorkOutcome> =>
    Effect.succeed({ state: "stayed", detail: "stub" });

export function makeHandoffBatch(_deps: unknown) {
  return {
    run: (input: HandoffBatchInput): Effect.Effect<HandoffBatchRun, HandoffModeError> =>
      Effect.succeed({
        batchId: "stub",
        start: input.start,
        trigger: input.trigger ?? { kind: "manual" },
        destination: { environmentId: input.destinationEnvironmentId, label: "stub" },
        rows: [],
        startedAt: "2026-11-19T14:00:00.000Z",
        finishedAt: null,
      }),
    read: (_input: { readonly batchId?: string | undefined }) =>
      Effect.succeed<ReadonlyArray<HandoffBatchRun>>([]),
  };
}
