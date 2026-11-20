import {
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
} from "@specweave-studio/contracts";

import type * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";

/*
 * Failures of work on another machine, in the words an agent can act on. Each step
 * names the machine it is done on (`here` is this machine's name), because the
 * coordinator that relays it may run on a third machine and quotes it exactly.
 */

export const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export const noMachines = (target: string) =>
  failure(
    "unknown_machine",
    `No machine named "${target}". studio_machine_list shows the machines this one can use.`,
  );

const KNOWN_FAILURE_CODES = new Set<string>(
  OrchestratorMcpFailure.fields.code.literals as ReadonlyArray<string>,
);

/** A remote call's error in the words an agent can act on. */
export function remoteFailure(
  machine: Pick<OrchestratorMcpMachineRef, "id" | "label">,
  error: RemoteStudioMcpClient.RemoteMcpError,
  here = "this machine",
): OrchestratorMcpFailure {
  const { label } = machine;
  switch (error.reason) {
    case "unknown_machine":
      return noMachines(machine.id);
    case "not_authorized":
      return failure(
        "machine_not_authorized",
        error.grant === "revoked"
          ? `${label} revoked ${here}'s worker access. If it was revoked under "Who can run work here" there, allow ${here} again on ${label} first. Then, on ${here}, the user opens Settings > Machines and chooses Allow on ${label}'s card, on the line "Agents on … can start work on ${label}".`
          : error.grant === "expired"
            ? `Worker access on ${label} expired. On ${here}, the user opens Settings > Machines and chooses Allow on ${label}'s card, on the line "Agents on … can start work on ${label}".`
            : `Workers are not allowed on ${label} yet. On ${here} (not on ${label}), the user opens Settings > Machines and chooses Allow on ${label}'s card, on the line "Agents on … can start work on ${label}".`,
      );
    case "unreachable":
      return failure("machine_unreachable", `${label} is unavailable right now.`);
    case "identity_mismatch":
      return failure(
        "machine_identity_mismatch",
        `The address configured for ${label} now answers as a different machine; nothing was sent.`,
      );
    case "unsupported":
      return failure(
        "machine_unsupported",
        `${label} needs a newer SpecWithCode for this. Update SpecWithCode on ${label} and try again.`,
      );
    case "refused":
      return failure("capability_denied", "That tool is not available on other machines.");
    case "invalid_response":
      return failure("orchestration_error", `${label} sent an answer ${here} could not read.`);
    case "tool_failure": {
      const code =
        error.remoteCode && KNOWN_FAILURE_CODES.has(error.remoteCode)
          ? (error.remoteCode as OrchestratorMcpFailure["code"])
          : "orchestration_error";
      return failure(code, `${label}: ${error.remoteMessage ?? "the request was refused."}`);
    }
  }
}

export const grantFailure = (
  machine: OrchestratorMcpMachineRef,
  error: FleetWorkerGrants.FleetWorkerGrantError,
  here: string,
) =>
  error.reason === "unknown_machine"
    ? noMachines(machine.id)
    : error.reason === "not_allowed" || error.reason === "revoked" || error.reason === "expired"
      ? remoteFailure(
          machine,
          new RemoteStudioMcpClient.RemoteMcpError({
            reason: "not_authorized",
            grant: error.reason,
          }),
          here,
        )
      : failure("orchestration_error", error.message);
