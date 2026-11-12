import type { CopyErrorCode, DestinationRecord } from "./destinationService.ts";

// What a destination copy tells people about its source machine.

/** The source machine as the person knows it, for "cancel it there" advice. */
export const sourceName = (record: DestinationRecord) =>
  record.sourceMachine || "the source machine";

export function appliedButRefusedMessage(record: DestinationRecord) {
  const name = sourceName(record);
  return `${name} no longer accepts this copy, so it cannot be finished. The files are in place here. Undo the copy here, then cancel it on ${name}${record.mode === "copy-and-move" ? " to give the project back there" : ""}.`;
}

export function alreadyCommittedMessage(record: DestinationRecord) {
  const name = sourceName(record);
  return record.mode === "copy-and-move"
    ? `${name} had already finished this move, so the project now lives on this machine. Nothing was removed; the copy is being finished here.`
    : `${name} had already finished this copy. Nothing was removed; the copy is being finished here.`;
}

export function undoneButHeldMessage(record: DestinationRecord, code: CopyErrorCode) {
  const name = sourceName(record);
  const reason =
    code === "unauthorized" ? `${name} no longer accepts this copy` : `${name} could not be told`;
  return `The files here were restored, but ${reason}, so the copy is still open there. Cancel the copy on ${name}${record.mode === "copy-and-move" ? " to give the project back there" : " to end it"}.`;
}

/**
 * The source refused this copy's grant. It expired, was cancelled or replaced
 * there, or the source's saved offer was removed (a disk cleanup that moved the
 * app's data folder did this once). Starting again mints a fresh offer.
 */
export function staleOfferMessage(record: DestinationRecord) {
  const name = sourceName(record);
  const action = record.mode === "copy-and-move" ? "move" : "copy";
  return `${name} no longer accepts this ${action} (prepared ${record.createdAt.slice(0, 10)}): its offer expired, was cancelled or replaced there, or was removed from ${name}. Start the ${action} again from ${name}.`;
}
