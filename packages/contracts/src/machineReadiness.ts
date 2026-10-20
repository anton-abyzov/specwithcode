import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

/**
 * What a machine still needs before a project runs there: GitHub sign-in, read
 * access to each repository's origin with this machine's own credentials, and
 * the tools the project's actions call. Provider sign-ins come from the
 * machine's provider list; no credential value is ever part of this report.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const MachineReadinessInput = Schema.Struct({
  /** Checks this project's repositories and actions too; without it, only the machine. */
  projectId: Schema.optional(ProjectId),
});
export type MachineReadinessInput = typeof MachineReadinessInput.Type;

export const MachineReadinessGitHub = Schema.Struct({
  status: Schema.Literals(["signed-in", "signed-out", "not-installed", "unknown"]),
  accounts: Schema.Array(Schema.Struct({ host: bounded(255), login: bounded(255) })),
  detail: Schema.NullOr(bounded(1000)),
});
export type MachineReadinessGitHub = typeof MachineReadinessGitHub.Type;

export const MachineReadinessRepository = Schema.Struct({
  path: bounded(4096),
  /** The origin URL with any embedded credentials removed. */
  origin: Schema.NullOr(bounded(2048)),
  status: Schema.Literals(["ok", "no-origin", "no-access", "timeout", "error"]),
  detail: Schema.NullOr(bounded(1000)),
});
export type MachineReadinessRepository = typeof MachineReadinessRepository.Type;

export const MachineReadinessTool = Schema.Struct({
  name: bounded(200),
  /** The project action that calls it. */
  action: bounded(200),
  found: Schema.Boolean,
});
export type MachineReadinessTool = typeof MachineReadinessTool.Type;

export const MachineReadiness = Schema.Struct({
  checkedAt: bounded(64),
  folder: Schema.NullOr(bounded(4096)),
  github: MachineReadinessGitHub,
  repositories: Schema.Array(MachineReadinessRepository),
  /** More repositories were found than were checked. */
  repositoriesTruncated: Schema.Boolean,
  tools: Schema.Array(MachineReadinessTool),
});
export type MachineReadiness = typeof MachineReadiness.Type;
