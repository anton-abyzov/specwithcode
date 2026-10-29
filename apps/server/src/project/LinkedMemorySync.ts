import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  type LinkedMemoryExport,
  type LinkedMemoryExportInput,
  type LinkedMemoryFile,
  type LinkedMemoryMergeInput,
  type LinkedMemoryMergeResult,
  LINKED_MEMORY_TOMBSTONE_LIMIT,
  PROJECT_LINK_MAX_BYTES,
  ProjectLinkError,
  type ProjectId,
  ProjectMemoryName,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import {
  applyMergeStepToHistory,
  type LocalMemoryFile,
  localFileView,
  machineSlug,
  MEMORY_INDEX_NAME,
  type MemoryMergeStep,
  planMemoryMerge,
} from "./linkedMemoryMerge.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

/**
 * Both halves of two-way memory replication between linked members. The client
 * exports memory from both members of a pair first, then merges each export
 * into the other side (`linkedMemoryMerge.ts` decides every file). A merge that
 * fails on one side leaves both stores valid, and the next pass converges.
 */
export class LinkedMemorySync extends Context.Service<
  LinkedMemorySync,
  {
    readonly memoryExport: (
      input: LinkedMemoryExportInput,
    ) => Effect.Effect<LinkedMemoryExport, ProjectLinkError>;
    readonly memoryMerge: (
      input: LinkedMemoryMergeInput,
    ) => Effect.Effect<LinkedMemoryMergeResult, ProjectLinkError>;
  }
>()("specweave-studio/project/LinkedMemorySync") {}

const fail = (code: ProjectLinkError["code"], detail?: string) =>
  Effect.fail(new ProjectLinkError({ code, ...(detail ? { detail } : {}) }));
const storageFailed = () => new ProjectLinkError({ code: "storage_failed" });
const byteLength = (content: string) => new TextEncoder().encode(content).length;
const isSha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);
const isMemoryName = Schema.is(ProjectMemoryName);
type ExportEntry = readonly [name: string, file: { readonly updatedAt: string }];
/** `MEMORY.md` first, then the most recently written, so a cut-short export keeps what matters. */
const exportOrder = ([leftName, left]: ExportEntry, [rightName, right]: ExportEntry) =>
  Number(rightName === MEMORY_INDEX_NAME) - Number(leftName === MEMORY_INDEX_NAME) ||
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  (leftName < rightName ? -1 : 1);
/**
 * A page ends at the last file it sent; the next starts after it in export order.
 * The page number picks that page's slice of tombstones; an empty name means no file was sent yet.
 */
interface ExportCursor {
  readonly after: ExportEntry | undefined;
  readonly page: number;
}
const encodeCursor = (after: ExportEntry | undefined, page: number) =>
  JSON.stringify([after?.[0] ?? "", after?.[1].updatedAt ?? "", page]);
const decodeCursor = (cursor: string): ExportCursor | undefined => {
  try {
    const value: unknown = JSON.parse(cursor);
    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string")
      return undefined;
    const page = value.length === 2 ? 1 : value[2];
    if (value.length > 3 || !Number.isSafeInteger(page) || (page as number) < 1) return undefined;
    if (value[0] === "" && value[1] === "") return { after: undefined, page: page as number };
    if (Number.isNaN(Date.parse(value[1]))) return undefined;
    return { after: [value[0], { updatedAt: value[1] }], page: page as number };
  } catch {
    // Not JSON: refused below.
  }
  return undefined;
};
/** The same summary the client compares when a peer sends no digest. */
const memoryDigest = (
  files: ReadonlyMap<string, LocalMemoryFile>,
  tombstones: ReadonlyArray<{ readonly name: string }>,
) =>
  LinkedMemoryHistory.memoryContentHash(
    JSON.stringify([
      [...files].map(([name, file]) => [name, file.sha]).toSorted(),
      tombstones.map((tombstone) => tombstone.name).toSorted(),
    ]),
  );

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const histories = yield* LinkedMemoryHistory.LinkedMemoryHistory;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const load = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(storageFailed),
      Effect.flatMap((found) =>
        Option.isSome(found) && found.value.deletedAt === null
          ? Effect.succeed(found.value)
          : fail("not_found"),
      ),
    );
  const machineLabel = environment.getDescriptor.pipe(
    Effect.map((descriptor): string | undefined => descriptor.label),
  );

  /** Every memory file with its hash and the versions it has had here. */
  const readLocal = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const read = yield* workspace
        .readWorkspace({ projectId })
        .pipe(Effect.mapError(storageFailed));
      const state = yield* histories.read(projectId).pipe(Effect.mapError(storageFailed));
      const files = new Map<string, LocalMemoryFile>();
      for (const summary of read.memory.files) {
        const found = yield* workspace
          .readMemory({ projectId, name: summary.name })
          .pipe(Effect.option);
        if (Option.isNone(found)) continue;
        const sha = LinkedMemoryHistory.memoryContentHash(found.value.content);
        const view = localFileView(state.files[summary.name], {
          sha,
          updatedAt: found.value.updatedAt,
        });
        files.set(summary.name, {
          content: found.value.content,
          sha,
          revision: found.value.revision,
          updatedAt: view.updatedAt,
          history: view.history.filter(isSha256),
        });
      }
      return { files, state };
    });

  /**
   * One page of this copy's memory, at most `PROJECT_LINK_MAX_BYTES` of content;
   * `nextCursor` asks for the rest. Tombstones come with the first page only.
   */
  const memoryExport: LinkedMemorySync["Service"]["memoryExport"] = (input) =>
    Effect.gen(function* () {
      const project = yield* load(input.projectId);
      // A personal assistant's memory never leaves its machine.
      if (isPersonalAssistantProject(project)) return yield* fail("not_code_project");
      const identity = project.workspaceSettings?.logicalProject;
      if (!identity) return yield* fail("not_linked");
      const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      if (input.cursor !== undefined && !cursor)
        return yield* fail("invalid", "The memory page cursor is not valid.");
      const environmentId = yield* environment.getEnvironmentId;
      const label = yield* machineLabel;
      const local = yield* readLocal(project.id);
      const tombstones = Object.entries(local.state.tombstones)
        .filter(
          ([name]) => name !== MEMORY_INDEX_NAME && !local.files.has(name) && isMemoryName(name),
        )
        .toSorted(([, a], [, b]) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
        .map(([name, tombstone]) => ({
          name,
          deletedAt: tombstone.deletedAt,
          history: tombstone.history.filter(isSha256),
        }));
      const header = {
        logicalProjectId: identity.id,
        environmentId,
        ...(label ? { machineLabel: label.slice(0, 200) } : {}),
        digest: memoryDigest(local.files, tombstones),
      };
      if (input.digestOnly)
        return { ...header, files: [], tombstones: [], truncated: local.files.size > 0 };
      const after = cursor?.after;
      const page = cursor?.page ?? 0;
      const files: LinkedMemoryFile[] = [];
      let bytes = 0;
      let filesLeft = false;
      for (const [name, file] of [...local.files].toSorted(exportOrder)) {
        if (after && exportOrder(after, [name, file]) >= 0) continue;
        const size = byteLength(file.content);
        if (bytes + size > PROJECT_LINK_MAX_BYTES) {
          // A file larger than a page is skipped, as before; anything else waits for the next page.
          if (files.length === 0) continue;
          filesLeft = true;
          break;
        }
        bytes += size;
        files.push({
          name,
          content: file.content,
          contentSha256: file.sha,
          updatedAt: file.updatedAt,
          history: file.history,
        });
      }
      // Older peers read only the first page, which carries the newest tombstones as before.
      const start = page * LINKED_MEMORY_TOMBSTONE_LIMIT;
      const tombstonesLeft = tombstones.length > start + LINKED_MEMORY_TOMBSTONE_LIMIT;
      const last = files.at(-1);
      const nextAfter: ExportEntry | undefined = last ? [last.name, last] : after;
      return {
        ...header,
        files,
        tombstones: tombstones.slice(start, start + LINKED_MEMORY_TOMBSTONE_LIMIT),
        truncated: filesLeft || tombstonesLeft,
        ...(filesLeft || tombstonesLeft ? { nextCursor: encodeCursor(nextAfter, page + 1) } : {}),
      };
    });

  /** Runs one planned step here; false when the store refused it (the next pass retries). */
  const applyStep = (projectId: ProjectId, step: MemoryMergeStep) =>
    Effect.gen(function* () {
      switch (step.kind) {
        case "write": {
          if (step.conflictCopy?.write) {
            const saved = yield* workspace
              .writeMemory({
                projectId,
                name: step.conflictCopy.name,
                content: step.conflictCopy.content,
                expectedRevision: null,
              })
              .pipe(Effect.option);
            // Never replace a version whose copy could not be kept.
            if (Option.isNone(saved)) return false;
          }
          const written = yield* workspace
            .writeMemory({
              projectId,
              name: step.name,
              content: step.content,
              expectedRevision: step.expectedRevision,
            })
            .pipe(Effect.option);
          return Option.isSome(written);
        }
        case "delete":
          return Option.isSome(
            yield* workspace
              .deleteMemory({ projectId, name: step.name, expectedRevision: step.expectedRevision })
              .pipe(Effect.option),
          );
        case "history":
        case "tombstone":
          return true;
      }
    });

  const memoryMerge: LinkedMemorySync["Service"]["memoryMerge"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        // ...nor takes another machine's in.
        if (isPersonalAssistantProject(project)) return yield* fail("not_code_project");
        // A moving project's bundle is already read, so a merge now would miss the move. The
        // peer keeps its version and syncs it with the copy the project moves to.
        if (project.workspaceSettings?.coordinatorBinding?.state === "transferring")
          return yield* fail("handoff_in_progress");
        const identity = project.workspaceSettings?.logicalProject;
        if (!identity || identity.id !== input.export.logicalProjectId)
          return yield* fail("not_linked");
        const environmentId = yield* environment.getEnvironmentId;
        if (
          input.peer.environmentId === environmentId ||
          input.export.environmentId === environmentId
        )
          return yield* fail("same_machine");
        if (input.peer.environmentId !== input.export.environmentId)
          return yield* fail("invalid", "The memory came from another machine than the one named.");
        if (
          !identity.members.some(
            (member) =>
              member.environmentId === input.peer.environmentId &&
              member.projectId === input.peer.projectId,
          )
        )
          return yield* fail("not_member");
        let bytes = 0;
        for (const file of input.export.files) bytes += byteLength(file.content);
        if (bytes > PROJECT_LINK_MAX_BYTES) return yield* fail("too_large");
        if (
          input.export.files.some(
            (file) => LinkedMemoryHistory.memoryContentHash(file.content) !== file.contentSha256,
          )
        )
          return yield* fail("invalid", "A memory file does not match its hash.");

        const local = yield* readLocal(project.id);
        const plan = planMemoryMerge(
          {
            environmentId,
            machineSlug: machineSlug(yield* machineLabel, environmentId),
            files: local.files,
            tombstones: local.state.tombstones,
          },
          input.export,
        );
        const applied: string[] = [];
        const conflicts: Array<{ name: string; copy: string }> = [];
        const skipped: string[] = [];
        const done: MemoryMergeStep[] = [];
        for (const step of plan.steps) {
          if (!(yield* applyStep(project.id, step))) {
            skipped.push(step.name);
            continue;
          }
          done.push(step);
          if (step.kind === "write" && step.conflictCopy)
            conflicts.push({ name: step.name, copy: step.conflictCopy.name });
          else if (step.kind === "write" || step.kind === "delete") applied.push(step.name);
        }
        // The writes above already recorded their versions; this sets the merged ones.
        if (done.length > 0)
          yield* histories
            .modify(project.id, (state) => done.reduce(applyMergeStepToHistory, state))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not record merged project memory versions", {
                  projectId: project.id,
                  cause,
                }),
              ),
            );
        return { applied, conflicts, kept: [...plan.kept], skipped };
      }),
    );

  return LinkedMemorySync.of({ memoryExport, memoryMerge });
});

export const layer = Layer.effect(LinkedMemorySync, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
