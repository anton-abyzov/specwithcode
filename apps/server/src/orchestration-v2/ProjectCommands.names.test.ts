import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  findProjectNameOwner,
  planProjectCommand,
  encodeProjectCommandRejection,
  decodeProjectCommandRejection,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("unique project names", () => {
  const other = row({ projectId: ProjectId.make("project-other"), title: "SpecWeave" });
  const rename = (title: string, nameOwner: ProjectRow | null = other) =>
    plan(
      { type: "project.meta.update", commandId: CommandId.make("rename"), projectId, title },
      { project: row(), nameOwner: nameOwner ?? undefined },
    );

  it("refuses a name another project has, whatever its case", () => {
    const failure = failureOf(rename("specweave"));
    assert.equal(failure._tag, "ProjectNameTakenError");
    assert.include(failure.message, "already has this name");
    const decoded = Option.getOrThrow(
      decodeProjectCommandRejection(encodeProjectCommandRejection(failure)),
    );
    assert.equal(decoded._tag, "ProjectNameTakenError");
  });

  it("refuses a new name over 120 characters but keeps a long current one", () => {
    const failure = failureOf(rename("x".repeat(121), null));
    assert.equal(failure._tag, "ProjectCommandInvariantError");
    assert.include(failure.message, "at most 120 characters");
    assert.equal(payloadOf(rename("x".repeat(120), null)).title, "x".repeat(120));
    const long = "y".repeat(130);
    assert.equal(
      payloadOf(
        plan(
          {
            type: "project.meta.update",
            commandId: CommandId.make("keep"),
            projectId,
            title: long,
          },
          { project: row({ title: long }) },
        ),
      ).title,
      long,
    );
  });

  it("keeps a free name, the current name and a case change of it", () => {
    assert.equal(payloadOf(rename("Olysense", null)).title, "Olysense");
    assert.equal(payloadOf(rename("Scripts")).title, "Scripts");
    assert.equal(payloadOf(rename("SCRIPTS", null)).title, "SCRIPTS");
  });

  it("finds the owner of a name ignoring case and surrounding space", () => {
    const rows = [
      row(),
      other,
      row({
        projectId: ProjectId.make("gone"),
        title: "Gone",
        deletedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    assert.equal(
      findProjectNameOwner({ rows, projectId, title: "  specweave " })?.projectId,
      other.projectId,
    );
    assert.isUndefined(findProjectNameOwner({ rows, projectId, title: "gone" }));
    assert.isUndefined(findProjectNameOwner({ rows, projectId, title: "scripts" }));
  });

  it("lets checkouts of one project or one repository share its name", () => {
    const identity = { id: "logical:a", title: "SpecWeave", coordinatorId: "c", members: [] };
    const settings = { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: identity };
    const rows = [row({ workspaceSettings: settings }), { ...other, workspaceSettings: settings }];
    assert.isUndefined(findProjectNameOwner({ rows, projectId, title: "specweave" }));
    assert.isUndefined(
      findProjectNameOwner({
        rows: [row(), other],
        projectId,
        title: "specweave",
        sameRepository: () => true,
      }),
    );
  });
});
