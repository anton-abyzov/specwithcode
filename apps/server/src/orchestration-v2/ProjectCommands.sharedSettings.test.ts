import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  ThreadId,
  type LogicalProjectMember,
  ProjectId,
  type ProjectWorkspacePatch,
  type ProjectWorkspaceSettings,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  ownershipRejection,
  planProjectCommand,
  type ProjectCommand,
  type ProjectMetaUpdateCommand,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

// 1448 AC-05: linked personal seats keep the newest shared settings (name, icon,
// instructions, repository URLs) by a server-managed stamp. The decider sets it.

const NOW = "2026-03-04T05:06:07.000Z";
const now = DateTime.makeUnsafe(NOW);
const EARLIER = "2026-02-01T00:00:00.000Z";
const projectId = ProjectId.make("project-assistant");

const repository = (id: string, url: string, localPath: string | null = null) => ({
  id: id as never,
  url,
  localPath: localPath as never,
});

const personalSettings = (
  overrides: {
    readonly [K in keyof ProjectWorkspaceSettings]?: ProjectWorkspaceSettings[K] | undefined;
  } = {},
): ProjectWorkspaceSettings =>
  ({
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 3,
    instructions: "Be brief.",
    environment: {
      additionalFolders: [],
      repositories: [repository("repo-a", "https://github.com/acme/alpha.git", "/tmp/alpha")],
    },
    sharedSettingsUpdatedAt: EARLIER,
    ...overrides,
  }) as ProjectWorkspaceSettings;

const row = (settings: ProjectWorkspaceSettings, overrides: Partial<ProjectRow> = {}) =>
  ({
    projectId,
    title: "Percy",
    workspaceRoot: "/tmp/percy",
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
    scripts: [],
    createdAt: EARLIER,
    updatedAt: EARLIER,
    deletedAt: null,
    workspaceSettings: settings,
    ...overrides,
  }) as ProjectRow;

const update = (
  fields: Omit<Partial<ProjectMetaUpdateCommand>, "type" | "commandId" | "projectId">,
): ProjectCommand =>
  ({
    type: "project.meta.update",
    commandId: CommandId.make("update"),
    projectId,
    ...fields,
  }) as ProjectCommand;

const patch = (fields: Partial<ProjectWorkspacePatch>): ProjectWorkspacePatch =>
  ({ expectedRevision: 3, ...fields }) as ProjectWorkspacePatch;

const plan = (command: ProjectCommand, project: ProjectRow) =>
  planProjectCommand({
    command,
    state: { project, workspaceOwner: undefined },
    eventId: EventId.make("event:planned"),
    now,
  });

/** The stamp the planned event saves, or undefined when it saves no settings or no stamp. */
const stampAfter = (command: ProjectCommand, project: ProjectRow) => {
  const result = plan(command, project);
  if (Result.isFailure(result)) assert.fail(`rejected: ${String(result.failure.message)}`);
  const payload = Result.getOrThrow(result).payload as {
    workspaceSettings?: ProjectWorkspaceSettings;
  };
  return payload.workspaceSettings?.sharedSettingsUpdatedAt;
};

describe("personal shared-settings stamp (1448 AC-05)", () => {
  const assistant = row(personalSettings());

  it("stamps a rename with the command time", () => {
    assert.equal(stampAfter(update({ title: "Percy Two" }), assistant), NOW);
  });

  it("stamps a new icon", () => {
    assert.equal(
      stampAfter(update({ projectIcon: { kind: "emoji", emoji: "🦉" } as never }), assistant),
      NOW,
    );
  });

  it("stamps changed instructions", () => {
    assert.equal(
      stampAfter(update({ workspaceSettings: patch({ instructions: "Be thorough." }) }), assistant),
      NOW,
    );
  });

  it("stamps an added or changed repository URL", () => {
    const added = patch({
      environment: {
        additionalFolders: [],
        repositories: [
          repository("repo-a", "https://github.com/acme/alpha.git", "/tmp/alpha"),
          repository("repo-b", "https://github.com/acme/beta.git"),
        ],
      },
    });
    assert.equal(stampAfter(update({ workspaceSettings: added }), assistant), NOW);
    const changed = patch({
      environment: {
        additionalFolders: [],
        repositories: [repository("repo-a", "https://github.com/acme/gamma.git", "/tmp/alpha")],
      },
    });
    assert.equal(stampAfter(update({ workspaceSettings: changed }), assistant), NOW);
  });

  it("keeps the stamp when only a repository's local path or extra folders change", () => {
    const localOnly = patch({
      environment: {
        additionalFolders: ["/tmp/notes" as never],
        repositories: [repository("repo-a", "https://github.com/acme/alpha.git", "/tmp/moved")],
      },
    });
    assert.equal(stampAfter(update({ workspaceSettings: localOnly }), assistant), EARLIER);
  });

  it("keeps the stamp when the same values are sent again", () => {
    assert.equal(
      stampAfter(
        update({
          title: "Percy",
          projectIcon: { kind: "lucide", name: "sparkles", color: "violet" } as never,
          workspaceSettings: patch({
            instructions: "Be brief.",
            environment: personalSettings().environment,
          }),
        }),
        assistant,
      ),
      EARLIER,
    );
  });

  it("keeps the stamp for per-machine settings: pause and local-only memory", () => {
    assert.equal(
      stampAfter(update({ workspaceSettings: patch({ paused: true }) }), assistant),
      EARLIER,
    );
    assert.equal(
      stampAfter(
        update({ workspaceSettings: patch({ localOnlyMemoryFiles: ["private.md"] }) }),
        assistant,
      ),
      EARLIER,
    );
  });

  it("does not stamp a never-stamped assistant on a per-machine change", () => {
    const fresh = row(personalSettings({ sharedSettingsUpdatedAt: undefined }));
    const { sharedSettingsUpdatedAt: _drop, ...rest } = personalSettings();
    const unstamped = row(rest as ProjectWorkspaceSettings);
    for (const project of [fresh, unstamped]) {
      assert.isUndefined(
        stampAfter(update({ workspaceSettings: patch({ paused: true }) }), project),
      );
    }
  });

  it("keeps the stamp on a routine-owner ownership change", () => {
    const self = {
      environmentId: "env-local" as never,
      projectId,
      coordinatorThreadId: "coordinator-local" as never,
    };
    const logicalProject = {
      id: "logical:percy",
      title: "Percy",
      coordinatorId: "coordinator:percy",
      members: [self],
    };
    const binding = { epoch: 1, state: "active" as const, routineOwner: false };
    const linked = row(personalSettings({ logicalProject, coordinatorBinding: binding }));
    const command = update({
      ownership: {
        mode: "set-routine-owner",
        expectedRevision: 3,
        logicalProject,
        coordinatorBinding: { ...binding, routineOwner: true },
      },
    });
    const result = plan(command, linked);
    if (Result.isFailure(result)) assert.fail(`rejected: ${String(result.failure.message)}`);
    const settings = (
      Result.getOrThrow(result).payload as { workspaceSettings?: ProjectWorkspaceSettings }
    ).workspaceSettings;
    assert.equal(settings?.coordinatorBinding?.routineOwner, true);
    assert.equal(settings?.sharedSettingsUpdatedAt, EARLIER);
  });

  it("uses the peer's stamp a linked copy carries instead of now", () => {
    const peerStamp = "2026-03-01T12:00:00.000Z";
    assert.equal(
      stampAfter(update({ title: "Percy Two", sharedSettingsStamp: peerStamp }), assistant),
      peerStamp,
    );
    assert.equal(
      stampAfter(
        update({
          workspaceSettings: patch({ instructions: "From the peer." }),
          sharedSettingsStamp: peerStamp,
        }),
        assistant,
      ),
      peerStamp,
    );
  });

  it("ignores a carried stamp when nothing shared changed", () => {
    assert.equal(
      stampAfter(
        update({
          workspaceSettings: patch({ paused: true }),
          sharedSettingsStamp: "2030-01-01T00:00:00.000Z",
        }),
        assistant,
      ),
      EARLIER,
    );
  });

  it("ignores a settings patch that tries to set the stamp itself", () => {
    const forged = patch({ paused: true });
    (forged as Record<string, unknown>).sharedSettingsUpdatedAt = "2030-01-01T00:00:00.000Z";
    assert.equal(stampAfter(update({ workspaceSettings: forged }), assistant), EARLIER);

    const forgedOnFresh = patch({ paused: true });
    (forgedOnFresh as Record<string, unknown>).sharedSettingsUpdatedAt = "2030-01-01T00:00:00.000Z";
    const fresh = row(personalSettings({ sharedSettingsUpdatedAt: undefined }));
    assert.isUndefined(stampAfter(update({ workspaceSettings: forgedOnFresh }), fresh));

    // With a real shared change the decider's own time wins over the forged value.
    const forgedWithRename = patch({ instructions: "New." });
    (forgedWithRename as Record<string, unknown>).sharedSettingsUpdatedAt =
      "2030-01-01T00:00:00.000Z";
    assert.equal(stampAfter(update({ workspaceSettings: forgedWithRename }), assistant), NOW);
  });
});

describe("the shared-settings stamp never moves back", () => {
  const LATER = "2026-03-10T00:00:00.000Z";
  const ahead = row(personalSettings({ sharedSettingsUpdatedAt: LATER }));

  it("refuses a peer's older, equal or unreadable stamp and changes nothing", () => {
    for (const peerStamp of ["2026-03-01T00:00:00.000Z", LATER, "z"]) {
      for (const fields of [
        { title: "Percy Two" },
        { workspaceSettings: patch({ instructions: "Older text." }) },
      ]) {
        const result = plan(update({ ...fields, sharedSettingsStamp: peerStamp }), ahead);
        assert.isTrue(Result.isFailure(result), `accepted ${peerStamp}`);
      }
    }
  });

  it("takes a peer's newer stamp", () => {
    assert.equal(
      stampAfter(
        update({ title: "Percy Two", sharedSettingsStamp: "2026-03-11T00:00:00.000Z" }),
        ahead,
      ),
      "2026-03-11T00:00:00.000Z",
    );
  });

  it("stamps a local edit after the stored stamp when this clock runs behind", () => {
    assert.equal(
      stampAfter(update({ workspaceSettings: patch({ instructions: "Mine." }) }), ahead),
      "2026-03-10T00:00:00.001Z",
    );
  });
});

describe("code projects never get a shared-settings stamp", () => {
  const code = row({
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    revision: 3,
    instructions: "Be brief.",
  });

  it("does not stamp a rename, icon, instructions or repository change", () => {
    assert.isUndefined(stampAfter(update({ title: "Renamed" }), code));
    assert.isUndefined(
      stampAfter(update({ projectIcon: { kind: "emoji", emoji: "🦉" } as never }), code),
    );
    assert.isUndefined(
      stampAfter(update({ workspaceSettings: patch({ instructions: "Be thorough." }) }), code),
    );
    assert.isUndefined(
      stampAfter(
        update({
          workspaceSettings: patch({
            environment: {
              additionalFolders: [],
              repositories: [repository("repo-b", "https://github.com/acme/beta.git")],
            },
          }),
        }),
        code,
      ),
    );
  });

  it("ignores a carried stamp and a forged patch stamp", () => {
    assert.isUndefined(
      stampAfter(
        update({ title: "Renamed", sharedSettingsStamp: "2030-01-01T00:00:00.000Z" }),
        code,
      ),
    );
    const forged = patch({ instructions: "x" });
    (forged as Record<string, unknown>).sharedSettingsUpdatedAt = "2030-01-01T00:00:00.000Z";
    assert.isUndefined(stampAfter(update({ workspaceSettings: forged }), code));
  });
});

// 1448 C1: the bindings personal link join and leave write pass the ownership rules.
describe("personal link bindings pass the ownership rules", () => {
  const member = (env: string, project: string): LogicalProjectMember => ({
    environmentId: EnvironmentId.make(env),
    projectId: ProjectId.make(project),
    coordinatorThreadId: ThreadId.make(`project-coordinator:${project}`),
  });
  const self = member("env-a", projectId);
  const peer = member("env-b", "project-b");
  const returning = member("env-c", "project-c");
  const pair = {
    id: "logical:pair",
    title: "Percy",
    coordinatorId: self.coordinatorThreadId,
    members: [self, peer],
  };

  it("lets a link add a member back, forgetting its removal and noting the relink", () => {
    const previous = personalSettings({
      logicalProject: pair,
      coordinatorBinding: {
        epoch: 0,
        state: "active",
        routineOwner: true,
        removedMembers: [
          {
            environmentId: returning.environmentId,
            projectId: returning.projectId,
            removedAt: EARLIER,
          },
        ],
      },
    });
    assert.isUndefined(
      ownershipRejection(projectId, previous, {
        mode: "link-member",
        expectedRevision: 3,
        logicalProject: { ...pair, members: [self, peer, returning] },
        coordinatorBinding: {
          epoch: 0,
          state: "active",
          routineOwner: true,
          relinkedMembers: [
            {
              environmentId: returning.environmentId,
              projectId: returning.projectId,
              linkedAt: NOW,
            },
          ],
        },
      }),
    );
  });

  it("lets a seat leave remembering the link in formerLinks", () => {
    const previous = personalSettings({
      logicalProject: pair,
      coordinatorBinding: { epoch: 0, state: "active", routineOwner: false },
    });
    assert.isUndefined(
      ownershipRejection(projectId, previous, {
        mode: "unlink",
        expectedRevision: 3,
        logicalProject: {
          id: "logical:fresh",
          title: "Percy",
          coordinatorId: self.coordinatorThreadId,
          members: [self],
        },
        coordinatorBinding: {
          epoch: 0,
          state: "active",
          routineOwner: true,
          formerLinks: [{ logicalProjectId: pair.id, members: pair.members, leftAt: NOW }],
        },
      }),
    );
  });

  it("lets a standalone seat join with its other former links and relinked members", () => {
    const previous = personalSettings({
      logicalProject: {
        id: "logical:own",
        title: "Percy",
        coordinatorId: self.coordinatorThreadId,
        members: [self],
      },
      coordinatorBinding: { epoch: 0, state: "active", routineOwner: true },
    });
    assert.isUndefined(
      ownershipRejection(projectId, previous, {
        mode: "join-as-member",
        expectedRevision: 3,
        joinExpectedLogicalProjectId: "logical:own",
        logicalProject: pair,
        coordinatorBinding: {
          epoch: 0,
          state: "active",
          operationId: "personal-link:op",
          routineOwner: true,
          formerLinks: [{ logicalProjectId: "logical:other", members: [self], leftAt: EARLIER }],
          relinkedMembers: pair.members.map((entry) => ({
            environmentId: entry.environmentId,
            projectId: entry.projectId,
            linkedAt: NOW,
          })),
        },
      }),
    );
  });
});
