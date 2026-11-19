/**
 * The `coordinator-message` peer path (`/api/handoff/v1/coordinator-message`):
 * one machine's coordinator delivers a message to another machine's
 * coordinator in the same linked project. The receiver admits it
 * (`CoordinatorMessageReceiver`) and answers what became of it. The sender
 * names its capabilities, and the receiver answers with its own, so neither
 * side sends to a machine that does not take messages.
 *
 * The paged ref read and the delivery receipts are the sender's side (T-06)
 * and get their own paths there.
 */
import {
  CoordinatorMessageBody,
  CoordinatorMessageId,
  NonNegativeInt,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const CoordinatorMessageDeliverRequest = Schema.Struct({
  /** What the sending machine supports; a message is admitted only with `coordinator-message.v1`. */
  capabilities: Schema.Array(bounded(64)).check(Schema.isMaxLength(32)),
  logicalProjectId: bounded(512),
  /** The receiver's copy of the project. */
  projectId: ProjectId,
  /** Chosen by the sender and kept across retries. */
  messageId: CoordinatorMessageId,
  /** A retry with the same id delivers one message. */
  clientRequestId: bounded(128).check(Schema.isMinLength(1)),
  message: CoordinatorMessageBody,
});
export type CoordinatorMessageDeliverRequest = typeof CoordinatorMessageDeliverRequest.Type;

/**
 * - `admitted`: stored; the receiver's coordinator reads it after the settle window.
 * - `merged`: a repeat of a message its agent has not read; `messageId` is that message.
 * - `duplicate`: the same `clientRequestId` came before; nothing new.
 * - `held`: the project is paused or archived there; delivered when it resumes.
 * - `folded`: over the hourly cap; delivered in one digest at the hour.
 * - `quiet`: kept and shown there, wakes no model (a reply to a finding).
 */
export const CoordinatorMessageOutcome = Schema.Literals([
  "admitted",
  "merged",
  "duplicate",
  "held",
  "folded",
  "quiet",
]);
export type CoordinatorMessageOutcome = typeof CoordinatorMessageOutcome.Type;

export const CoordinatorMessageDeliverResponse = Schema.Struct({
  capabilities: Schema.Array(bounded(64)).check(Schema.isMaxLength(32)),
  outcome: CoordinatorMessageOutcome,
  messageId: CoordinatorMessageId,
  /** How many sends this message now stands for (merged repeats included). */
  count: NonNegativeInt,
});
export type CoordinatorMessageDeliverResponse = typeof CoordinatorMessageDeliverResponse.Type;
