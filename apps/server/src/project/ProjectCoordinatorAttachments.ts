// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import {
  MessageId,
  ProjectWorkspaceError,
  type ProjectCoordinatorSendInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import type { ThreadManagementSendInput } from "../orchestration-v2/ThreadManagementService.ts";

/** Text-only IDs remain compatible with project messages accepted before uploads were supported. */
export function messageId(input: ProjectCoordinatorSendInput): MessageId {
  const prefix = `coordinator-send:${input.projectId}:${input.commandId}`;
  if (!input.attachments?.length) return MessageId.make(prefix);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        input.prompt,
        input.sourceThreadId ?? null,
        input.attachments.map((a) => [
          a.id,
          a.type,
          a.name,
          a.mimeType,
          a.sizeBytes,
          "source" in a ? (a.source ?? null) : null,
        ]),
      ]),
    )
    .digest("hex");
  return MessageId.make(`${prefix}:${fingerprint}`);
}

export const validate = Effect.fn("ProjectCoordinatorAttachments.validate")(function* (
  input: ProjectCoordinatorSendInput,
) {
  const attachments = input.attachments ?? [];
  // Uploads must come through native staging. A claimed ID is not proof that the user
  // can reuse another project's captured bytes, even if its path exists on this host.
  if (
    (!input.prompt.trim() && attachments.length === 0) ||
    attachments.some(
      (a) =>
        (a.type !== "image" && a.type !== "file") || !AttachmentClaims.attachmentIsPendingUpload(a),
    ) ||
    new Set(attachments.map((a) => a.id)).size !== attachments.length
  ) {
    return yield* new ProjectWorkspaceError({ projectId: input.projectId, code: "invalid" });
  }
  yield* AttachmentClaims.validateAttachmentLimits(attachments);
});

/** Read the durable command before touching uploads: their staging TTL may have elapsed. */
export const send = Effect.fn("ProjectCoordinatorAttachments.send")(function* (
  input: ThreadManagementSendInput,
) {
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* sink
    .readByCommandId({ commandId: input.commandId })
    .pipe(Stream.runCollect);
  if (events.length > 0) {
    const accepted = events.find(
      ({ event }) =>
        event.type === "message.updated" &&
        event.threadId === input.threadId &&
        event.payload.id === input.messageId &&
        event.payload.threadId === input.threadId &&
        event.payload.text === input.text &&
        event.payload.senderThreadId === input.senderThreadId &&
        event.payload.createdBy === "user",
    );
    if (!accepted) {
      return yield* new ProjectWorkspaceError({ projectId: input.projectId, code: "conflict" });
    }
    return;
  }
  // Intake validates bytes and type, copies under the coordinator's namespace, and
  // releases unreferenced copies after proven rejection. Unknown outcomes retain them.
  yield* ThreadMessageIntake.sendToThread(input);
});
