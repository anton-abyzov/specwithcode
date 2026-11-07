import type { EnvironmentId, OrchestratorMcpIncomingMachine } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as WorkGrants from "./WorkGrants.ts";

/**
 * Machines that run work on this one but that this one may not use: a grant
 * goes one way, so the owner's coordinator can reach this machine while
 * threads here cannot reach it back. Only the user allows the other way, in
 * one click on that machine; these name the click.
 */

/** Used when this machine knows no name for the other one. */
export const UNNAMED_INCOMING_LABEL = "the machine that sends work here";

/** The one step on `there` that lets `here` use it, as the user sees it. */
export const reverseGrantStep = (here: string, there: string) =>
  `On ${there}, open Settings > Machines, find ${here} and choose "Let ${here} use this machine too" (if ${there} lists ${here} as revoked or expired under Who can run work here, allow it again there).`;

/** Why a thread here cannot reach `there` yet, and what to do meanwhile. */
export const reverseGrantMessage = (here: string, there: string) =>
  `${there} runs work on this machine, but this machine may not use ${there} yet. Only the user allows that, in one click: ${reverseGrantStep(here, there)} Until then, end your turn naming what you need from ${there}; its coordinator can send work or files here with studio_thread_launch or studio_file_transfer.`;

/**
 * The coordinators with a live grant here that this machine's own fleet does
 * not list. `configured` holds the environment ids this machine already has a
 * row for: those rows carry their own status and step.
 */
export const incomingMachines = (input: {
  readonly ownEnvironmentId: EnvironmentId;
  readonly hereLabel: string;
  readonly configured: ReadonlySet<string>;
  readonly labels: ReadonlyMap<string, string>;
}) =>
  Effect.gen(function* () {
    const grants = yield* WorkGrants.WorkGrants;
    if (!grants.enabled) return [];
    const policies = yield* grants.policies.pipe(Effect.orElseSucceed(() => []));
    const seen = new Set<string>();
    return policies.flatMap((policy): ReadonlyArray<OrchestratorMcpIncomingMachine> => {
      const id = policy.coordinatorEnvironmentId;
      // Only the owner's own machines: another person's is never told to ask for this one.
      if (policy.revokedAt !== null || policy.owner !== "self" || id === input.ownEnvironmentId)
        return [];
      if (input.configured.has(id) || seen.has(id)) return [];
      seen.add(id);
      const label = input.labels.get(id) ?? UNNAMED_INCOMING_LABEL;
      return [
        {
          label,
          environmentId: id as EnvironmentId,
          status: "needs_reverse_grant",
          allow: reverseGrantStep(input.hereLabel, label),
        },
      ];
    });
  });

/** The incoming machine a name means: its environment id, its name, or a word of its name. */
export const matchIncoming = (
  wanted: string,
  incoming: ReadonlyArray<OrchestratorMcpIncomingMachine>,
) => {
  const lower = wanted.trim().toLowerCase();
  const exact = incoming.filter(
    (machine) => machine.environmentId === wanted.trim() || machine.label.toLowerCase() === lower,
  );
  if (exact.length === 1) return exact[0];
  if (lower.length < 2) return undefined;
  const partial = incoming.filter((machine) =>
    machine.label
      .toLowerCase()
      .split(/[\s’'·-]+/)
      .some((word) => word.startsWith(lower)),
  );
  return partial.length === 1 ? partial[0] : undefined;
};
