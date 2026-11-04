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
  PROJECT_MEMORY_FILE_BYTES,
  ProjectMemoryName,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
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
import { canonicalSides, commonAncestors, mergeThreeWay } from "./linkedMemoryThreeWay.ts";
import { mergeRepositoryNotes, REPOSITORY_NOTE } from "./ProjectRepositoryNote.ts";
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
    /** What a coordinator move carries so its notes can merge on the other machine. */
    readonly noteVersions: (
      projectId: ProjectId,
    ) => Effect.Effect<MovedNoteVersions, ProjectLinkError>;
    /**
     * Merges a moved coordinator's notes here, inside the receive's own lock, and
     * returns the names that are settled: only the rest still need importing.
     */
    readonly mergeMovedNotes: (input: {
      readonly projectId: ProjectId;
      readonly logicalProjectId: string;
      readonly sourceEnvironmentId: string;
      readonly sourceLabel: string | undefined;
      readonly notes: ReadonlyArray<{ readonly name: string; readonly content: string }>;
      readonly versions: MovedNoteVersions;
    }) => Effect.Effect<ReadonlySet<string>, ProjectLinkError>;
  }
>()("specweave-studio/project/LinkedMemorySync") {}

export type MovedNoteVersions = Readonly<
  Record<string, { readonly history: ReadonlyArray<string>; readonly updatedAt: string }>
>;

const fail = (code: ProjectLinkError["code"], detail?: string) =>
  Effect.fail(new ProjectLinkError({ code, ...(detail ? { detail } : {}) }));
const storageFailed = () => new ProjectLinkError({ code: "storage_failed" });
const byteLength = (content: string) => new TextEncoder().encode(content).length;
const isSha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);
const isMemoryName = Schema.is(ProjectMemoryName);
interface LocalRead {
  readonly files: ReadonlyMap<string, LocalMemoryFile>;
}
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
  // Absent in tests and tools that run without the update hold: never held.
  const updateHold = yield* ServiceUpdateHold.optional;

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

  // Every note write bumps its revision, so a known revision never needs hashing again.
  const hashes = new Map<string, { readonly revision: number; readonly sha: string }>();
  const hashOf = (
    projectId: ProjectId,
    file: { readonly name: string; readonly revision: number; readonly content: string },
  ) => {
    const key = `${projectId}\0${file.name}`;
    const known = hashes.get(key);
    if (known?.revision === file.revision) return known.sha;
    const sha = LinkedMemoryHistory.memoryContentHash(file.content);
    hashes.set(key, { revision: file.revision, sha });
    return sha;
  };

  /** Every memory file with its hash and the versions it has had here. */
  const readLocal = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const state = yield* histories.read(projectId).pipe(Effect.mapError(storageFailed));
      const files = new Map<string, LocalMemoryFile>();
      let savedVersion = false;
      for (const found of yield* workspace
        .readMemoryFiles({ projectId })
        .pipe(Effect.mapError(storageFailed))) {
        const sha = hashOf(projectId, found);
        const view = localFileView(state.files[found.name], {
          sha,
          updatedAt: found.updatedAt,
        });
        files.set(found.name, {
          content: found.content,
          sha,
          revision: found.revision,
          updatedAt: view.updatedAt,
          history: view.history.filter(isSha256),
        });
        // Every version a peer can see stays readable here as a later merge's base.
        savedVersion =
          (yield* histories
            .saveVersion(projectId, sha, found.content)
            .pipe(Effect.orElseSucceed(() => false))) || savedVersion;
      }
      if (savedVersion)
        yield* histories
          .pruneVersions(
            projectId,
            new Set(
              [...files.values(), ...Object.values(state.tombstones)].flatMap(
                (file) => file.history,
              ),
            ),
          )
          .pipe(Effect.ignore);
      return { files, state };
    });

  /** The text merge of each file this export edited alongside this copy. */
  const threeWayFor = (projectId: ProjectId, local: LocalRead, remote: LinkedMemoryExport) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const here = {
        environmentId,
        label: machineSlug(yield* machineLabel, environmentId),
      };
      const there = {
        environmentId: remote.environmentId,
        label: machineSlug(remote.machineLabel, remote.environmentId),
      };
      const bases = new Map<string, string | null>();
      for (const file of remote.files) {
        const mine = local.files.get(file.name);
        if (!mine || mine.sha === file.contentSha256) continue;
        // Kept for a later merge: this machine may never hold the peer's version as its own.
        yield* histories
          .saveVersion(projectId, file.contentSha256, file.content)
          .pipe(Effect.ignore);
        const [first, second] = canonicalSides(
          { environmentId: here.environmentId, history: mine.history },
          {
            environmentId: there.environmentId,
            history: [...file.history, file.contentSha256],
          },
        );
        // Only the newest shared version: an older base would drop a line re-added since.
        const [ancestor] = commonAncestors(first.history, second.history);
        const base = ancestor
          ? yield* histories
              .readVersion(projectId, ancestor)
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        bases.set(file.name, base ?? null);
      }
      return (name: string, mine: string, theirs: string) => {
        const base = bases.get(name);
        if (base === undefined) return undefined;
        const [left, right] = canonicalSides(
          { ...here, content: mine },
          { ...there, content: theirs },
        );
        const content =
          (name === REPOSITORY_NOTE
            ? mergeRepositoryNotes(base, left.content, right.content)
            : null) ?? mergeThreeWay(base, left, right);
        return byteLength(content) > PROJECT_MEMORY_FILE_BYTES
          ? undefined
          : { content, sha: LinkedMemoryHistory.memoryContentHash(content) };
      };
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
        // Each history hash also takes room in the answer.
        const size = byteLength(file.content) + file.history.length * 67;
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

  /** Applies a peer's files here. The caller holds the project's lock. */
  const mergeHere = (projectId: ProjectId, remote: LinkedMemoryExport) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const local = yield* readLocal(projectId);
      const plan = planMemoryMerge(
        {
          environmentId,
          machineSlug: machineSlug(yield* machineLabel, environmentId),
          files: local.files,
          tombstones: local.state.tombstones,
          threeWay: yield* threeWayFor(projectId, local, remote),
        },
        remote,
      );
      const applied: string[] = [];
      const conflicts: Array<{ name: string; copy: string }> = [];
      const skipped: string[] = [];
      const done: MemoryMergeStep[] = [];
      for (const step of plan.steps) {
        if (!(yield* applyStep(projectId, step))) {
          skipped.push(step.name);
          continue;
        }
        done.push(step);
        if (step.kind === "write")
          yield* histories.saveVersion(projectId, step.sha, step.content).pipe(Effect.ignore);
        if (step.kind === "write" && step.conflictCopy)
          conflicts.push({ name: step.name, copy: step.conflictCopy.name });
        else if (step.kind === "write" || step.kind === "delete") applied.push(step.name);
      }
      // The writes above already recorded their versions; this sets the merged ones.
      if (done.length > 0)
        yield* histories
          .modify(projectId, (state) => done.reduce(applyMergeStepToHistory, state))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record merged project memory versions", {
                projectId,
                cause,
              }),
            ),
          );
      return { applied, conflicts, kept: [...plan.kept], skipped };
    });

  const noteVersions: LinkedMemorySync["Service"]["noteVersions"] = (projectId) =>
    readLocal(projectId).pipe(
      Effect.map(({ files }) =>
        Object.fromEntries(
          [...files].map(([name, file]) => [
            name,
            {
              history: file.history,
              updatedAt: file.updatedAt,
            },
          ]),
        ),
      ),
    );

  const mergeMovedNotes: LinkedMemorySync["Service"]["mergeMovedNotes"] = (input) =>
    Effect.gen(function* () {
      const project = yield* load(input.projectId);
      if (project.workspaceSettings?.logicalProject?.id !== input.logicalProjectId)
        return new Set<string>();
      const files = input.notes.flatMap((note) => {
        const versions = input.versions[note.name];
        return versions
          ? [
              {
                name: note.name,
                content: note.content,
                contentSha256: LinkedMemoryHistory.memoryContentHash(note.content),
                updatedAt: versions.updatedAt,
                history: versions.history.filter(isSha256),
              },
            ]
          : [];
      });
      const result = yield* mergeHere(input.projectId, {
        logicalProjectId: input.logicalProjectId,
        environmentId: input.sourceEnvironmentId as LinkedMemoryExport["environmentId"],
        ...(input.sourceLabel ? { machineLabel: input.sourceLabel.slice(0, 200) } : {}),
        files,
        tombstones: [],
        truncated: false,
      });
      // A note whose merge matched what is here changed only its history, and is settled too.
      const open = new Set([...result.skipped, ...result.conflicts.map(({ name }) => name)]);
      return new Set(files.map((file) => file.name).filter((name) => !open.has(name)));
    });

  const memoryMerge: LinkedMemorySync["Service"]["memoryMerge"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        // While an update is held or being verified, nothing is merged in: the update proves
        // `project_memory` unchanged across its restart. The peer route already refuses while
        // held; this covers the app window's merge. Its next pass merges after the hold.
        if (yield* updateHold.isHeld)
          return yield* fail("paused", "This machine is updating; try again in a minute.");
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

        return yield* mergeHere(project.id, input.export);
      }),
    );

  return LinkedMemorySync.of({ memoryExport, memoryMerge, noteVersions, mergeMovedNotes });
});

export const layer = Layer.effect(LinkedMemorySync, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
