import { CommandId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProjectService } from "../project/ProjectService.ts";
import type { DestinationRecord } from "./folderTransfer/destinationService.ts";
import { copiedProjectId } from "./FolderCopyHandoff.ts";
import { verifyCopiedProjectFolder } from "./folderCopyScope.ts";

class CopyRegistrationError extends Schema.TaggedError<CopyRegistrationError>()(
  "CopyRegistrationError",
  { message: Schema.String },
) {}

export const makeCopyRegistration =
  (projects: ProjectService["Service"]) => (record: DestinationRecord) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* Effect.tryPromise({
        try: () => verifyCopiedProjectFolder(record.targetFolder, record.projectRelativePath),
        catch: () =>
          new CopyRegistrationError({
            message: "The copied coordinator folder is missing or unsafe.",
          }),
      });
      const existing = yield* projects.getByWorkspaceRoot(workspaceRoot);
      if (Option.isSome(existing)) {
        if (record.requestedProjectId !== null && existing.value.id !== record.requestedProjectId)
          return yield* new CopyRegistrationError({
            message: "Another project is registered for this folder; choose it as the target.",
          });
        return existing.value.id as string;
      }
      const snapshot = yield* projects.snapshot.pipe(Effect.option);
      const taken =
        Option.isSome(snapshot) &&
        snapshot.value.projects.some(
          (candidate) => candidate.deletedAt == null && candidate.title === record.title,
        );
      const created = yield* projects.bootstrap({
        commandId: CommandId.make(`folder-copy:${record.operationId}`),
        projectId:
          record.requestedProjectId === null
            ? copiedProjectId(record.operationId)
            : ProjectId.make(record.requestedProjectId),
        title: taken ? `${record.title} (${record.sourceMachine})` : record.title,
        workspaceRoot,
      });
      return created.project.id as string;
    });
