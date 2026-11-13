import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Personal data on a machine (the owner's mail, calendar and files) is its own
 * permission. A machine link, a work grant and a project's own Google switch
 * never imply it: the owner names the other machine and the source, on the
 * machine that holds the data. The assistant's chats, memory and routines are
 * not a source: they stay private to their machine.
 */
export const PersonalDataSource = Schema.Literals(["gmail", "calendar", "drive"]);
export type PersonalDataSource = typeof PersonalDataSource.Type;

export const PERSONAL_DATA_SOURCES: ReadonlyArray<PersonalDataSource> = [
  "gmail",
  "calendar",
  "drive",
];

export const PERSONAL_DATA_SOURCE_LABELS: Readonly<Record<PersonalDataSource, string>> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
};

/** What one other machine's work may read here. */
export const PersonalDataMachineAccess = Schema.Struct({
  environmentId: EnvironmentId,
  /** The machine's name as this machine knows it. */
  label: TrimmedNonEmptyString,
  /** The owner's own machine: its work acts as the owner and needs no grant. */
  ownMachine: Schema.Boolean,
  sources: Schema.Array(PersonalDataSource),
  /** Sources its work asked for and was refused, waiting for the owner. */
  requested: Schema.Array(PersonalDataSource),
});
export type PersonalDataMachineAccess = typeof PersonalDataMachineAccess.Type;

export const PersonalDataLogAction = Schema.Literals([
  "granted",
  "revoked",
  "refused",
  "used",
  "dismissed",
]);
export type PersonalDataLogAction = typeof PersonalDataLogAction.Type;

export const PersonalDataLogEntry = Schema.Struct({
  at: Schema.String,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  source: PersonalDataSource,
  action: PersonalDataLogAction,
  /** The tool that read, for "used" and "refused". */
  tool: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalDataLogEntry = typeof PersonalDataLogEntry.Type;

export const PersonalDataAccessStatus = Schema.Struct({
  machines: Schema.Array(PersonalDataMachineAccess),
  /** Newest first. */
  log: Schema.Array(PersonalDataLogEntry),
});
export type PersonalDataAccessStatus = typeof PersonalDataAccessStatus.Type;

export const PersonalDataSetAccessInput = Schema.Struct({
  environmentId: EnvironmentId,
  source: PersonalDataSource,
  /** `dismiss` clears a pending request and leaves the source off. */
  change: Schema.Literals(["allow", "revoke", "dismiss"]),
});
export type PersonalDataSetAccessInput = typeof PersonalDataSetAccessInput.Type;

export class PersonalDataAccessError extends Schema.TaggedError<PersonalDataAccessError>()(
  "PersonalDataAccessError",
  {
    reason: Schema.Literals(["save_failed", "unknown_machine"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "unknown_machine"
      ? "That machine may not run work here, so there is nothing to allow."
      : "Could not save the change.";
  }
}

/** What a refused agent is told: who, what, and where the owner allows it. */
export const personalDataRefusalMessage = (input: {
  readonly machine: string;
  readonly source: PersonalDataSource;
}): string =>
  `${PERSONAL_DATA_SOURCE_LABELS[input.source]} on this machine is personal data. Work started from ${input.machine} cannot read it until this machine's owner allows it under Settings > Google > Other machines. The request is now listed there.`;
