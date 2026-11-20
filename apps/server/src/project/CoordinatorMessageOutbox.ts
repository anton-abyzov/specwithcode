import * as Data from "effect/Data";
import { stringifyJson } from "../json.ts";
import type { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { ProjectServiceError } from "./ProjectService.ts";
import type { CoordinatorMessageStoreError } from "./CoordinatorMessageStore.ts";
/** Durable outgoing messages. A retry keeps both ids, including after a lost reply. */
import {
  COORDINATOR_MESSAGE_CAPABILITY,
  coordinatorMessageProblem,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type {
  CoordinatorMessageDeliverRequest,
  CoordinatorMessageDeliverResponse,
} from "../handoff/coordinatorMessageWire.ts";
import {
  type CoordinatorMessageRecord,
  type CoordinatorMessageStoreShape,
  coordinatorMessageRowId,
} from "./CoordinatorMessageStore.ts";

export class CoordinatorMessageOutboxError extends Data.TaggedError(
  "CoordinatorMessageOutboxError",
)<{ readonly message: string }> {}
export type OutboxFailure =
  | CoordinatorMessageOutboxError
  | CoordinatorMessageStoreError
  | ProjectServiceError
  | HandoffPeerError;

export const COORDINATOR_MESSAGE_OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

export interface CoordinatorMessageOutboxDeps {
  readonly store: CoordinatorMessageStoreShape;
  /**
   * Rechecks current link membership, grant, capabilities and coordinator
   * authority. A failure is transient: the row waits for the next pass.
   */
  readonly authorize: (record: CoordinatorMessageRecord) => Effect.Effect<boolean, OutboxFailure>;
  readonly deliver: (
    record: CoordinatorMessageRecord,
    request: CoordinatorMessageDeliverRequest,
  ) => Effect.Effect<CoordinatorMessageDeliverResponse, OutboxFailure>;
  readonly receipt?: (
    record: CoordinatorMessageRecord,
  ) => Effect.Effect<"read" | "final" | undefined, OutboxFailure>;
  /**
   * Resolve the receiver's project from the current link, never a cached
   * project id. `undefined` means it is no longer linked.
   */
  readonly receiverProject: (
    record: CoordinatorMessageRecord,
  ) => Effect.Effect<ProjectId | undefined, OutboxFailure>;
}

/** Only an answer that may change on retry keeps a message queued. */
const transientFailure = (error: OutboxFailure) =>
  error._tag !== "HandoffPeerError" ||
  error.uncertain ||
  error.code === "unreachable" ||
  error.code === "busy" ||
  error.code === "failed";

export const makeOutbox = (deps: CoordinatorMessageOutboxDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    /** The peer's definite refusal of a row, so the sender hears why (1427 AC-12). */
    const refusals = new Map<string, string>();
    const setState = (
      id: string,
      state: CoordinatorMessageRecord["state"],
      receiverMessageId?: string,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* deps.store.update(now, (rows) => ({
          records: rows.map((row) =>
            row.id === id &&
            // A delivered message never goes back: a receipt can only say it was read.
            (row.state === "queued" || (row.state === "delivered" && state === "read"))
              ? {
                  ...row,
                  state,
                  updatedAt: now,
                  ...(receiverMessageId === undefined ? {} : { receiverMessageId }),
                }
              : row,
          ),
          result: undefined,
        }));
      });
    const stopReceipts = (id: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* deps.store.update(now, (rows) => ({
          records: rows.map((row) =>
            row.id === id && row.state === "delivered"
              ? { ...row, receiptStopped: true, updatedAt: now }
              : row,
          ),
          result: undefined,
        }));
      });
    return {
      /** Caller supplies stable ids once. Persist before any network operation. */
      /**
       * `onePerRun`: the sending turn was woken by a coordinator message, so it
       * sends one message in all; checked in the same write that appends it.
       */
      enqueue: (record: CoordinatorMessageRecord, onePerRun = false) =>
        Effect.gen(function* () {
          const problem = coordinatorMessageProblem(record);
          if (problem !== null)
            return yield* Effect.fail(
              new CoordinatorMessageOutboxError({ message: problem.message }),
            );
          if (
            record.direction !== "outgoing" ||
            record.state !== "queued" ||
            record.clientRequestIds.length !== 1 ||
            record.clientRequestIds[0]!.trim() === "" ||
            record.id !== coordinatorMessageRowId({ ...record })
          )
            return yield* Effect.fail(
              new CoordinatorMessageOutboxError({
                message: "An outgoing message needs stable message and request ids.",
              }),
            );
          if (!(yield* deps.authorize(record)))
            return yield* Effect.fail(
              new CoordinatorMessageOutboxError({
                message: "This coordinator may no longer send this message.",
              }),
            );
          const now = yield* Clock.currentTimeMillis;
          const result = yield* deps.store.update<string | CoordinatorMessageOutboxError>(
            now,
            (rows) => {
              const collision = rows.find((row) => row.id === record.id);
              if (
                collision !== undefined &&
                (collision.clientRequestIds[0] !== record.clientRequestIds[0] ||
                  stringifyJson([
                    collision.kind,
                    collision.subject,
                    collision.text,
                    collision.refs,
                    collision.userStep,
                    collision.replyTo,
                  ]) !==
                    stringifyJson([
                      record.kind,
                      record.subject,
                      record.text,
                      record.refs,
                      record.userStep,
                      record.replyTo,
                    ]))
              )
                return {
                  records: rows,
                  result: new CoordinatorMessageOutboxError({
                    message: "A message id cannot be reused for different content.",
                  }),
                };
              const prior = rows.find(
                (row) =>
                  row.direction === "outgoing" &&
                  row.projectId === record.projectId &&
                  row.peerEnvironmentId === record.peerEnvironmentId &&
                  row.clientRequestIds.includes(record.clientRequestIds[0]!),
              );
              if (
                prior !== undefined &&
                stringifyJson([
                  prior.kind,
                  prior.subject,
                  prior.text,
                  prior.refs,
                  prior.userStep,
                  prior.replyTo,
                  prior.logicalProjectId,
                ]) !==
                  stringifyJson([
                    record.kind,
                    record.subject,
                    record.text,
                    record.refs,
                    record.userStep,
                    record.replyTo,
                    record.logicalProjectId,
                  ])
              )
                return {
                  records: rows,
                  result: new CoordinatorMessageOutboxError({
                    message: "A request id cannot be reused for different content.",
                  }),
                };
              if (
                prior === undefined &&
                onePerRun &&
                record.sourceRunId !== undefined &&
                rows.some(
                  (row) =>
                    row.direction === "outgoing" &&
                    row.projectId === record.projectId &&
                    row.sourceRunId === record.sourceRunId,
                )
              )
                return {
                  records: rows,
                  result: new CoordinatorMessageOutboxError({
                    message: "A woken turn sends one reply.",
                  }),
                };
              return prior === undefined
                ? {
                    records: [...rows, { ...record, receivedAt: now, updatedAt: now }],
                    result: record.externalId,
                  }
                : { records: rows, result: prior.externalId };
            },
          );
          if (result instanceof CoordinatorMessageOutboxError) return yield* Effect.fail(result);
          return result;
        }),
      /** Serialized passes prevent reconnect and regular sync from sending concurrently. */
      flush: lock.withPermit(
        Effect.gen(function* () {
          const rows = yield* deps.store.all;
          for (const row of rows) {
            if (row.direction !== "outgoing") continue;
            if (row.state === "delivered" && deps.receipt !== undefined && !row.receiptStopped) {
              const allowed = yield* deps.authorize(row).pipe(Effect.result);
              if (allowed._tag === "Failure" || !allowed.success) continue;
              const receipt = yield* deps.receipt(row).pipe(Effect.result);
              if (receipt._tag === "Success") {
                if (receipt.success === "read") yield* setState(row.id, "read");
                else if (receipt.success === "final") yield* stopReceipts(row.id);
              } else if (!transientFailure(receipt.failure)) {
                // The receiver no longer keeps it or refuses to answer: stop asking, still delivered.
                yield* stopReceipts(row.id);
              }
              continue;
            }
            if (row.state !== "queued") continue;
            const now = yield* Clock.currentTimeMillis;
            if (now - row.receivedAt >= COORDINATOR_MESSAGE_OUTBOX_TTL_MS) {
              yield* setState(row.id, "not_delivered");
              continue;
            }
            const allowed = yield* deps.authorize(row).pipe(Effect.result);
            if (allowed._tag === "Failure") continue;
            if (!allowed.success) {
              yield* setState(row.id, "not_delivered");
              continue;
            }
            const resolved = yield* deps.receiverProject(row).pipe(Effect.result);
            if (resolved._tag === "Failure") continue;
            const projectId = resolved.success;
            // Resolution may wait on I/O. Recheck authority and the deadline immediately before sending.
            const recheck = yield* deps.authorize(row).pipe(Effect.result);
            if (recheck._tag === "Failure") continue;
            const sendAt = yield* Clock.currentTimeMillis;
            if (
              projectId === undefined ||
              sendAt - row.receivedAt >= COORDINATOR_MESSAGE_OUTBOX_TTL_MS ||
              !recheck.success
            ) {
              yield* setState(row.id, "not_delivered");
              continue;
            }
            const response = yield* deps
              .deliver(row, {
                capabilities: [COORDINATOR_MESSAGE_CAPABILITY],
                logicalProjectId: row.logicalProjectId,
                projectId,
                messageId: row.externalId,
                clientRequestId: row.clientRequestIds[0]!,
                message: row,
              })
              .pipe(Effect.result);
            if (response._tag === "Failure") {
              if (!transientFailure(response.failure)) {
                refusals.set(row.id, response.failure.message);
                yield* setState(row.id, "not_delivered");
              }
              continue;
            }
            if (
              response.success.capabilities.includes(COORDINATOR_MESSAGE_CAPABILITY) &&
              (response.success.messageId === row.externalId ||
                response.success.outcome === "merged" ||
                response.success.outcome === "duplicate")
            )
              yield* setState(row.id, "delivered", response.success.messageId);
          }
        }),
      ),
      /** Why the receiver definitely refused a row, when it said. */
      refusal: (id: string) => refusals.get(id),
    };
  });

import {
  COORDINATOR_MESSAGE_PATH_MAX,
  COORDINATOR_MESSAGE_REPORT_PATH,
  type CoordinatorMessageBody,
  type EnvironmentId,
  type ThreadId,
  coordinatorMessageDedupeKey,
  orchestrationV2RunStartMessageId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import { sha256 } from "../nodeCrypto.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HandoffPeers } from "../handoff/handoffPeers.ts";
import { readReportPage } from "../mcp/toolkits/coordinatorMessage/reportRead.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CoordinatorMessageStore, layer as storeLayer } from "./CoordinatorMessageStore.ts";
import { membershipOf } from "./CoordinatorMessageFrame.ts";
import { ProjectService } from "./ProjectService.ts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";

export class CoordinatorMessageOutbox extends Context.Service<
  CoordinatorMessageOutbox,
  {
    readonly send: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runId: string | null;
      readonly machine: string;
      readonly clientRequestId: string;
      readonly message: CoordinatorMessageBody;
    }) => Effect.Effect<CoordinatorMessageRecord, OutboxFailure>;
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly messageId: string;
      readonly path: string;
      readonly offset: number;
    }) => Effect.Effect<
      { readonly content: string; readonly offset: number; readonly nextOffset: number | null },
      OutboxFailure
    >;
    readonly flush: Effect.Effect<void, OutboxFailure>;
  }
>()("specweave-studio/project/CoordinatorMessageOutbox") {}

export const layer = Layer.effect(
  CoordinatorMessageOutbox,
  Effect.gen(function* () {
    const store = yield* CoordinatorMessageStore;
    const projects = yield* ProjectService;
    const peers = yield* HandoffPeers;
    const self = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const threads = Option.getOrUndefined(
      yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService),
    );
    const destination = (projectId: ProjectId, peer: EnvironmentId, logicalId: string) =>
      Effect.gen(function* () {
        const found = yield* projects.getById(projectId);
        if (
          Option.isNone(found) ||
          found.value.deletedAt !== null ||
          isPersonalAssistantProject(found.value)
        )
          return undefined;
        const identity = found.value.workspaceSettings?.logicalProject;
        if (identity === undefined || identity.id !== logicalId || peer === self) return undefined;
        const own = identity.members.filter(
          (member) => member.environmentId === self && member.projectId === projectId,
        );
        const remote = identity.members.filter((member) => member.environmentId === peer);
        // The receiver's orientation (own first), so both ends compare one stamp.
        const membershipStamp = membershipOf(found.value, peer, self);
        return own.length === 1 && remote.length === 1 && membershipStamp !== undefined
          ? { ...remote[0]!, membershipStamp }
          : undefined;
      });
    const box = yield* makeOutbox({
      store,
      authorize: (row) =>
        destination(row.projectId, row.peerEnvironmentId, row.logicalProjectId).pipe(
          Effect.map(
            (member) =>
              member !== undefined &&
              row.outgoingMembership !== undefined &&
              row.outgoingMembership === member.membershipStamp,
          ),
        ),
      receiverProject: (row) =>
        destination(row.projectId, row.peerEnvironmentId, row.logicalProjectId).pipe(
          Effect.map((member) => member?.projectId),
        ),
      deliver: (row, request) => peers.coordinatorMessage(row.peerEnvironmentId, request),
      receipt: (row) =>
        Effect.gen(function* () {
          const member = yield* destination(
            row.projectId,
            row.peerEnvironmentId,
            row.logicalProjectId,
          );
          if (member === undefined) return undefined;
          const receipt = yield* peers.coordinatorMessageReceipt(row.peerEnvironmentId, {
            capabilities: [COORDINATOR_MESSAGE_CAPABILITY],
            logicalProjectId: row.logicalProjectId,
            projectId: member.projectId,
            messageId: row.receiverMessageId ?? row.externalId,
          });
          if (!receipt.capabilities.includes(COORDINATOR_MESSAGE_CAPABILITY)) return undefined;
          if (
            receipt.state === "delivered" ||
            receipt.state === "read" ||
            receipt.state === "answered"
          )
            return "read" as const;
          // Final on the receiver without a read: the sender keeps "delivered" and stops asking.
          if (
            receipt.state === "revoked" ||
            receipt.state === "refused" ||
            receipt.state === "not_delivered" ||
            receipt.state === "quiet"
          )
            return "final" as const;
          return undefined;
        }),
    });
    const send: CoordinatorMessageOutbox["Service"]["send"] = (input) =>
      Effect.gen(function* () {
        if (input.threadId !== `project-coordinator:${input.projectId}`)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "Only this project's coordinator may send a coordinator message.",
            }),
          );
        if (!input.clientRequestId.trim() || input.clientRequestId.length > 128)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "clientRequestId must contain 1 to 128 characters.",
            }),
          );
        // A stable id first; a label only when exactly one linked machine carries it.
        const targets = yield* peers.targets;
        const byId = targets.filter(
          (item) => item.machineId === input.machine || item.environmentId === input.machine,
        );
        const target =
          byId.length > 0
            ? byId
            : targets.filter(
                (item) => item.label.trim().toLowerCase() === input.machine.trim().toLowerCase(),
              );
        if (target.length !== 1)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "Name one linked machine unambiguously.",
            }),
          );
        const project = yield* projects.getById(input.projectId);
        const logical = Option.isSome(project)
          ? project.value.workspaceSettings?.logicalProject
          : undefined;
        if (logical === undefined)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "Coordinator messages require a linked project.",
            }),
          );
        const peer = target[0]!.environmentId;
        let message = input.message;
        const refuse = (text: string) =>
          Effect.fail(new CoordinatorMessageOutboxError({ message: text }));
        // Without a run the wake rule cannot be checked, so nothing is sent (1427 AC-14).
        if (input.runId === null)
          return yield* refuse("A coordinator message is sent from a running coordinator turn.");
        for (const ref of message.refs)
          if (
            ref.kind === "report" &&
            (ref.environmentId !== self ||
              ref.path.length > COORDINATOR_MESSAGE_PATH_MAX ||
              !COORDINATOR_MESSAGE_REPORT_PATH.test(ref.path))
          )
            return yield* refuse(
              "A report reference names a report of this machine under .specweave/increments/<increment>/reports/.",
            );
        const reportRoot = Option.isSome(project) ? project.value.workspaceRoot : undefined;
        for (const ref of message.refs)
          if (ref.kind === "report") {
            const readable =
              reportRoot === undefined
                ? undefined
                : yield* Effect.tryPromise(() => readReportPage(reportRoot, ref.path, 0)).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
            if (readable === undefined)
              return yield* refuse(
                `The report ${ref.path} is not a readable report of up to 256 KB in this project.`,
              );
          }
        const member = yield* destination(input.projectId, peer, logical.id);
        if (member === undefined)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({ message: "The destination is no longer linked." }),
          );
        const rows = yield* store.all;
        const runStart =
          threads === undefined
            ? undefined
            : yield* threads.getThreadProjection(input.threadId).pipe(
                Effect.map((projection) => {
                  const run = projection.runs.find((each) => each.id === input.runId);
                  return run === undefined ? undefined : orchestrationV2RunStartMessageId(run);
                }),
                Effect.orElseSucceed(() => undefined),
              );
        // Every message that woke this run, from any machine: a woken turn only answers.
        const wakes = rows.filter(
          (row) =>
            row.direction === "incoming" &&
            row.projectId === input.projectId &&
            (row.wokenRunId === input.runId ||
              row.startedRun?.runId === input.runId ||
              // The wake was recorded before its turn started but the run id was not
              // (a re-wake still holds the earlier turn's id): the run's start message
              // names it; without that lookup, fail closed.
              (row.wakePending !== undefined &&
                row.wakePending.threadId === input.threadId &&
                (runStart === undefined || runStart === row.wakePending.commandId))),
        );
        const waking = wakes.filter((row) => row.kind !== "reply");
        if (wakes.length > 0) {
          const answered = waking.find(
            (row) => row.id === message.replyTo || row.externalId === message.replyTo,
          );
          if (
            message.kind !== "reply" ||
            answered === undefined ||
            answered.peerEnvironmentId !== peer
          )
            return yield* refuse(
              "A turn woken by a coordinator message may only reply to that message, on the machine that sent it.",
            );
        }
        if (message.replyTo !== undefined) {
          const original = rows.find(
            (row) =>
              row.direction === "incoming" &&
              row.projectId === input.projectId &&
              row.peerEnvironmentId === peer &&
              (row.id === message.replyTo || row.externalId === message.replyTo),
          );
          if (original === undefined || original.kind === "reply")
            return yield* refuse(
              "A reply must answer an incoming message that is not itself a reply.",
            );
          if (
            original.state === "revoked" ||
            original.state === "refused" ||
            original.state === "not_delivered" ||
            original.state === "quiet"
          )
            return yield* refuse(
              "That message never reached this coordinator, so it takes no reply.",
            );
          // Only a message admitted under the link as it stands now takes a reply.
          // The message that woke this turn takes one before it settles as delivered.
          const wokeThisTurn = waking.some((row) => row.id === original.id);
          if (
            original.admittedUnder?.membership !== member.membershipStamp ||
            (!wokeThisTurn && !["delivered", "read", "answered"].includes(original.state))
          )
            return yield* refuse(
              "That message arrived under an earlier link, so it takes no reply.",
            );
          message = { ...message, replyTo: original.externalId };
        }
        const externalId = `cm-${sha256([stringifyJson([input.projectId, peer, input.clientRequestId])]).toString("hex")}`;
        const row = {
          externalId,
          direction: "outgoing" as const,
          peerEnvironmentId: peer,
          projectId: input.projectId,
          logicalProjectId: logical.id,
          outgoingMembership: member.membershipStamp,
          clientRequestIds: [input.clientRequestId],
          sourceRunId: input.runId,
          ...message,
          dedupeKey: coordinatorMessageDedupeKey(message, peer),
          count: 1,
          state: "queued" as const,
          receivedAt: 0,
          updatedAt: 0,
        };
        const id = yield* box.enqueue(
          { ...row, id: coordinatorMessageRowId(row) },
          wakes.length > 0,
        );
        // Persist first. A periodic pass retries a destination that is offline now.
        yield* box.flush;
        const result = (yield* store.all).find(
          (record) =>
            record.externalId === id &&
            record.direction === "outgoing" &&
            record.projectId === input.projectId &&
            record.peerEnvironmentId === peer,
        );
        if (result === undefined)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "The outgoing message could not be read.",
            }),
          );
        const refused = result.state === "not_delivered" ? box.refusal(result.id) : undefined;
        if (refused !== undefined)
          return yield* Effect.fail(new CoordinatorMessageOutboxError({ message: refused }));
        return result;
      });
    const read: CoordinatorMessageOutbox["Service"]["read"] = (input) =>
      Effect.gen(function* () {
        if (input.threadId !== `project-coordinator:${input.projectId}`)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "Only this project's coordinator may read a coordinator report.",
            }),
          );
        const rows = yield* store.all;
        // A row id names one peer; an external id only within the peer it came from.
        const byId = rows.find(
          (record) =>
            record.direction === "incoming" &&
            record.projectId === input.projectId &&
            record.id === input.messageId,
        );
        const byExternal = rows.filter(
          (record) =>
            record.direction === "incoming" &&
            record.projectId === input.projectId &&
            record.externalId === input.messageId,
        );
        const row = byId ?? (byExternal.length === 1 ? byExternal[0] : undefined);
        if (
          row === undefined ||
          row.state === "revoked" ||
          row.state === "refused" ||
          row.state === "not_delivered" ||
          !row.refs.some(
            (ref) =>
              ref.kind === "report" &&
              ref.environmentId === row.peerEnvironmentId &&
              ref.path === input.path,
          )
        )
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "The message does not name that report.",
            }),
          );
        const member = yield* destination(
          row.projectId,
          row.peerEnvironmentId,
          row.logicalProjectId,
        );
        if (member === undefined || row.admittedUnder?.membership !== member.membershipStamp)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "This project is no longer linked to that machine.",
            }),
          );
        const page = yield* peers.coordinatorMessageRead(row.peerEnvironmentId, {
          capabilities: [COORDINATOR_MESSAGE_CAPABILITY],
          logicalProjectId: row.logicalProjectId,
          projectId: member.projectId,
          messageId: row.externalId,
          path: input.path,
          offset: input.offset,
        });
        const currentMember = yield* destination(
          row.projectId,
          row.peerEnvironmentId,
          row.logicalProjectId,
        );
        if (currentMember === undefined || currentMember.membershipStamp !== member.membershipStamp)
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({
              message: "The project link changed while the report was read.",
            }),
          );
        if (!page.capabilities.includes(COORDINATOR_MESSAGE_CAPABILITY))
          return yield* Effect.fail(
            new CoordinatorMessageOutboxError({ message: "The report's machine needs an update." }),
          );
        return { content: page.content, offset: page.offset, nextOffset: page.nextOffset };
      });
    return CoordinatorMessageOutbox.of({ send, read, flush: box.flush });
  }),
);

export const layerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* CoordinatorMessageOutbox;
    yield* outbox.flush.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not flush coordinator outbox.", { cause }),
      ),
      Effect.repeat(Schedule.spaced("15 seconds")),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provideMerge(layer), Layer.provide(storeLayer));
