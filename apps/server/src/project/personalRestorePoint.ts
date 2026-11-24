/**
 * A personal assistant's own restore point (1448 D-16): what "Undo the merge"
 * puts back on one machine. Beside the whole-database copy
 * (`personalLinkSnapshot.ts`), a point holds only this assistant: its memory
 * files and their "Keep on this machine" flags, its name, icon, instructions
 * and attached repositories with this machine's folders, and the link it was
 * in, for information. Chats and every other project are never part of one.
 *
 * One owner-only JSON file per point, in
 * `<state>/backups/personal-link/<id>.percy.json`. It holds no secret beyond
 * what the memory files themselves hold.
 *
 * @module personalRestorePoint
 */
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type Project,
  type ProjectId,
  ProjectIconOverride,
  PROJECT_MEMORY_MAX_FILES,
  PROJECT_MEMORY_TOTAL_BYTES,
  ProjectMemoryName,
  ProjectRepository,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { randomBytes } from "../nodeCrypto.ts";
import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import { localOnlyMemorySet } from "./memorySecretScan.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

export const PersonalRestorePointReason = Schema.Literals(["before-link", "before-undo"]);
export type PersonalRestorePointReason = typeof PersonalRestorePointReason.Type;

const FILE_SUFFIX = ".percy.json";
const POINT_ID = /^\d{8}T\d{9}Z-(?:before-link|before-undo)-[0-9a-f]{8}$/;

/** The file a point is saved as. Version 1; a file of another version is refused. */
const PointFile = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  projectId: Schema.String,
  reason: PersonalRestorePointReason,
  savedAt: Schema.String,
  assistant: Schema.Struct({
    title: Schema.String,
    icon: Schema.NullOr(ProjectIconOverride),
    instructions: Schema.String,
    /** The attached repositories, each with this machine's folder for it. */
    repositories: Schema.Array(ProjectRepository),
    localOnlyMemoryFiles: Schema.Array(ProjectMemoryName),
  }),
  /** The link the assistant was in when saved. Information only: a restore never rejoins it. */
  link: Schema.Struct({
    logicalProjectId: Schema.NullOr(Schema.String),
    members: Schema.Array(
      Schema.Struct({ environmentId: Schema.String, projectId: Schema.String }),
    ),
    routineOwner: Schema.Boolean,
  }),
  memory: Schema.Array(
    Schema.Struct({
      name: ProjectMemoryName,
      content: Schema.String,
      sha256: Schema.String,
      localOnly: Schema.Boolean,
      updatedAt: Schema.String,
    }),
  ),
});
type PointFile = typeof PointFile.Type;
const decodePoint = Schema.decodeUnknownEffect(Schema.fromJsonString(PointFile));
const encodePoint = Schema.encodeEffect(Schema.fromJsonString(PointFile));

export interface PersonalRestorePointSummary {
  readonly id: string;
  readonly savedAt: string;
  readonly reason: PersonalRestorePointReason;
  readonly memoryFileCount: number;
  readonly path: string;
}

export interface PersonalRestoreResult {
  /** The point the assistant was put back to. */
  readonly restored: PersonalRestorePointSummary;
  /** The state just before, saved first, so this restore can itself be undone. */
  readonly savedBefore: PersonalRestorePointSummary;
  readonly memory: {
    readonly rewritten: number;
    readonly recreated: number;
    readonly removed: number;
  };
  /**
   * False when this machine refused the point's repository list (a folder is
   * gone, for example): everything else was restored and the list stays as it was.
   */
  readonly repositoriesRestored: boolean;
}

/** The assistant to save or restore is not there, or is not a personal assistant. */
export class PersonalRestoreAssistantError extends Schema.TaggedError<PersonalRestoreAssistantError>()(
  "PersonalRestoreAssistantError",
  { projectId: Schema.String, reason: Schema.Literals(["not_found", "not_personal"]) },
) {
  override get message(): string {
    return this.reason === "not_found"
      ? "Personal assistant not found."
      : "Only a personal assistant has restore points.";
  }
}

/** No point to restore: none was saved, or the named one is gone. Nothing was changed. */
export class PersonalRestorePointMissingError extends Schema.TaggedError<PersonalRestorePointMissingError>()(
  "PersonalRestorePointMissingError",
  { projectId: Schema.String, pointId: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.pointId === undefined
      ? "No restore point is saved for this personal assistant. Nothing was changed."
      : `Restore point ${this.pointId} was not found. Nothing was changed.`;
  }
}

/** The point cannot be trusted, so it is not used. Nothing was changed. */
export class PersonalRestorePointInvalidError extends Schema.TaggedError<PersonalRestorePointInvalidError>()(
  "PersonalRestorePointInvalidError",
  {
    projectId: Schema.String,
    pointId: Schema.String,
    problem: Schema.Literals([
      /** The id is not one this service made. */
      "id",
      "unreadable",
      /** Not a version 1 restore point. */
      "schema",
      /** Saved for another assistant. */
      "other_assistant",
      /** A memory file no longer matches the hash saved with it, or cannot be stored. */
      "content",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The restore point is damaged or is not this assistant's. Nothing was changed.";
  }
}

/** The caller must leave the link first: a restore under a live link would sync out. */
export class PersonalRestoreStillLinkedError extends Schema.TaggedError<PersonalRestoreStillLinkedError>()(
  "PersonalRestoreStillLinkedError",
  { projectId: Schema.String, members: Schema.Number },
) {
  override get message(): string {
    return "This personal assistant is still linked to other machines. Leave the link before restoring it. Nothing was changed.";
  }
}

export class PersonalRestoreStorageError extends Schema.TaggedError<PersonalRestoreStorageError>()(
  "PersonalRestoreStorageError",
  {
    projectId: Schema.String,
    stage: Schema.Literals([
      "read-assistant",
      "read-memory",
      "list-points",
      "write-point",
      "restore-settings",
      "restore-memory",
    ]),
    /** The memory file the stage was working on. */
    name: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "read-assistant":
      case "read-memory":
        return "Could not read this personal assistant.";
      case "list-points":
        return "Could not read the saved restore points.";
      case "write-point":
        return "Could not save a restore point; nothing was changed.";
      case "restore-settings":
        return "Could not restore this personal assistant's settings; its memory was not changed.";
      case "restore-memory":
        return "Could not restore every memory file. Run the restore again; the state before it is saved.";
    }
  }
}

export type PersonalRestoreCaptureError =
  | PersonalRestoreAssistantError
  | PersonalRestoreStorageError;
export type PersonalRestoreError =
  | PersonalRestoreCaptureError
  | PersonalRestorePointMissingError
  | PersonalRestorePointInvalidError
  | PersonalRestoreStillLinkedError;

export class PersonalRestorePoint extends Context.Service<
  PersonalRestorePoint,
  {
    /** Saves this assistant as it is now. Call with "before-link" before a seat's first link. */
    readonly capture: (
      projectId: ProjectId,
      reason: PersonalRestorePointReason,
    ) => Effect.Effect<PersonalRestorePointSummary, PersonalRestoreCaptureError>;
    /** This assistant's points, newest first. A file that cannot be read is not listed. */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<PersonalRestorePointSummary>, PersonalRestoreStorageError>;
    /**
     * Puts the assistant back to a point: the newest "before-link" one, or `id`.
     * The current state is saved first as a "before-undo" point, so restoring
     * that one undoes the undo. Memory becomes exactly the point's files, and a
     * file removed here leaves no tombstone for a later sync to carry. Name,
     * icon, instructions, repositories and local-only flags go back too.
     *
     * It does not leave the link: the caller does that first, and a restore
     * of an assistant still linked to other machines is refused. A missing or
     * damaged point is refused before anything is written.
     */
    readonly restore: (
      projectId: ProjectId,
      id?: string,
    ) => Effect.Effect<PersonalRestoreResult, PersonalRestoreError>;
  }
>()("specweave-studio/project/personalRestorePoint") {}

const byteLength = (content: string) => new TextEncoder().encode(content).length;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** `20261124T093015123Z`: the save time as the sortable start of a point's id. */
const idStamp = (savedAt: string) => savedAt.replace(/[-:.]/g, "");

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  // One capture or restore at a time, so save times only move forward.
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "backups", "personal-link");
  const fileOf = (id: string) => path.join(directory, `${id}${FILE_SUFFIX}`);

  const summaryOf = (point: PointFile): PersonalRestorePointSummary => ({
    id: point.id,
    savedAt: point.savedAt,
    reason: point.reason,
    memoryFileCount: point.memory.length,
    path: fileOf(point.id),
  });

  const loadAssistant = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(
        (cause) => new PersonalRestoreStorageError({ projectId, stage: "read-assistant", cause }),
      ),
      Effect.flatMap((found): Effect.Effect<Project, PersonalRestoreAssistantError> =>
        Option.isNone(found) || found.value.deletedAt !== null
          ? Effect.fail(new PersonalRestoreAssistantError({ projectId, reason: "not_found" }))
          : isPersonalAssistantProject(found.value)
            ? Effect.succeed(found.value)
            : Effect.fail(new PersonalRestoreAssistantError({ projectId, reason: "not_personal" })),
      ),
    );

  const readMemory = (projectId: ProjectId) =>
    workspace
      .readMemoryFiles({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new PersonalRestoreStorageError({ projectId, stage: "read-memory", cause }),
        ),
      );

  /** Every readable point of this assistant, newest first. */
  const pointsOf = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(directory))) return [];
      const points: Array<PointFile> = [];
      for (const name of yield* fileSystem.readDirectory(directory)) {
        if (!name.endsWith(FILE_SUFFIX)) continue;
        const id = name.slice(0, -FILE_SUFFIX.length);
        if (!POINT_ID.test(id)) continue;
        const point = yield* fileSystem
          .readFileString(path.join(directory, name))
          .pipe(Effect.flatMap(decodePoint), Effect.option);
        if (Option.isSome(point) && point.value.projectId === projectId && point.value.id === id)
          points.push(point.value);
      }
      return points.toSorted(
        (left, right) =>
          Date.parse(right.savedAt) - Date.parse(left.savedAt) || (left.id < right.id ? 1 : -1),
      );
    }).pipe(
      Effect.mapError(
        (cause) => new PersonalRestoreStorageError({ projectId, stage: "list-points", cause }),
      ),
    );

  /** Owner-only, through a temporary file and a rename: a point is whole or absent. */
  const writePoint = (point: PointFile) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const file = fileOf(point.id);
      const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      const text = yield* encodePoint(point);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(temporary, { flag: "wx", mode: 0o600 });
          yield* handle.writeAll(new TextEncoder().encode(text));
          yield* handle.sync;
        }),
      ).pipe(
        Effect.andThen(fileSystem.rename(temporary, file)),
        Effect.onError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PersonalRestoreStorageError({
            projectId: point.projectId,
            stage: "write-point",
            cause,
          }),
      ),
    );

  const captureNow = (project: Project, reason: PersonalRestorePointReason) =>
    Effect.gen(function* () {
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const localOnly = localOnlyMemorySet(settings);
      const files = yield* readMemory(project.id);
      const newest = (yield* pointsOf(project.id))[0];
      // Never at or before the newest point, so "newest first" holds on any clock.
      const savedAt = DateTime.formatIso(
        DateTime.makeUnsafe(
          Math.max(
            yield* Clock.currentTimeMillis,
            newest === undefined ? 0 : Date.parse(newest.savedAt) + 1,
          ),
        ),
      );
      const point: PointFile = {
        version: 1,
        id: `${idStamp(savedAt)}-${reason}-${randomBytes(4).toString("hex")}`,
        projectId: project.id,
        reason,
        savedAt,
        assistant: {
          title: project.title,
          icon: project.projectIcon ?? null,
          instructions: settings.instructions,
          repositories: settings.environment.repositories,
          localOnlyMemoryFiles: settings.localOnlyMemoryFiles ?? [],
        },
        link: {
          logicalProjectId: settings.logicalProject?.id ?? null,
          members: (settings.logicalProject?.members ?? []).map((member) => ({
            environmentId: member.environmentId,
            projectId: member.projectId,
          })),
          routineOwner: settings.coordinatorBinding?.routineOwner ?? true,
        },
        memory: files.map((file) => ({
          name: file.name,
          content: file.content,
          sha256: memoryContentHash(file.content),
          localOnly: localOnly.has(file.name),
          updatedAt: file.updatedAt,
        })),
      };
      yield* writePoint(point);
      return summaryOf(point);
    });

  /** The point to restore, checked in full: nothing is written before this succeeds. */
  const readPoint = (projectId: ProjectId, id: string | undefined) =>
    Effect.gen(function* () {
      const pointId =
        id ?? (yield* pointsOf(projectId)).find((point) => point.reason === "before-link")?.id;
      if (pointId === undefined) return yield* new PersonalRestorePointMissingError({ projectId });
      const invalid = (problem: PersonalRestorePointInvalidError["problem"], cause?: unknown) =>
        new PersonalRestorePointInvalidError({
          projectId,
          pointId: pointId.slice(0, 120),
          problem,
          ...(cause === undefined ? {} : { cause }),
        });
      // Only ids this service made: no other file in or outside the folder is ever opened.
      if (!POINT_ID.test(pointId)) return yield* invalid("id");
      const file = fileOf(pointId);
      const present = yield* fileSystem
        .exists(file)
        .pipe(Effect.mapError((cause) => invalid("unreadable", cause)));
      if (!present) return yield* new PersonalRestorePointMissingError({ projectId, pointId });
      const text = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.mapError((cause) => invalid("unreadable", cause)));
      const point = yield* decodePoint(text).pipe(
        Effect.mapError((cause) => invalid("schema", cause)),
      );
      if (point.id !== pointId) return yield* invalid("schema");
      if (point.projectId !== projectId) return yield* invalid("other_assistant");
      const names = new Set(point.memory.map((entry) => entry.name));
      if (
        names.size !== point.memory.length ||
        point.memory.length > PROJECT_MEMORY_MAX_FILES ||
        point.memory.reduce((sum, entry) => sum + byteLength(entry.content), 0) >
          PROJECT_MEMORY_TOTAL_BYTES ||
        point.memory.some(
          (entry) =>
            memoryContentHash(entry.content) !== entry.sha256 ||
            !ProjectWorkspaceService.validateProjectMemory(entry.name, entry.content),
        )
      )
        return yield* invalid("content");
      return point;
    });

  /** Name, icon, instructions, repositories and local-only flags, where they differ. */
  const restoreSettings = (project: Project, point: PointFile) =>
    Effect.gen(function* () {
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const { assistant } = point;
      const repositories = !sameJson(settings.environment.repositories, assistant.repositories);
      const patch = {
        ...(settings.instructions === assistant.instructions
          ? {}
          : { instructions: assistant.instructions }),
        ...(sameJson(settings.localOnlyMemoryFiles ?? [], assistant.localOnlyMemoryFiles)
          ? {}
          : { localOnlyMemoryFiles: assistant.localOnlyMemoryFiles }),
      };
      const meta = {
        ...(project.title === assistant.title ? {} : { title: assistant.title }),
        ...(sameJson(project.projectIcon ?? null, assistant.icon)
          ? {}
          : { projectIcon: assistant.icon }),
      };
      const update = (withRepositories: boolean) => {
        const workspaceSettings = {
          ...patch,
          ...(withRepositories
            ? { environment: { ...settings.environment, repositories: assistant.repositories } }
            : {}),
        };
        return Object.keys(workspaceSettings).length === 0 && Object.keys(meta).length === 0
          ? Effect.void
          : projects
              .update({
                projectId: project.id,
                commandId: CommandId.make(
                  `personal-restore:${point.id}:${settings.revision}${withRepositories ? "" : ":kept-repositories"}`,
                ),
                ...meta,
                ...(Object.keys(workspaceSettings).length === 0
                  ? {}
                  : {
                      workspaceSettings: {
                        expectedRevision: settings.revision,
                        ...workspaceSettings,
                      },
                    }),
                // An undo is not a new edit of what linked seats share: its time stays put,
                // so a seat that joins again never wins over the link with restored settings.
                sharedStampMode: "suppress",
              })
              .pipe(Effect.asVoid);
      };
      const failed = (cause: unknown) =>
        new PersonalRestoreStorageError({
          projectId: project.id,
          stage: "restore-settings",
          cause,
        });
      if (!repositories) {
        yield* update(false).pipe(Effect.mapError(failed));
        return true;
      }
      // A folder that is gone must not block the undo: the rest is restored without the list.
      return yield* update(true).pipe(
        Effect.as(true),
        Effect.catch(() => update(false).pipe(Effect.as(false), Effect.mapError(failed))),
      );
    });

  /**
   * Memory becomes exactly the point's files. A file that goes, or whose
   * content changes, is forgotten first: no tombstone, and the restored file
   * starts with no versions, so no later sync reads it as newer than a peer's.
   */
  const restoreMemory = (projectId: ProjectId, point: PointFile) =>
    Effect.gen(function* () {
      const failed = (name: string) => (cause: unknown) =>
        new PersonalRestoreStorageError({ projectId, stage: "restore-memory", name, cause });
      const current = new Map((yield* readMemory(projectId)).map((file) => [file.name, file]));
      const wanted = new Map(point.memory.map((entry) => [entry.name, entry]));
      const forget = (name: string, revision: number) =>
        workspace
          .forgetMemory({ projectId, name, expectedRevision: revision })
          .pipe(Effect.mapError(failed(name)));
      let removed = 0;
      for (const [name, file] of current) {
        if (wanted.has(name)) continue;
        yield* forget(name, file.revision);
        removed += 1;
      }
      // Shrinking files first, so the store's size limit is never crossed on the way.
      const changes = point.memory
        .filter((entry) => current.get(entry.name)?.content !== entry.content)
        .map((entry) => ({
          entry,
          growth: byteLength(entry.content) - (current.get(entry.name)?.byteLength ?? 0),
        }))
        .toSorted((left, right) => left.growth - right.growth);
      let rewritten = 0;
      let recreated = 0;
      for (const { entry } of changes) {
        const existing = current.get(entry.name);
        if (existing !== undefined) yield* forget(entry.name, existing.revision);
        yield* workspace
          .writeMemory({
            projectId,
            name: entry.name,
            content: entry.content,
            expectedRevision: null,
          })
          .pipe(Effect.mapError(failed(entry.name)));
        if (existing === undefined) recreated += 1;
        else rewritten += 1;
      }
      return { rewritten, recreated, removed };
    });

  const capture: PersonalRestorePoint["Service"]["capture"] = (projectId, reason) =>
    loadAssistant(projectId).pipe(
      Effect.flatMap((project) => captureNow(project, reason)),
      lock.withPermits(1),
    );

  const list: PersonalRestorePoint["Service"]["list"] = (projectId) =>
    pointsOf(projectId).pipe(Effect.map((points) => points.map(summaryOf)));

  const restore: PersonalRestorePoint["Service"]["restore"] = (projectId, id) =>
    Effect.gen(function* () {
      const project = yield* loadAssistant(projectId);
      const point = yield* readPoint(projectId, id);
      const members = project.workspaceSettings?.logicalProject?.members.length ?? 0;
      if (members > 1) return yield* new PersonalRestoreStillLinkedError({ projectId, members });
      const savedBefore = yield* captureNow(project, "before-undo");
      const repositoriesRestored = yield* restoreSettings(project, point);
      const memory = yield* restoreMemory(projectId, point);
      return { restored: summaryOf(point), savedBefore, memory, repositoriesRestored };
    }).pipe(lock.withPermits(1));

  return PersonalRestorePoint.of({ capture, list, restore });
});

export const layer = Layer.effect(PersonalRestorePoint, make);
