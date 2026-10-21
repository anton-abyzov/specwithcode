import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectTitle,
  PROJECT_NAME_MAX_LENGTH,
  projectNameKey,
  type LogicalProject,
  type LogicalProjectMember,
  type ProjectCoordinatorBinding,
  type ProjectWorkspaceSettings,
  type ProjectWorkspacePatch,
  type ProjectKind,
  type ThreadId,
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

/**
 * Why an ownership write happens. Each mode admits exactly one shape of change, so
 * a write meant for one purpose can never perform another:
 * - `handoff`: MachineHandoff fences, acknowledges or receives a coordinator transfer.
 * - `adopt-identity`: a project from before shared identities gets one, itself the only member.
 * - `link-member`: the kept coordinator lists more members; its binding does not change.
 * - `join-as-member`: a standalone copy adopts another identity and relinquishes its coordinator.
 * - `remove-member`: the kept coordinator stops listing members; its binding does not change.
 * - `unlink`: a relinquished member leaves with a fresh identity and an active coordinator.
 * - `start-coordinator`: a relinquished member runs its own coordinator next to the others,
 *   at a higher epoch, replacing none of them.
 */
export type ProjectOwnershipMode =
  | "handoff"
  | "adopt-identity"
  | "link-member"
  | "join-as-member"
  | "remove-member"
  | "unlink"
  | "takeover"
  | "superseded"
  | "start-coordinator";

export interface ProjectOwnershipUpdate {
  readonly mode: ProjectOwnershipMode;
  readonly expectedRevision: number;
  /** Exact singleton identity the explicit handoff plan is allowed to join. */
  readonly joinExpectedLogicalProjectId?: string | null;
  /** Internal only: MachineHandoff verified a destination-bound published checkpoint. */
  readonly acceptedHandoffOperationId?: string;
  /** Internal only: a handoff failed before the destination accepted; the source becomes active again. */
  readonly releasedHandoffOperationId?: string;
  readonly logicalProject: LogicalProject;
  readonly coordinatorBinding: ProjectCoordinatorBinding;
}

export interface ProjectCreateCommand {
  readonly initialLogicalProject?: LogicalProject;
  readonly initialCoordinatorBinding?: ProjectCoordinatorBinding;
  readonly kind?: ProjectKind;
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  /** Internal handoff seed; public create payloads cannot supply this field. */
  readonly initialWorkerModelSelection?: ModelSelection | null;
  /** Internal: the temporary auth session creating the project; see TemporaryProjects. */
  readonly temporarySessionId?: string;
}

export interface ProjectMetaUpdateCommand {
  /** Server-only ownership transition, never read from an ordinary settings patch. */
  readonly ownership?: ProjectOwnershipUpdate;
  readonly workspaceSettings?: ProjectWorkspacePatch;
  readonly coordinatorThreadId?: ThreadId;
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  /** Internal automatic initialization must not replace a concurrent user choice. */
  readonly onlyIfDefaultModelUnset?: boolean;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a project that does not exist or was deleted. */
export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

/** A rejected settings write has a stable receipt and can be safely retried. */
export class ProjectSettingsRevisionConflictError extends Schema.TaggedError<ProjectSettingsRevisionConflictError>()(
  "ProjectSettingsRevisionConflictError",
  {
    projectId: ProjectId,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
) {
  override get message(): string {
    return "Project settings changed elsewhere. Reload before saving.";
  }
}

export class ProjectDefaultModelConflictError extends Schema.TaggedError<ProjectDefaultModelConflictError>()(
  "ProjectDefaultModelConflictError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "Project default model changed elsewhere. Reload before saving.";
  }
}

/** A rename would give the project another project's name, ignoring case. */
export class ProjectNameTakenError extends Schema.TaggedError<ProjectNameTakenError>()(
  "ProjectNameTakenError",
  {
    projectId: ProjectId,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return "Another project already has this name. Choose a different one.";
  }
}

/**
 * A machine keeps one personal assistant, so a second one is refused; the
 * client opens `existingProjectId` instead.
 */
export class PersonalAssistantExistsError extends Schema.TaggedError<PersonalAssistantExistsError>()(
  "PersonalAssistantExistsError",
  {
    projectId: ProjectId,
    existingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return "This machine already has its personal assistant. Open it instead of creating another.";
  }
}

/** A project's kind is set when it is created: an assistant's private history never becomes linkable. */
export class ProjectKindFixedError extends Schema.TaggedError<ProjectKindFixedError>()(
  "ProjectKindFixedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "A project's kind is set when it is created and cannot be changed.";
  }
}

export const ProjectCommandRejection = Schema.Union([
  PersonalAssistantExistsError,
  ProjectKindFixedError,
  ProjectCommandInvariantError,
  ProjectNameTakenError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
  ProjectSettingsRevisionConflictError,
  ProjectDefaultModelConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
/**
 * A rejected receipt stores its rejection as JSON, so a retried command id
 * replays the same typed error even when a fresh plan would now succeed.
 */
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
/** None for receipts that predate structured rejections. */
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  /** The target project's row, including a soft-deleted one; only create sees deleted rows as taken. */
  readonly project: ProjectRow | undefined;
  /** The active project that holds the command's requested workspace root, if any. */
  readonly workspaceOwner: ProjectRow | undefined;
  /** Another active project already named like the command's new title, if any. */
  readonly nameOwner?: ProjectRow | undefined;
  /** This machine's personal assistant, read when the command creates a personal project. */
  readonly assistant?: ProjectRow | undefined;
}

/** Whether planning `command` needs this machine's assistant, and so its lock. */
export function createsPersonalAssistant(command: ProjectCommand): boolean {
  return command.type === "project.create" && command.kind === "personal";
}

/** Whether this command renames the project; ownership transfers carry the identity's own name. */
export function renamesProject(command: ProjectCommand): command is ProjectMetaUpdateCommand & {
  readonly title: string;
} {
  return (
    command.type === "project.meta.update" && command.title !== undefined && !command.ownership
  );
}

/**
 * The other project that already has `title`, ignoring case. Checkouts of the same
 * logical project, or of the same repository, are one project in the sidebar and may
 * share a name; `sameRepository` says whether two rows are checkouts of one repository.
 */
export function findProjectNameOwner(input: {
  readonly rows: ReadonlyArray<ProjectRow>;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly sameRepository?: (a: ProjectRow, b: ProjectRow) => boolean;
}): ProjectRow | undefined {
  const target = input.rows.find((row) => row.projectId === input.projectId);
  const identity = target?.workspaceSettings?.logicalProject?.id;
  const key = projectNameKey(input.title);
  return input.rows.find(
    (row) =>
      row.deletedAt === null &&
      row.projectId !== input.projectId &&
      projectNameKey(logicalProjectTitle(row)) === key &&
      (identity === undefined || row.workspaceSettings?.logicalProject?.id !== identity) &&
      !(target && input.sameRepository?.(target, row)),
  );
}

/** Order-independent equality for the small persisted ownership records. */
function sameRecord(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const memberRef = (member: LogicalProjectMember) =>
  JSON.stringify([member.environmentId, member.projectId, member.coordinatorThreadId]);

/** Projects saved before bindings existed coordinate as an active epoch-0 owner. */
const ACTIVE_LEGACY_BINDING: ProjectCoordinatorBinding = { epoch: 0, state: "active" };

/**
 * Why `ownership` may not be applied to a project whose settings are `previous`,
 * or undefined when the change is exactly the shape its mode allows.
 */
export function ownershipRejection(
  projectId: ProjectId,
  previous: ProjectWorkspaceSettings,
  ownership: ProjectOwnershipUpdate,
): string | undefined {
  const old = previous.coordinatorBinding;
  const next = ownership.coordinatorBinding;
  const identity = previous.logicalProject;
  const incoming = ownership.logicalProject;
  const selfEntries = incoming.members.filter((member) => member.projectId === projectId);
  if (ownership.mode !== "handoff" && ownership.acceptedHandoffOperationId !== undefined)
    return "Only a verified machine handoff can accept an incoming coordinator.";
  if (ownership.mode !== "handoff" && ownership.releasedHandoffOperationId !== undefined)
    return "Only a failed machine handoff can return its coordinator.";
  const keepsIdentity = () =>
    identity !== undefined &&
    incoming.id === identity.id &&
    incoming.coordinatorId === identity.coordinatorId &&
    incoming.title === identity.title;
  const keepsActiveBinding = () =>
    (old ?? ACTIVE_LEGACY_BINDING).state === "active" &&
    sameRecord(next, old ?? ACTIVE_LEGACY_BINDING);
  const includesAll = (
    outer: ReadonlyArray<LogicalProjectMember>,
    inner: ReadonlyArray<LogicalProjectMember>,
  ) => {
    const refs = new Set(outer.map(memberRef));
    return inner.every((member) => refs.has(memberRef(member)));
  };
  switch (ownership.mode) {
    case "handoff": {
      const acceptedIncoming =
        ownership.acceptedHandoffOperationId !== undefined &&
        ownership.acceptedHandoffOperationId === next.operationId &&
        next.state === "active" &&
        next.predecessor !== undefined &&
        (!old || next.epoch > old.epoch) &&
        incoming.members.some(
          (m) =>
            m.projectId === next.predecessor!.projectId &&
            m.environmentId === next.predecessor!.environmentId &&
            m.coordinatorThreadId === next.predecessor!.coordinatorThreadId,
        );
      if (
        identity &&
        identity.id !== incoming.id &&
        !(
          ownership.joinExpectedLogicalProjectId === identity.id &&
          identity.members.every((member) => member.projectId === projectId) &&
          identity.members.length <= 1 &&
          (next.state === "transferred" || acceptedIncoming)
        )
      )
        return "Only an explicitly accepted standalone project can join another identity.";
      // A handoff that failed before the destination applied anything returns the same binding to active.
      const releasedOutgoing =
        ownership.releasedHandoffOperationId !== undefined &&
        old?.state === "transferring" &&
        old.operationId === ownership.releasedHandoffOperationId &&
        next.operationId === old.operationId &&
        next.state === "active" &&
        next.epoch === old.epoch;
      if (
        old &&
        !acceptedIncoming &&
        !releasedOutgoing &&
        (next.epoch !== old.epoch ||
          (old.state !== "active" &&
            (next.state === "active" || next.operationId !== old.operationId)) ||
          (old.state === "transferred" && next.state !== "transferred"))
      )
        return "A relinquished coordinator cannot resume or change its handoff.";
      return undefined;
    }
    case "adopt-identity":
      if (identity) return "This project already has a shared identity.";
      if (!incoming.id.startsWith("logical:") || incoming.members.length !== 1 || !selfEntries[0])
        return "A new shared identity lists only this project.";
      if (!keepsActiveBinding())
        return "Only an active coordinator can adopt a shared identity, and its binding stays as it is.";
      return undefined;
    case "link-member":
      if (!keepsIdentity()) return "Linking keeps the coordinator's shared identity as it is.";
      if (!keepsActiveBinding())
        return "Only the active coordinator can add members, and its binding stays as it is.";
      if (
        !includesAll(incoming.members, identity!.members) ||
        incoming.members.length <= identity!.members.length
      )
        return "Linking adds members and keeps every existing one.";
      return undefined;
    case "remove-member":
      if (!keepsIdentity()) return "Unlinking keeps the coordinator's shared identity as it is.";
      if (!keepsActiveBinding())
        return "Only the active coordinator can remove members, and its binding stays as it is.";
      if (
        !includesAll(identity!.members, incoming.members) ||
        incoming.members.length >= identity!.members.length ||
        !includesAll(
          incoming.members,
          identity!.members.filter((member) => member.projectId === projectId),
        )
      )
        return "Unlinking removes other members and keeps this project.";
      return undefined;
    case "join-as-member": {
      if (
        identity &&
        (identity.id === incoming.id ||
          ownership.joinExpectedLogicalProjectId !== identity.id ||
          identity.members.length > 1 ||
          identity.members.some((member) => member.projectId !== projectId))
      )
        return "Only an explicitly accepted standalone project can join another identity.";
      if (!identity && ownership.joinExpectedLogicalProjectId !== null)
        return "Only an explicitly accepted standalone project can join another identity.";
      if (old && old.state !== "active")
        return "A project in a coordinator handoff cannot join another project.";
      const self = selfEntries[0];
      if (
        next.state !== "transferred" ||
        next.operationId === undefined ||
        next.predecessor !== undefined ||
        next.successor === undefined ||
        !self ||
        memberRef(next.successor) === memberRef(self) ||
        !incoming.members.some((member) => memberRef(member) === memberRef(next.successor!))
      )
        return "A joining copy relinquishes its coordinator to a listed member.";
      return undefined;
    }
    case "unlink":
      if (old?.state !== "transferred")
        return "Only a member whose coordinator was relinquished can unlink; finish any handoff first.";
      if (
        identity?.id === incoming.id ||
        !incoming.id.startsWith("logical:") ||
        incoming.members.length !== 1 ||
        !selfEntries[0]
      )
        return "An unlinked project gets a fresh identity that lists only itself.";
      if (
        next.state !== "active" ||
        next.epoch !== 0 ||
        next.predecessor !== undefined ||
        next.successor !== undefined
      )
        return "An unlinked project starts its own coordinator at epoch 0.";
      return undefined;
    case "takeover": {
      if (old?.state !== "transferred" || old.successor === undefined)
        return "Only a member that runs workers for another copy can take over its coordinator.";
      if (!keepsIdentity()) return "Taking over keeps the shared identity as it is.";
      if (
        !includesAll(incoming.members, identity!.members) ||
        !includesAll(identity!.members, incoming.members) ||
        !selfEntries[0]
      )
        return "Taking over keeps every member listed as it is.";
      if (
        next.state !== "active" ||
        next.epoch <= old.epoch ||
        next.operationId === undefined ||
        next.takenOverAt === undefined ||
        next.successor !== undefined ||
        next.predecessor === undefined ||
        memberRef(next.predecessor) === memberRef(selfEntries[0]) ||
        !incoming.members.some((member) => memberRef(member) === memberRef(next.predecessor!))
      )
        return "A takeover becomes the active coordinator at a higher epoch, after a listed coordinator it replaces.";
      return undefined;
    }
    case "start-coordinator": {
      if (old?.state !== "transferred")
        return "Only a member whose coordinator was relinquished can start its own; finish any handoff first.";
      if (!keepsIdentity()) return "Starting a coordinator keeps the shared identity as it is.";
      if (!sameRecord(incoming.members, identity!.members) || !selfEntries[0])
        return "Starting a coordinator keeps every member listed as it is.";
      if (
        next.state !== "active" ||
        next.epoch <= old.epoch ||
        next.operationId === undefined ||
        next.predecessor !== undefined ||
        next.successor !== undefined ||
        next.takenOverAt !== undefined ||
        next.releaseReason !== undefined
      )
        return "A started coordinator is active at a higher epoch and replaces no other coordinator.";
      return undefined;
    }
    case "superseded": {
      const current = old ?? ACTIVE_LEGACY_BINDING;
      if (current.state !== "active")
        return "Only the active coordinator can give way to a member that took over.";
      if (!keepsIdentity()) return "Giving way keeps the shared identity as it is.";
      if (!sameRecord(incoming.members, identity!.members))
        return "Giving way keeps every member listed as it is.";
      const self = selfEntries[0];
      if (
        next.state !== "transferred" ||
        next.epoch <= current.epoch ||
        next.operationId === undefined ||
        next.takenOverAt === undefined ||
        next.predecessor !== undefined ||
        next.successor === undefined ||
        !self ||
        memberRef(next.successor) === memberRef(self) ||
        !incoming.members.some((member) => memberRef(member) === memberRef(next.successor!))
      )
        return "A coordinator gives way only to a listed member that took over at a higher epoch.";
      return undefined;
    }
  }
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/**
 * Decide one project command against the rows it touches. The caller reads
 * `state` under the project's lock and commits the planned event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      if (
        command.kind === "personal" &&
        state.assistant !== undefined &&
        state.assistant.projectId !== command.projectId
      ) {
        return Result.fail(
          new PersonalAssistantExistsError({
            projectId: command.projectId,
            existingProjectId: state.assistant.projectId,
          }),
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Public create seeds remain ignored. A handoff copies the destination's
          // saved choice atomically, before settings writes or launch can fail.
          defaultModelSelection: command.initialWorkerModelSelection ?? null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            kind: command.kind ?? "code",
            ...(command.initialLogicalProject
              ? { logicalProject: command.initialLogicalProject }
              : {}),
            ...(command.initialCoordinatorBinding
              ? { coordinatorBinding: command.initialCoordinatorBinding }
              : {}),
            ...(command.temporarySessionId
              ? { temporarySessionId: command.temporarySessionId }
              : {}),
          },
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      // Keeping the current name never collides with itself, and changing only its
      // case collides with nothing but itself.
      const renamed = renamesProject(command) && command.title !== logicalProjectTitle(project);
      if (renamed && command.title.length > PROJECT_NAME_MAX_LENGTH) {
        return invariant(`Project names must be at most ${PROJECT_NAME_MAX_LENGTH} characters.`);
      }
      if (
        renamed &&
        state.nameOwner !== undefined &&
        state.nameOwner.projectId !== command.projectId
      ) {
        return Result.fail(
          new ProjectNameTakenError({
            projectId: command.projectId,
            conflictingProjectId: state.nameOwner.projectId,
          }),
        );
      }
      if (command.onlyIfDefaultModelUnset && project.defaultModelSelection !== null) {
        return Result.fail(new ProjectDefaultModelConflictError({ projectId: command.projectId }));
      }
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      const previousSettings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      if (
        command.workspaceSettings &&
        command.workspaceSettings.expectedRevision !== previousSettings.revision
      ) {
        return Result.fail(
          new ProjectSettingsRevisionConflictError({
            projectId: command.projectId,
            expectedRevision: command.workspaceSettings.expectedRevision,
            actualRevision: previousSettings.revision,
          }),
        );
      }
      if (command.ownership) {
        if (command.ownership.expectedRevision !== previousSettings.revision)
          return Result.fail(
            new ProjectSettingsRevisionConflictError({
              projectId: command.projectId,
              expectedRevision: command.ownership.expectedRevision,
              actualRevision: previousSettings.revision,
            }),
          );
        const rejection = ownershipRejection(
          command.projectId,
          previousSettings,
          command.ownership,
        );
        if (rejection !== undefined) return invariant(rejection);
      }
      const requestedKind = command.workspaceSettings?.kind;
      if (requestedKind !== undefined && requestedKind !== previousSettings.kind) {
        return Result.fail(new ProjectKindFixedError({ projectId: command.projectId }));
      }
      // Ignore forged extras even in internal direct calls that bypass wire decoding.
      const {
        expectedRevision: _expected,
        logicalProject: _identity,
        coordinatorBinding: _binding,
        ...settingsPatch
      } = (command.workspaceSettings ?? {}) as ProjectWorkspacePatch & {
        logicalProject?: unknown;
        coordinatorBinding?: unknown;
      };
      const renamedIdentity =
        command.title !== undefined &&
        previousSettings.logicalProject &&
        previousSettings.coordinatorBinding?.state === "active"
          ? { ...previousSettings.logicalProject, title: command.title }
          : undefined;
      const workspaceSettings =
        command.workspaceSettings ||
        command.coordinatorThreadId ||
        command.ownership ||
        renamedIdentity
          ? {
              ...previousSettings,
              ...Object.fromEntries(
                Object.entries(settingsPatch).filter(([, value]) => value !== undefined),
              ),
              ...(command.coordinatorThreadId
                ? { coordinatorThreadId: command.coordinatorThreadId }
                : {}),
              ...(renamedIdentity ? { logicalProject: renamedIdentity } : {}),
              ...(command.ownership
                ? {
                    logicalProject: command.ownership.logicalProject,
                    coordinatorBinding: command.ownership.coordinatorBinding,
                  }
                : {}),
              revision: previousSettings.revision + 1,
            }
          : undefined;
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            // The raw ID is unbounded user input and this detail is persisted.
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(workspaceSettings === undefined ? {} : { workspaceSettings }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
