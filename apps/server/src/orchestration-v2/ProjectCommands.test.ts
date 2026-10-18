import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type ProjectWorkspacePatch,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectScript,
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

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const update = (
  fields: Omit<
    Extract<ProjectCommand, { type: "project.meta.update" }>,
    "type" | "commandId" | "projectId"
  >,
) =>
  plan(
    {
      type: "project.meta.update",
      commandId: CommandId.make("cmd-update"),
      projectId,
      ...fields,
    },
    { project: row() },
  );

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("creates projects with empty scripts and no model default", () => {
    const result = plan({
      type: "project.create",
      commandId: CommandId.make("cmd-create"),
      projectId,
      title: "Scripts",
      workspaceRoot: "/tmp/scripts",
    });
    const event = Result.getOrThrow(result);
    assert.equal(event.type, "project.created");
    assert.equal(event.occurredAt, "2026-01-01T00:00:00.000Z");
    assert.deepInclude(event.payload, { scripts: [], defaultModelSelection: null });
  });

  it("records explicit model defaults through metadata updates", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    assert.deepEqual(
      payloadOf(update({ defaultModelSelection: selection })).defaultModelSelection,
      selection,
    );
  });

  it("carries an internal worker seed, including options, in the creation event", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    for (const initialWorkerModelSelection of [selection, null]) {
      const event = Result.getOrThrow(
        plan({
          type: "project.create",
          commandId: CommandId.make("cmd-create-internal-worker"),
          projectId,
          title: "Handoff",
          workspaceRoot: "/tmp/handoff",
          initialWorkerModelSelection,
        }),
      );
      assert.equal(event.type, "project.created");
      if (event.type !== "project.created") assert.fail("Expected the creation event");
      assert.deepEqual(event.payload.defaultModelSelection, initialWorkerModelSelection);
    }
  });

  it("carries every edited field and omits the rest", () => {
    const scripts = [script("lint")];
    const payload = payloadOf(
      update({
        scripts,
        defaultThreadEnvMode: "worktree",
        autoPull: true,
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );
    assert.deepInclude(payload, {
      scripts,
      defaultThreadEnvMode: "worktree",
      autoPull: true,
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    });
    const renamed = payloadOf(update({ title: "Renamed" }));
    assert.isFalse("defaultThreadEnvMode" in renamed);
    assert.isNull(payloadOf(update({ defaultThreadEnvMode: null })).defaultThreadEnvMode);
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)])(
    "rejects a new script ID that cannot have a shortcut: %s",
    (id) => {
      const failure = failureOf(update({ scripts: [script("lint"), script(id)] }));
      assert.equal(failure._tag, "ProjectCommandInvariantError");
      assert.include(failure.message, "Script ID");
      assert.include(failure.message, "24");
      // The detail is persisted in the rejected receipt, so it omits the raw ID.
      assert.notInclude(failure.message, `'${id}'`);
    },
  );

  it("accepts a script ID at the shortcut length limit", () => {
    const scripts = [script("a".repeat(24))];
    assert.deepEqual(payloadOf(update({ scripts })).scripts, scripts);
  });

  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("limits monograms to two graphemes", () => {
    for (const text of ["SW", "é", "किखि", "क्ष्म", "각"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      assert.deepEqual(payloadOf(update({ projectIcon: monogram })).projectIcon, monogram);
    }
    for (const text of ["Studio", "ABC", "किखिगि"]) {
      assert.equal(
        failureOf(update({ projectIcon: { kind: "monogram", text, color: "violet" } }))._tag,
        "ProjectCommandInvariantError",
      );
    }
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });

  it("deletes with a single project.deleted event", () => {
    const event = Result.getOrThrow(
      plan(
        { type: "project.delete", commandId: CommandId.make("cmd-delete"), projectId },
        { project: row() },
      ),
    );
    assert.equal(event.type, "project.deleted");
    assert.deepEqual(event.payload, { projectId, deletedAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("project settings revision rejection", () => {
  it("retains a typed safe conflict through durable receipt encoding", () => {
    const failure = failureOf(
      update({ workspaceSettings: { expectedRevision: 2, goal: "private draft" } }),
    );
    assert.equal(failure._tag, "ProjectSettingsRevisionConflictError");
    if (failure._tag !== "ProjectSettingsRevisionConflictError")
      return assert.fail("Expected revision conflict");
    assert.equal(failure.expectedRevision, 2);
    assert.equal(failure.actualRevision, 0);
    const encoded = encodeProjectCommandRejection(failure);
    assert.notInclude(encoded, "private draft");
    const decoded = Option.getOrThrow(decodeProjectCommandRejection(encoded));
    assert.equal(decoded._tag, "ProjectSettingsRevisionConflictError");
    assert.include(decoded.message, "Reload before saving");
  });
});

describe("durable logical coordinator ownership", () => {
  const logicalProject = {
    id: "logical:source",
    title: "Project",
    coordinatorId: "coordinator:source",
    members: [],
  };
  const coordinatorBinding = { epoch: 2, state: "transferring" as const, operationId: "transfer" };
  const settings = {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    revision: 7,
    logicalProject,
    coordinatorBinding,
  };
  const command = {
    type: "project.meta.update" as const,
    commandId: CommandId.make("ownership"),
    projectId,
  };
  it("preserves the fence through unpause and forged public metadata", () => {
    const event = payloadOf(
      plan(
        {
          ...command,
          workspaceSettings: {
            expectedRevision: 7,
            paused: false,
            logicalProject: { ...logicalProject, id: "forged" },
            coordinatorBinding: { epoch: 9, state: "active" },
          } as ProjectWorkspacePatch,
        },
        { project: row({ workspaceSettings: settings }) },
      ),
    );
    assert.deepInclude(event.workspaceSettings, {
      logicalProject,
      coordinatorBinding,
      revision: 8,
      paused: false,
    });
  });
  it("renames the active domain identity while retaining immutable membership", () => {
    const event = payloadOf(
      plan(
        { ...command, title: "Renamed" },
        {
          project: row({
            workspaceSettings: {
              ...settings,
              coordinatorBinding: { epoch: 2, state: "active" },
            },
          }),
        },
      ),
    );
    assert.deepInclude(event.workspaceSettings, {
      logicalProject: { ...logicalProject, title: "Renamed" },
    });
    const historical = payloadOf(
      plan({ ...command, title: "Old history" }, { project: row({ workspaceSettings: settings }) }),
    );
    assert.isUndefined(historical.workspaceSettings);
  });
  it("rejects stale revisions, epoch jumps and fence resets", () => {
    for (const patch of [
      { expectedRevision: 6 },
      { coordinatorBinding: { ...coordinatorBinding, epoch: 3 } },
      { coordinatorBinding: { ...coordinatorBinding, state: "active" as const } },
      { coordinatorBinding: { ...coordinatorBinding, operationId: "other" } },
    ]) {
      failureOf(
        plan(
          {
            ...command,
            ownership: { expectedRevision: 7, logicalProject, coordinatorBinding, ...patch },
          },
          { project: row({ workspaceSettings: settings }) },
        ),
      );
    }
  });
  it("reactivates a saved folder only for a verified newer incoming transfer", () => {
    const predecessor = {
      environmentId: "m1" as never,
      projectId: "remote" as never,
      coordinatorThreadId: "remote-coordinator" as never,
    };
    const incoming = {
      expectedRevision: 7,
      logicalProject: { ...logicalProject, members: [predecessor] },
      coordinatorBinding: {
        epoch: 3,
        state: "active" as const,
        operationId: "return",
        predecessor,
      },
    };
    const target = {
      ...settings,
      coordinatorBinding: { ...coordinatorBinding, state: "transferred" as const },
    };
    failureOf(
      plan({ ...command, ownership: incoming }, { project: row({ workspaceSettings: target }) }),
    );
    const event = payloadOf(
      plan(
        { ...command, ownership: { ...incoming, acceptedHandoffOperationId: "return" } },
        { project: row({ workspaceSettings: target }) },
      ),
    );
    assert.deepInclude(event.workspaceSettings, {
      coordinatorBinding: incoming.coordinatorBinding,
    });
    failureOf(
      plan(
        { ...command, ownership: { ...incoming, acceptedHandoffOperationId: "wrong" } },
        { project: row({ workspaceSettings: target }) },
      ),
    );
    failureOf(
      plan(
        {
          ...command,
          ownership: {
            ...incoming,
            acceptedHandoffOperationId: "return",
            coordinatorBinding: { ...incoming.coordinatorBinding, epoch: 2 },
          },
        },
        { project: row({ workspaceSettings: target }) },
      ),
    );
  });
  it("requires exact standalone identity consent to join a target project", () => {
    const target = { ...settings, coordinatorBinding: { epoch: 0, state: "active" as const } };
    const ownership = {
      expectedRevision: 7,
      logicalProject: { ...logicalProject, id: "logical:new" },
      coordinatorBinding: { epoch: 0, state: "transferred" as const, operationId: "transfer" },
    };
    failureOf(plan({ ...command, ownership }, { project: row({ workspaceSettings: target }) }));
    payloadOf(
      plan(
        {
          ...command,
          ownership: { ...ownership, joinExpectedLogicalProjectId: logicalProject.id },
        },
        { project: row({ workspaceSettings: target }) },
      ),
    );
  });
});

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
