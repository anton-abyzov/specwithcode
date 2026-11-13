/**
 * The check Google tools make before reading the owner's mail, calendar or
 * files for work another machine started here.
 *
 * @module personalDataGate
 */
import {
  OrchestratorMcpFailure,
  type PersonalDataSource,
  personalDataRefusalMessage,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import * as PersonalDataAccess from "./PersonalDataAccess.ts";

/** Gmail drafts and sends are mail too. */
export function personalDataSourceOfTool(tool: string): PersonalDataSource | undefined {
  if (tool.startsWith("studio_google_gmail_")) return "gmail";
  if (tool.startsWith("studio_google_calendar_")) return "calendar";
  if (tool.startsWith("studio_google_drive_")) return "drive";
  return undefined;
}

/**
 * The owner's own machines act as the owner: a grant that is `own`, or kept
 * from before grants existed. Any other machine needs the source allowed.
 */
export const actsAsOwner = (grant: Pick<EffectiveWorkGrant, "kind" | "legacy">) =>
  grant.kind === "own" || grant.legacy === true;

export interface PersonalDataCaller {
  readonly grant: Pick<EffectiveWorkGrant, "coordinatorEnvironmentId" | "kind" | "legacy">;
  readonly coordinatorLabel: string;
}

/**
 * Passes for the owner's own threads (no work grant) and the owner's own
 * machines; otherwise the calling machine must hold the source. A refusal is
 * left as a request in the owner's Settings.
 */
export const requirePersonalData = Effect.fn("personalData.require")(function* (
  work: PersonalDataCaller | undefined,
  tool: string,
) {
  const source = personalDataSourceOfTool(tool);
  if (work === undefined || source === undefined) return;
  const access = yield* PersonalDataAccess.PersonalDataAccess;
  const machine = {
    environmentId: work.grant.coordinatorEnvironmentId,
    label: work.coordinatorLabel,
    source,
    tool,
  };
  if (actsAsOwner(work.grant)) return yield* access.noteUse(machine);
  if (yield* access.check(machine)) return;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: personalDataRefusalMessage({ machine: work.coordinatorLabel, source }),
  });
});
