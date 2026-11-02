import {
  CommandId,
  MachineHandoffBundle,
  MachineHandoffPrepareResult,
  MachineHandoffPreviewMetadata,
  MachineHandoffReceiveResult,
  MessageId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/** What each side of a handoff keeps on disk between its steps. */
export const SourceRecord = Schema.Struct({
  ...MachineHandoffPrepareResult.fields,
  previewDigest: Schema.optional(MachineHandoffBundle.fields.digest),
  /** Every worker with unmerged code at the review, beyond the ones the bundle lists. */
  reviewedUnmerged: Schema.optional(Schema.Array(ThreadId)),
});
const PreparedLaunch = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  workspacePath: Schema.String,
  contextPath: Schema.String,
  prompt: Schema.String,
  verifiedNotes: Schema.optional(Schema.Number),
});
export const DestinationRecord = Schema.Struct({
  digest: MachineHandoffBundle.fields.digest,
  destinationProjectId: ProjectId,
  receipt: Schema.NullOr(MachineHandoffReceiveResult),
  configured: Schema.Boolean,
  metadata: Schema.optional(MachineHandoffPreviewMetadata),
  launch: Schema.optional(PreparedLaunch),
});
export const decodeSourceRecord = Schema.decodeUnknownEffect(SourceRecord);
export const decodeDestinationRecord = Schema.decodeUnknownEffect(DestinationRecord);
