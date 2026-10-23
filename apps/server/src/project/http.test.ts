import { assert, it } from "@effect/vitest";
import { ProjectId, ProjectEnvironmentError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import {
  ProjectConflictError,
  ProjectNotEmptyError,
  ProjectNotFoundError,
  ProjectOperationError,
  ProjectRequestDeniedError,
  projectMutationErrorMessage,
} from "./ProjectService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { failProjectMutation } from "./http.ts";

const projectId = ProjectId.make("project:http-mutation");

it.effect.each([
  new ProjectNotFoundError({ projectId }),
  new ProjectNotEmptyError({ projectId }),
  new ProjectConflictError({
    projectId,
    workspaceRoot: "/workspace/project",
    conflictingProjectId: ProjectId.make("project:http-mutation-conflict"),
  }),
])("maps expected project mutation failures to invalid requests", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.equal(error._tag, "EnvironmentRequestInvalidError");
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, "invalid_command");
  }),
);

it.effect.each([
  new ProjectOperationError({
    operation: "dispatch-project-command",
    projectId,
    cause: "database unavailable",
  }),
  new ServerRuntimeStartupError({
    mode: "web",
    host: null,
    port: 0,
    cause: "startup unavailable",
  }),
])("keeps operational and startup failures internal", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.equal(error._tag, "EnvironmentInternalError");
    assert.equal(error.code, "internal_error");
    assert.equal(error.reason, "project_mutation_failed");
  }),
);

it.effect.each([
  ["settings_conflict", "project_settings_conflict", "Reload before saving"],
  ["confirmation_required", "project_confirmation_required", "Type the project name exactly"],
  ["active_work", "project_active_work", "Finish or stop active project work"],
  [
    "environment_active",
    "project_environment_active",
    "Stop active project work before removing or changing folder access. Adding a folder works while threads run.",
  ],
] as const)("preserves actionable denial %s across HTTP and RPC", ([reason, httpReason, message]) =>
  Effect.gen(function* () {
    const cause = new ProjectRequestDeniedError({ projectId, reason });
    const failure = yield* failProjectMutation(cause).pipe(Effect.flip);
    assert.equal(failure._tag, "EnvironmentRequestInvalidError");
    assert.equal(failure.reason, httpReason);
    assert.include(failure.message, message);
    assert.include(projectMutationErrorMessage(cause), message);
  }),
);

it("redacts unexpected RPC details while preserving expected not-empty guidance", () => {
  assert.equal(
    projectMutationErrorMessage(
      new ProjectOperationError({
        operation: "dispatch-project-command",
        cause: "sensitive database detail",
      }),
    ),
    "Failed to mutate project.",
  );
  assert.equal(
    projectMutationErrorMessage({
      _tag: "ProjectRequestDeniedError",
      message: "unreviewed arbitrary text",
    }),
    "Failed to mutate project.",
  );
  assert.equal(
    projectMutationErrorMessage(new ProjectNotEmptyError({ projectId })),
    "This project still has threads, and deleting it deletes them too. Confirm the deletion to go ahead.",
  );
});

it.effect("returns safe actionable environment validation across HTTP and RPC", () =>
  Effect.gen(function* () {
    const cause = new ProjectEnvironmentError({ projectId, code: "path_not_approved" });
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);
    assert.equal(error._tag, "EnvironmentRequestInvalidError");
    assert.equal(error.reason, "project_environment_invalid");
    assert.include(error.message, "approved folders");
    assert.include(projectMutationErrorMessage(cause), "approved project folder");
  }),
);
