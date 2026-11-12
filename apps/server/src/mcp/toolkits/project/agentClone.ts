import {
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

/**
 * How long a clone another machine's agent asked for may run here. The caller
 * (studio_project_add_to_machine) waits this long plus a margin for the answer,
 * so this side's own deadline always reports first.
 */
export const AGENT_CLONE_TIMEOUT_MS = 10 * 60 * 1_000;

/** studio_project_clone's parameters: a clone, and whether to take an earlier one at that path. */
export const AgentCloneInput = Schema.Struct({
  ...SourceControlCloneRepositoryInput.fields,
  resumeExisting: Schema.optional(Schema.Boolean).annotate({
    description:
      "True when an earlier clone to destinationPath finished but registering it failed: a clean clone of the same repository there is used as it is instead of cloning again. A folder holding another repository, local changes or other files is still refused.",
  }),
});
export type AgentCloneInput = typeof AgentCloneInput.Type;

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

/** Why the folder at a clone's destination cannot be used as that clone, or null when it can. */
const resumeRefusal = (
  found: SourceControlInspectDestinationResult,
  dirty: boolean,
): string | null => {
  if (found.state !== "repository")
    return `${found.path} holds files that are not a clone of this repository, so nothing was cloned there.`;
  if (!found.sameRepository)
    return `${found.path} holds another repository, so nothing was cloned there. Pass another destinationPath.`;
  if (!found.checkedOut)
    return `The earlier clone at ${found.path} did not finish checking out. Remove that folder there, then call again.`;
  if (dirty)
    return `${found.path} has local changes, so it was left as it is. Commit or remove them there, or pass another destinationPath.`;
  return null;
};

const seconds = (millis: number) => `${Math.round(millis / 1_000)} seconds`;

/**
 * The clone behind studio_project_clone. It runs up to AGENT_CLONE_TIMEOUT_MS
 * and removes what a failed clone left in a destination that was missing or
 * empty before; with resumeExisting, a clean clone of the same repository
 * already at the destination is returned instead of cloning again.
 */
export const agentClone = Effect.fn("mcp.agentClone")(function* (input: AgentCloneInput) {
  const repositories = yield* Repositories.SourceControlRepositoryService;
  const { resumeExisting, ...clone } = input;
  const before = yield* repositories
    .inspectDestination({
      path: clone.destinationPath,
      ...(clone.remoteUrl === undefined ? {} : { remoteUrl: clone.remoteUrl }),
    })
    .pipe(Effect.option, Effect.map(Option.getOrUndefined));
  if (
    resumeExisting === true &&
    before !== undefined &&
    before.state !== "missing" &&
    before.state !== "empty"
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const dirty =
      before.state === "repository" && before.sameRepository && before.checkedOut
        ? yield* git.statusDetailsLocal(before.path, { includeDivergence: false }).pipe(
            Effect.map((status) => !status.isRepo || status.hasWorkingTreeChanges),
            Effect.orElseSucceed(() => true),
          )
        : false;
    const refused = resumeRefusal(before, dirty);
    if (refused !== null || clone.remoteUrl === undefined)
      return yield* failure(refused ?? "Pass remoteUrl to use an earlier clone.");
    return { cwd: before.path, remoteUrl: clone.remoteUrl, repository: null };
  }
  const started = yield* Clock.currentTimeMillis;
  return yield* repositories.cloneRepository(clone, { timeoutMs: AGENT_CLONE_TIMEOUT_MS }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        // Only a destination that held nothing is emptied again; any other refusal
        // (it was not empty) leaves what is there untouched.
        const cleaned =
          before !== undefined && (before.state === "missing" || before.state === "empty")
            ? yield* repositories
                .discardClone(clone.destinationPath, {
                  removeDestination: before.state === "missing",
                })
                .pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                )
            : false;
        const cause = error.cause as { readonly detail?: unknown } | undefined;
        const timedOut =
          cause?.detail === "Git command timed out." || elapsed >= AGENT_CLONE_TIMEOUT_MS;
        if (!timedOut) return yield* failure(error.detail);
        return yield* failure(
          `The clone stopped after ${seconds(elapsed)}: it may take ${seconds(AGENT_CLONE_TIMEOUT_MS)} at most.${cleaned ? ` Its partial folder at ${before?.path ?? clone.destinationPath} was removed.` : ""} Ask the user to clone it on this machine and add that folder as a project, then call studio_project_add_to_machine again: it links the copy it finds.`,
        );
      }),
    ),
  );
});
