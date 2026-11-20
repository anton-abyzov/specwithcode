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

export const COORDINATOR_MESSAGE_OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

export interface CoordinatorMessageOutboxDeps {
  readonly store: CoordinatorMessageStoreShape;
  /** Rechecks current link membership, grant, capabilities and coordinator authority. */
  readonly authorize: (record: CoordinatorMessageRecord) => Effect.Effect<boolean>;
  readonly deliver: (
    record: CoordinatorMessageRecord,
    request: CoordinatorMessageDeliverRequest,
  ) => Effect.Effect<CoordinatorMessageDeliverResponse, unknown>;
  readonly receipt?: (
    record: CoordinatorMessageRecord,
  ) => Effect.Effect<"read" | "not_delivered" | undefined, unknown>;
  /** Resolve the receiver's project from the current link, never a cached project id. */
  readonly receiverProject: (record: CoordinatorMessageRecord) => Effect.Effect<ProjectId>;
}

export const makeOutbox = (deps: CoordinatorMessageOutboxDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
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
            (row.state === "queued" ||
              (row.state === "delivered" && (state === "read" || state === "not_delivered")))
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
    return {
      /** Caller supplies stable ids once. Persist before any network operation. */
      enqueue: (record: CoordinatorMessageRecord) =>
        Effect.gen(function* () {
          const problem = coordinatorMessageProblem(record);
          if (problem !== null) return yield* Effect.fail(new Error(problem.message));
          if (
            record.direction !== "outgoing" ||
            record.state !== "queued" ||
            record.clientRequestIds.length !== 1 ||
            record.clientRequestIds[0]!.trim() === "" ||
            record.id !== coordinatorMessageRowId({ ...record })
          )
            return yield* Effect.fail(
              new Error("An outgoing message needs stable message and request ids."),
            );
          if (!(yield* deps.authorize(record)))
            return yield* Effect.fail(
              new Error("This coordinator may no longer send this message."),
            );
          const now = yield* Clock.currentTimeMillis;
          const result = yield* deps.store.update<string | Error>(now, (rows) => {
            const collision = rows.find((row) => row.id === record.id);
            if (
              collision !== undefined &&
              (collision.clientRequestIds[0] !== record.clientRequestIds[0] ||
                JSON.stringify([
                  collision.kind,
                  collision.subject,
                  collision.text,
                  collision.refs,
                  collision.userStep,
                  collision.replyTo,
                ]) !==
                  JSON.stringify([
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
                result: new Error("A message id cannot be reused for different content."),
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
              JSON.stringify([
                prior.kind,
                prior.subject,
                prior.text,
                prior.refs,
                prior.userStep,
                prior.replyTo,
                prior.logicalProjectId,
              ]) !==
                JSON.stringify([
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
                result: new Error("A request id cannot be reused for different content."),
              };
            return prior === undefined
              ? {
                  records: [...rows, { ...record, receivedAt: now, updatedAt: now }],
                  result: record.externalId,
                }
              : { records: rows, result: prior.externalId };
          });
          if (result instanceof Error) return yield* Effect.fail(result);
          return result;
        }),
      /** Serialized passes prevent reconnect and regular sync from sending concurrently. */
      flush: lock.withPermit(
        Effect.gen(function* () {
          const rows = yield* deps.store.all;
          for (const row of rows) {
            if (row.direction !== "outgoing") continue;
            if (row.state === "delivered" && deps.receipt !== undefined) {
              if (!(yield* deps.authorize(row))) continue;
              const receipt = yield* deps.receipt(row).pipe(Effect.option);
              if (receipt._tag === "Some" && receipt.value !== undefined)
                yield* setState(row.id, receipt.value);
              continue;
            }
            if (row.state !== "queued") continue;
            const now = yield* Clock.currentTimeMillis;
            if (now - row.receivedAt >= COORDINATOR_MESSAGE_OUTBOX_TTL_MS) {
              yield* setState(row.id, "not_delivered");
              continue;
            }
            if (!(yield* deps.authorize(row))) {
              yield* setState(row.id, "not_delivered");
              continue;
            }
            const projectId = yield* deps.receiverProject(row);
            // Resolution may wait on I/O. Recheck authority and the deadline immediately before sending.
            const authorized = yield* deps.authorize(row);
            const sendAt = yield* Clock.currentTimeMillis;
            if (sendAt - row.receivedAt >= COORDINATOR_MESSAGE_OUTBOX_TTL_MS || !authorized) {
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
              .pipe(Effect.option);
            if (
              response._tag === "Some" &&
              response.value.capabilities.includes(COORDINATOR_MESSAGE_CAPABILITY) &&
              (response.value.messageId === row.externalId ||
                response.value.outcome === "merged" ||
                response.value.outcome === "duplicate")
            )
              yield* setState(row.id, "delivered", response.value.messageId);
          }
        }),
      ),
    };
  });

import {
  type CoordinatorMessageBody,
  type EnvironmentId,
  type ThreadId,
  coordinatorMessageDedupeKey,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import { sha256 } from "../nodeCrypto.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HandoffPeers } from "../handoff/handoffPeers.ts";
import { CoordinatorMessageStore, layer as storeLayer } from "./CoordinatorMessageStore.ts";
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
    }) => Effect.Effect<CoordinatorMessageRecord, unknown>;
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly messageId: string;
      readonly path: string;
      readonly offset: number;
    }) => Effect.Effect<
      { readonly content: string; readonly offset: number; readonly nextOffset: number | null },
      unknown
    >;
    readonly flush: Effect.Effect<void, unknown>;
  }
>()("specweave-studio/project/CoordinatorMessageOutbox") {}

export const layer = Layer.effect(
  CoordinatorMessageOutbox,
  Effect.gen(function* () {
    const store = yield* CoordinatorMessageStore;
    const projects = yield* ProjectService;
    const peers = yield* HandoffPeers;
    const self = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
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
        return own.length === 1 && remote.length === 1
          ? {
              ...remote[0]!,
              membershipStamp: JSON.stringify([
                own[0]!.linkId,
                own[0]!.generation,
                remote[0]!.linkId,
                remote[0]!.generation,
              ]),
            }
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
          Effect.orElseSucceed(() => false),
        ),
      receiverProject: (row) =>
        destination(row.projectId, row.peerEnvironmentId, row.logicalProjectId).pipe(
          Effect.flatMap((member) =>
            member === undefined
              ? Effect.fail(new Error("The project is no longer linked."))
              : Effect.succeed(member.projectId),
          ),
          Effect.orDie,
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
          if (
            receipt.state === "revoked" ||
            receipt.state === "refused" ||
            receipt.state === "not_delivered"
          )
            return "not_delivered" as const;
          return undefined;
        }),
    });
    const send: CoordinatorMessageOutbox["Service"]["send"] = (input) =>
      Effect.gen(function* () {
        if (input.threadId !== `project-coordinator:${input.projectId}`)
          return yield* Effect.fail(
            new Error("Only this project's coordinator may send a coordinator message."),
          );
        if (!input.clientRequestId.trim() || input.clientRequestId.length > 128)
          return yield* Effect.fail(new Error("clientRequestId must contain 1 to 128 characters."));
        const target = (yield* peers.targets).filter(
          (item) =>
            item.machineId === input.machine ||
            item.environmentId === input.machine ||
            item.label === input.machine,
        );
        if (target.length !== 1)
          return yield* Effect.fail(new Error("Name one linked machine unambiguously."));
        const project = yield* projects.getById(input.projectId);
        const logical = Option.isSome(project)
          ? project.value.workspaceSettings?.logicalProject
          : undefined;
        if (logical === undefined)
          return yield* Effect.fail(new Error("Coordinator messages require a linked project."));
        const peer = target[0]!.environmentId;
        let message = input.message;
        const rows = yield* store.all;
        const wakes = rows.filter(
          (row) =>
            row.direction === "incoming" &&
            row.projectId === input.projectId &&
            row.peerEnvironmentId === peer &&
            input.runId !== null &&
            (row.wokenRunId === input.runId || row.startedRun?.runId === input.runId),
        );
        if (
          wakes.length > 0 &&
          (message.kind !== "reply" ||
            !wakes.some(
              (row) =>
                row.kind !== "reply" &&
                (row.id === message.replyTo || row.externalId === message.replyTo),
            ))
        )
          return yield* Effect.fail(
            new Error(
              "A turn woken by this machine may only reply to its incoming non-reply message.",
            ),
          );
        if (message.replyTo !== undefined) {
          const original = rows.find(
            (row) =>
              row.direction === "incoming" &&
              row.projectId === input.projectId &&
              row.peerEnvironmentId === peer &&
              (row.id === message.replyTo || row.externalId === message.replyTo),
          );
          if (original === undefined || original.kind === "reply")
            return yield* Effect.fail(
              new Error("A reply must answer an incoming message that is not itself a reply."),
            );
          message = { ...message, replyTo: original.externalId };
        }
        const member = yield* destination(input.projectId, peer, logical.id);
        if (member === undefined)
          return yield* Effect.fail(new Error("The destination is no longer linked."));
        const externalId = `cm-${sha256([JSON.stringify([input.projectId, peer, input.clientRequestId])]).toString("hex")}`;
        const row = {
          externalId,
          direction: "outgoing" as const,
          peerEnvironmentId: peer,
          projectId: input.projectId,
          logicalProjectId: logical.id,
          outgoingMembership: member.membershipStamp,
          clientRequestIds: [input.clientRequestId],
          ...message,
          dedupeKey: coordinatorMessageDedupeKey(message, peer),
          count: 1,
          state: "queued" as const,
          receivedAt: 0,
          updatedAt: 0,
        };
        const id = yield* box.enqueue({ ...row, id: coordinatorMessageRowId(row) });
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
          return yield* Effect.fail(new Error("The outgoing message could not be read."));
        return result;
      });
    const read: CoordinatorMessageOutbox["Service"]["read"] = (input) =>
      Effect.gen(function* () {
        if (input.threadId !== `project-coordinator:${input.projectId}`)
          return yield* Effect.fail(
            new Error("Only this project's coordinator may read a coordinator report."),
          );
        const row = (yield* store.all).find(
          (record) =>
            record.direction === "incoming" &&
            record.projectId === input.projectId &&
            (record.id === input.messageId || record.externalId === input.messageId),
        );
        if (
          row === undefined ||
          !row.refs.some(
            (ref) =>
              ref.kind === "report" &&
              ref.environmentId === row.peerEnvironmentId &&
              ref.path === input.path,
          )
        )
          return yield* Effect.fail(new Error("The message does not name that report."));
        const member = yield* destination(
          row.projectId,
          row.peerEnvironmentId,
          row.logicalProjectId,
        );
        if (member === undefined)
          return yield* Effect.fail(new Error("This project is no longer linked to that machine."));
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
            new Error("The project link changed while the report was read."),
          );
        if (!page.capabilities.includes(COORDINATOR_MESSAGE_CAPABILITY))
          return yield* Effect.fail(new Error("The report's machine needs an update."));
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
