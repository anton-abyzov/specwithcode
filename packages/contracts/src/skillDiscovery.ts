import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A file with the same name as a skill, found in a lower-priority folder of
 * the same scan. Display only: nothing says which copy the agent itself uses.
 */
export const ServerProviderSkillCopy = Schema.Struct({
  path: TrimmedNonEmptyString,
  scope: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderSkillCopy = typeof ServerProviderSkillCopy.Type;

/**
 * How the app learned of a skill, when it was not the agent's own report.
 * `folder-scan`: the app scanned the folders this agent reads and found the
 * file; the agent did not report it, so whether the agent lists it for this
 * folder is not known. Absent: the agent's own report, or an older machine.
 */
export const ServerProviderSkillDiscovery = Schema.Literal("folder-scan");
export type ServerProviderSkillDiscovery = typeof ServerProviderSkillDiscovery.Type;
