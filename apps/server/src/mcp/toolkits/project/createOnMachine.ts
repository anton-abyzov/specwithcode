/**
 * studio_project_create with `machine`: the project is made on that fleet
 * machine by its own studio_project_create, with its own folders and Git, and
 * lives there only. That machine applies its grant checks; this side checks who may ask and that the machine is new enough to
 * honour parentPath, which an older one would silently drop. Publishing to
 * GitHub stays with that machine's user.
 *
 * @module createOnMachine
 */
import {
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
  Project,
  ProjectCreateToolResultFields,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { readCaller } from "../../threadAccess.ts";
import { workGrantOf } from "../../workGrantAccess.ts";
import { fleetPrincipalOf } from "../orchestrator/remote.ts";

// Making the folder, the first commit and a GitHub publish there.
const CREATE_TIMEOUT_MS = 3 * 60 * 1_000;

const CreatedThere = Schema.Struct({ ...Project.fields, ...ProjectCreateToolResultFields });
const decodeCreated = Schema.decodeUnknownEffect(CreatedThere);

const SupportsCreateOptions = Schema.Struct({
  features: Schema.Struct({ projectCreateOptions: Schema.Literal(true) }),
});
const decodeSupport = Schema.decodeUnknownOption(SupportsCreateOptions);

/** Publishing uses that machine's own GitHub sign-in, which a work grant does not cover. */
export const GRANT_GITHUB_MESSAGE =
  "Publishing to GitHub uses this machine's own GitHub sign-in, so only its user does it. Create the project without github, then ask the user on this machine to publish it.";

/** The words for a machine whose SpecWithCode predates these options. */
export const olderMachineMessage = (label: string) =>
  `${label} runs an older SpecWithCode that cannot create a project with a machine or parent folder. Update SpecWithCode on ${label}, then try again.`;

/** Which machine `machine` names: this one ("local", its own id or label) or another. */
export const resolveCreateMachine = Effect.fn("mcp.createOnMachine.resolve")(function* (
  machine: string,
) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  return yield* remote.resolveMachine(machine);
});

/**
 * Creates the project on `machine` and says how to start work there. The
 * project there has its own coordinator and is not linked to anything here,
 * since there is no copy here; launching with machineProjectId needs no add
 * or link step.
 */
export const createProjectOnMachine = Effect.fn("mcp.createProjectOnMachine")(function* (input: {
  readonly machine: OrchestratorMcpMachineRef;
  readonly arguments: Record<string, unknown>;
}) {
  const { machine } = input;
  const context = yield* readCaller();
  yield* fleetPrincipalOf(context, "act");
  if ((yield* workGrantOf(context)) !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Work another machine started here cannot create projects on other machines. Ask the user on the machine the work came from.",
    });
  // The other machine refuses github for work it did not start; say so before asking it.
  const github = input.arguments.github;
  if (github !== undefined && github !== false)
    return yield* new OrchestratorMcpFailure({
      code: "outside_grant_scope",
      message: `${machine.label}: ${GRANT_GITHUB_MESSAGE}`,
    });
  const remote = yield* RemoteWorkers.RemoteWorkers;
  // An older machine ignores parentPath and would put the project in
  // its own storage, so it must say it supports them first.
  const capabilities = yield* remote.proxy({
    machine,
    tool: "orchestrator_capabilities",
    arguments: {},
  });
  if (Option.isNone(decodeSupport(capabilities)))
    return yield* new OrchestratorMcpFailure({
      code: "machine_unsupported",
      message: olderMachineMessage(machine.label),
    });
  const answer = yield* remote
    .proxy({
      machine,
      tool: "studio_project_create",
      arguments: input.arguments,
      timeoutMs: CREATE_TIMEOUT_MS,
    })
    .pipe(
      Effect.mapError((error) =>
        error.code === "machine_unsupported"
          ? new OrchestratorMcpFailure({
              code: error.code,
              message: olderMachineMessage(machine.label),
            })
          : error,
      ),
    );
  const created = yield* decodeCreated(answer).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${machine.label} created the project but sent an answer this machine could not read. studio_machine_list shows its projects there.`,
        }),
    ),
  );
  return {
    ...created,
    machine,
    next: `The project is on ${machine.label} only. Start work there with studio_thread_launch {machine:"${machine.label}", machineProjectId:"${created.id}"}.`,
  };
});
