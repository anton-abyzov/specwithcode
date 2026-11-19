/**
 * What a destination answers a source that asks what became of a takeover
 * (`transfer-status`): its receipt, or "not accepted", which is written before
 * it is said. The receiver calls this under the source thread's takeover lock.
 */
import { type EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { HandoffRefusal, ReceiverCaller } from "./HandoffReceiver.ts";
import * as HandoffTransferStore from "./HandoffTransferStore.ts";
import { type HandoffDocument, findIncoming, incomingKey, markContinued } from "./handoffState.ts";
import type {
  TakeoverReason,
  TakeoverRequest,
  TakeoverResponse,
  TransferStatusRequest,
  TransferStatusResponse,
} from "./handoffWire.ts";

type TransferDocument = Effect.Success<HandoffTransferStore.HandoffTransferStoreShape["read"]>;

export interface TransferStatusDeps {
  readonly label: string;
  /** Prefixes a message with this machine's name. */
  readonly at: (message: string) => string;
  readonly nowIso: Effect.Effect<string>;
  readonly document: Effect.Effect<HandoffDocument, HandoffRefusal>;
  readonly updateDocument: <A>(
    change: (document: HandoffDocument) => readonly [A, HandoffDocument],
  ) => Effect.Effect<A, HandoffRefusal>;
  readonly updateTransfers: <A>(
    change: (document: TransferDocument) => readonly [A, TransferDocument],
  ) => Effect.Effect<A, HandoffRefusal>;
  /** The id a takeover of this source thread at this epoch continues under. */
  readonly continuationId: (
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: string,
    epoch: number,
  ) => ThreadId;
  /** Where threads are read; none when this machine has no projections to ask. */
  readonly projections: Option.Option<
    Pick<ProjectionStore.ProjectionStoreV2Shape, "getThreadShell">
  >;
  /** Finishes a takeover this machine accepted and whose launch was cut. */
  readonly takeover: (
    caller: ReceiverCaller,
    request: TakeoverRequest,
  ) => Effect.Effect<TakeoverResponse, HandoffRefusal>;
  /** No verdict: this machine may have acted, so the source keeps its hold. */
  readonly uncertain: (message: string) => HandoffRefusal;
}

type LineageRefusal = { readonly code: "invalid" | "fenced"; readonly message: string } | null;
const ANSWERED = "this handoff was already answered as not accepted; start it again";
const taken = (epoch: number) => `another handoff already took this thread at epoch ${epoch}`;

/** Why a takeover is refused for the verdict already on record for its lineage. */
export const recordedRefusal = (
  recorded: TransferDocument["acceptances"][string],
  operationId: string | null,
  request: Pick<TakeoverRequest, "epoch" | "sequence">,
): LineageRefusal =>
  recorded.verdict === "not-accepted"
    ? { code: "invalid", message: ANSWERED }
    : recorded.operationId !== operationId || recorded.sequence !== request.sequence
      ? { code: "fenced", message: taken(request.epoch) }
      : null;

/** Why a takeover that did not claim its lineage is refused. */
export const claimRefusal = (claim: HandoffTransferStore.AcceptanceClaim): LineageRefusal =>
  claim.kind === "not-accepted"
    ? { code: "invalid", message: ANSWERED }
    : claim.kind === "divergent" || claim.kind === "stale"
      ? { code: "fenced", message: taken(claim.acceptance.lineage.epoch) }
      : null;

/** What a failure says once this machine's acceptance stands. */
export const acceptedMessage = (message: string, label: string) =>
  `${message} ${label} had accepted this handoff, so it may run the thread; ask again.`.slice(
    0,
    1000,
  );

/**
 * Takes back what a takeover wrote for a thread its launch refused to create:
 * the lease record, and the receipt naming that start. Nothing began here.
 */
export function dropUnstarted(
  document: HandoffDocument,
  threadId: string,
  receiptKey: string,
): HandoffDocument {
  if (document.threads[threadId] === undefined) return document;
  const threads = Object.fromEntries(
    Object.entries(document.threads).filter(([id]) => id !== threadId),
  ) as HandoffDocument["threads"];
  const receipts = document.continuationReceipts ?? {};
  const noted = receipts[receiptKey];
  if (noted === undefined || noted.launched || noted.threadId !== threadId) {
    return { ...document, threads };
  }
  const { [receiptKey]: _unstarted, ...rest } = receipts;
  return { ...document, threads, continuationReceipts: rest };
}

export const makeTransferStatus =
  (deps: TransferStatusDeps) =>
  (
    caller: ReceiverCaller,
    request: TransferStatusRequest,
  ): Effect.Effect<TransferStatusResponse, HandoffRefusal> =>
    Effect.gen(function* () {
      const lineage = {
        sourceEnvironmentId: caller.sourceEnvironmentId,
        sourceThreadId: request.sourceThreadId,
        epoch: request.epoch,
      };
      const current = yield* deps.document;
      const replica = findIncoming(current, caller.sourceEnvironmentId, request.sourceThreadId);
      const detail = (current.incomingDetails ?? {})[
        incomingKey(caller.sourceEnvironmentId, request.sourceThreadId)
      ];
      // A copy continued here before transfer records existed has no acceptance on record.
      if (replica?.continuedThreadId != null && detail?.takeover != null) {
        return {
          machineLabel: deps.label,
          status: "accepted",
          receipt: detail.takeover,
        } satisfies TransferStatusResponse;
      }
      const now = yield* deps.nowIso;
      const recorded = yield* deps.updateTransfers(
        (document) =>
          [document.acceptances[HandoffTransferStore.acceptanceKey(lineage)], document] as const,
      );
      if (recorded === undefined) {
        // Nothing on record for this lineage, so "not accepted" would be written
        // below. The release before transfer records wrote the continuation's
        // lease, launched it, and only then marked the copy continued: a thread
        // it launched may be running here with no mark at all.
        const continued = deps.continuationId(
          caller.sourceEnvironmentId,
          request.sourceThreadId,
          request.epoch,
        );
        const leased = (current.threads[continued]?.lease ?? null) !== null;
        // A takeover at this epoch that launched here names its thread for good, even
        // once that thread and the copy are gone: never "not accepted" after that.
        const launched = (current.continuationReceipts ?? {})[
          incomingKey(caller.sourceEnvironmentId, request.sourceThreadId)
        ];
        if (launched?.launched === true && launched.epoch === request.epoch) {
          return {
            machineLabel: deps.label,
            status: "accepted",
            receipt: {
              threadId: ThreadId.make(launched.threadId),
              machineLabel: deps.label,
              modelSelection: null,
              resumed: false,
              notice: null,
            },
          } satisfies TransferStatusResponse;
        }
        // Whether that thread exists here; "unknown" when it cannot be read.
        const shell = Option.isNone(deps.projections)
          ? ("unknown" as const)
          : yield* deps.projections.value.getThreadShell(continued).pipe(
              Effect.map((found) => (found === null ? ("absent" as const) : ("present" as const))),
              Effect.orElseSucceed(() => "unknown" as const),
            );
        if (shell === "present") {
          const receipt: TakeoverResponse = {
            threadId: continued,
            machineLabel: deps.label,
            modelSelection: null,
            resumed: false,
            notice: null,
          };
          yield* deps.updateDocument((document) => {
            const next = markContinued(
              document,
              {
                sourceEnvironmentId: caller.sourceEnvironmentId,
                sourceThreadId: request.sourceThreadId,
                epoch: request.epoch,
                sequence: replica?.checkpoint.sequence ?? 0,
                reason: "handoff",
                modelSelection: null,
              },
              receipt,
              now,
            );
            return [undefined, next] as const;
          });
          return {
            machineLabel: deps.label,
            status: "accepted",
            receipt,
          } satisfies TransferStatusResponse;
        }
        if (shell === "unknown" && leased) {
          // The lease says a launch was about to happen; whether it did cannot be read.
          return yield* deps.uncertain(
            deps.at(
              "it holds a lease for this thread's continuation and cannot read whether it started",
            ),
          );
        }
      }
      const settled = yield* deps.updateTransfers((document) =>
        HandoffTransferStore.settleLineage(document, {
          lineage,
          operationId: request.operationId,
          now,
        }),
      );
      if (settled.verdict === "accepted") {
        // A restart cut the launch after the acceptance: finish it as it was asked.
        const receipt = settled.launched
          ? settled.receipt
          : yield* deps.takeover(caller, {
              sourceEnvironmentId: caller.sourceEnvironmentId,
              sourceThreadId: request.sourceThreadId,
              epoch: settled.lineage.epoch,
              sequence: settled.sequence ?? 0,
              reason: settled.reason as TakeoverReason,
              modelSelection: settled.modelSelection,
              ...(settled.operationId === null ? {} : { operationId: settled.operationId }),
              ...(settled.trigger === null ? {} : { trigger: settled.trigger }),
            });
        return {
          machineLabel: deps.label,
          status: "accepted",
          receipt,
        } satisfies TransferStatusResponse;
      }
      // The copy's lease moves up to the refused epoch, so a takeover from a
      // source that sends no operation id is refused as stale too.
      yield* deps.updateDocument((document) => {
        const held = findIncoming(document, caller.sourceEnvironmentId, request.sourceThreadId);
        if (held === undefined || held.continuedThreadId !== null) return [undefined, document];
        if (held.lease.epoch >= request.epoch) return [undefined, document];
        return [
          undefined,
          {
            ...document,
            incoming: document.incoming.map((entry) =>
              entry === held
                ? { ...entry, lease: { ...entry.lease, epoch: request.epoch, renewedAt: now } }
                : entry,
            ),
          },
        ];
      });
      return {
        machineLabel: deps.label,
        status: "not-accepted",
        receipt: null,
      } satisfies TransferStatusResponse;
    });
