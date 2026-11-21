/**
 * `projects.coordinatorMessages`: the kept messages between this project's
 * coordinators, for the conversation's cards. Registered apart from ws.ts
 * (see `WsCoordinatorMessagesRpcGroup`).
 *
 * @module project/CoordinatorMessageRpc
 */
import {
  type CoordinatorMessageView,
  type ProjectCoordinatorMessagesInput,
  ProjectWorkspaceError,
  WS_METHODS,
  WsCoordinatorMessagesRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import {
  type CoordinatorMessageRecord,
  CoordinatorMessageStore,
  layer as storeLayer,
} from "./CoordinatorMessageStore.ts";

/** What a window may see of a kept message: no admission or wake bookkeeping. */
export const toCoordinatorMessageView = (
  record: CoordinatorMessageRecord,
): CoordinatorMessageView => ({
  id: record.id,
  externalId: record.externalId,
  direction: record.direction,
  ...(record.receiverMessageId === undefined
    ? {}
    : { receiverMessageId: record.receiverMessageId }),
  peerEnvironmentId: record.peerEnvironmentId,
  kind: record.kind,
  subject: record.subject,
  text: record.text,
  ...(record.userStep === undefined ? {} : { userStep: record.userStep }),
  refs: record.refs,
  ...(record.replyTo === undefined ? {} : { replyTo: record.replyTo }),
  count: record.count,
  state: record.state,
  receivedAt: record.receivedAt,
  updatedAt: record.updatedAt,
  ...(record.sourceRunId === undefined ? {} : { sourceRunId: record.sourceRunId }),
  ...(record.wokenRunId === undefined ? {} : { wokenRunId: record.wokenRunId }),
});

export const listCoordinatorMessages = (input: ProjectCoordinatorMessagesInput) =>
  Effect.gen(function* () {
    const rows = yield* (yield* CoordinatorMessageStore).all;
    return {
      messages: rows
        // A refused message never reached the conversation.
        .filter((row) => row.projectId === input.projectId && row.state !== "refused")
        .toSorted((a, b) => a.receivedAt - b.receivedAt)
        .map(toCoordinatorMessageView),
    };
  }).pipe(
    Effect.mapError(
      () => new ProjectWorkspaceError({ code: "operation_failed", projectId: input.projectId }),
    ),
  );

export const layerRpcHandlers = WsCoordinatorMessagesRpcGroup.middleware(RpcInstrumentation)
  .toLayer(
    Effect.succeed({
      [WS_METHODS.projectsCoordinatorMessages]: listCoordinatorMessages,
    }),
    // The same layer value the outbox and receiver use, so one instance and one lock.
  )
  .pipe(Layer.provide(storeLayer));
