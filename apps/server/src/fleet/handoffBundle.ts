import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MACHINE_HANDOFF_BUNDLE_MAX_BYTES,
  MACHINE_HANDOFF_MAX_BYTES,
  MACHINE_HANDOFF_MEMORY_MAX_BYTES,
  MachineHandoffBundle,
  MachineHandoffError,
  PROJECT_MEMORY_MAX_FILES,
  PROJECT_MEMORY_TOTAL_BYTES,
  type MachineHandoffContext,
  type MachineHandoffPreviewMetadata,
  type MachineNicknames,
  type ProjectId,
} from "@specweave-studio/contracts";
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import { conflictCopyName, machineSlug } from "../project/linkedMemoryMerge.ts";
import type * as ProjectWorkspaceService from "../project/ProjectWorkspaceService.ts";

/** Only the metadata fields: a preview request carries them without the bundle. */
export function previewMetadata(
  bundle: Pick<MachineHandoffBundle, keyof MachineHandoffPreviewMetadata>,
): MachineHandoffPreviewMetadata {
  const {
    manifest,
    sourceEnvironmentId,
    sourceProjectId,
    sourceThreadId,
    digest,
    logicalProject,
    coordinatorBinding,
    destination,
  } = bundle;
  return {
    manifest,
    sourceEnvironmentId,
    sourceProjectId,
    sourceThreadId,
    digest,
    ...(logicalProject ? { logicalProject } : {}),
    ...(coordinatorBinding ? { coordinatorBinding } : {}),
    ...(destination ? { destination } : {}),
  };
}

/** Stable digest over the exact retained data, independent of object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${stringifyJson(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function machineHandoffDigest(value: Omit<MachineHandoffBundle, "digest">): string {
  return sha256([canonical(value)], "hex");
}
/** A preview saved before bundles carried the mode still matches the same source. */
export function comparableContext(
  retained: MachineHandoffContext,
  saved: MachineHandoffContext,
): MachineHandoffContext {
  if (saved.runtimeMode !== undefined) return retained;
  const { runtimeMode: _runtimeMode, ...rest } = retained;
  return rest;
}
const isMachineHandoffBundle = Schema.is(MachineHandoffBundle);
/**
 * The conversation keeps its 2 MiB limit; memory notes ride beside it up to the
 * project's 16 MiB, so a project at its memory limit still moves intact.
 */
export function contextWithinLimits(context: MachineHandoffContext): boolean {
  const memoryBytes = context.notes.reduce((sum, note) => sum + Buffer.byteLength(note.content), 0);
  return (
    memoryBytes <= MACHINE_HANDOFF_MEMORY_MAX_BYTES &&
    Buffer.byteLength(stringifyJson({ ...context, notes: [] })) <= MACHINE_HANDOFF_MAX_BYTES
  );
}
export function checkBundle(bundle: MachineHandoffBundle): void {
  if (!isMachineHandoffBundle(bundle)) throw new MachineHandoffError({ code: "invalid" });
  const { digest, ...content } = bundle;
  if (machineHandoffDigest(content) !== digest) throw new MachineHandoffError({ code: "invalid" });
  const { context, ...envelope } = bundle;
  if (
    !contextWithinLimits(context) ||
    Buffer.byteLength(stringifyJson(envelope)) > MACHINE_HANDOFF_MAX_BYTES ||
    Buffer.byteLength(stringifyJson(bundle)) > MACHINE_HANDOFF_BUNDLE_MAX_BYTES
  )
    throw new MachineHandoffError({ code: "too_large" });
}

type Note = MachineHandoffContext["notes"][number];
/** Where one moved note lands; `write` false when that file already holds it. */
export interface NoteImportStep {
  readonly note: Note;
  readonly target: string;
  readonly write: boolean;
}
/**
 * A destination file with the same name and other content wins; the moved
 * version becomes `<base>.conflict-<source machine>.md`, named as linked sync
 * names its copies. Identical content, and a copy already holding it, is skipped.
 */
export function planNoteImport(
  notes: ReadonlyArray<Note>,
  existing: ReadonlyMap<string, string | null>,
  slug: string,
): { readonly steps: ReadonlyArray<NoteImportStep>; bytes: number; files: number } {
  const planned = new Map(existing);
  const steps: NoteImportStep[] = [];
  let bytes = 0;
  for (const note of notes) {
    const current = planned.get(note.name);
    const target =
      current === undefined
        ? { name: note.name, exists: false }
        : current === note.content
          ? { name: note.name, exists: true }
          : conflictCopyName(note.name, slug, (candidate) =>
              planned.get(candidate) === note.content
                ? "same"
                : planned.has(candidate)
                  ? "taken"
                  : "free",
            );
    steps.push({ note, target: target.name, write: !target.exists });
    if (target.exists) continue;
    planned.set(target.name, note.content);
    bytes += Buffer.byteLength(note.content);
  }
  return { steps, bytes, files: steps.filter((step) => step.write).length };
}

type Workspace = ProjectWorkspaceService.ProjectWorkspaceService["Service"];
const storageFailed = () => new MachineHandoffError({ code: "storage_failed" });
/** Only a missing file reads as absent; any other read error fails the move. */
const readNote = (workspace: Workspace, projectId: ProjectId, name: string) =>
  workspace.readMemory({ projectId, name }).pipe(
    Effect.map((file): string | undefined => file.content),
    Effect.catch((error) =>
      error.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(storageFailed()),
    ),
  );
/**
 * Plans the import against the destination's memory before any side effect, and
 * refuses a plan the project's limits cannot hold instead of failing half-way.
 */
export const planDestinationNotes = (
  workspace: Workspace,
  input: {
    readonly projectId: ProjectId;
    readonly notes: ReadonlyArray<Note>;
    readonly sourceEnvironmentId: string;
    /** This machine's names for the others; the copies carry the source's. */
    readonly nicknames: MachineNicknames;
  },
) =>
  Effect.gen(function* () {
    // An isolated project this receive has not created yet holds no memory.
    const memory = yield* workspace.readWorkspace({ projectId: input.projectId }).pipe(
      Effect.map((read) => read.memory),
      Effect.catch((error) =>
        error.code === "not_found"
          ? Effect.succeed({ files: [], totalBytes: 0 })
          : Effect.fail(storageFailed()),
      ),
    );
    const existing = new Map<string, string | null>();
    let totalBytes = memory.totalBytes;
    const incoming = new Set(input.notes.map((note) => note.name));
    for (const file of memory.files) {
      // Contents matter only where a moved note or its conflict copy may land.
      if (!incoming.has(file.name) && !file.name.includes(".conflict-")) {
        existing.set(file.name, null);
        continue;
      }
      const content = yield* readNote(workspace, input.projectId, file.name);
      if (content !== undefined) existing.set(file.name, content);
      else totalBytes -= file.byteLength;
    }
    const plan = planNoteImport(
      input.notes,
      existing,
      machineSlug(
        normalizeMachineNickname(input.nicknames[input.sourceEnvironmentId]?.name ?? "") ||
          undefined,
        input.sourceEnvironmentId,
      ),
    );
    if (
      totalBytes + plan.bytes > PROJECT_MEMORY_TOTAL_BYTES ||
      existing.size + plan.files > PROJECT_MEMORY_MAX_FILES
    )
      return yield* new MachineHandoffError({ code: "destination_memory_full" });
    return plan.steps;
  });
/**
 * Writes the planned notes, then reads every one back: the move fails unless each
 * note, or its conflict copy, holds the bundle's exact content.
 */
export const importDestinationNotes = (
  workspace: Workspace,
  projectId: ProjectId,
  steps: ReadonlyArray<NoteImportStep>,
) =>
  Effect.gen(function* () {
    for (const step of steps)
      if (step.write)
        yield* workspace
          .writeMemory({
            projectId,
            name: step.target,
            content: step.note.content,
            expectedRevision: null,
          })
          .pipe(Effect.mapError(storageFailed));
    let mismatch = false;
    for (const step of steps) {
      const stored = yield* readNote(workspace, projectId, step.target);
      if (stored !== undefined && sha256([stored], "hex") === sha256([step.note.content], "hex"))
        continue;
      mismatch = true;
      // A file this import created is the move's own; removing a bad one lets the retry
      // write it again instead of keeping it as the destination's version.
      if (step.write && stored !== undefined)
        yield* workspace.readMemory({ projectId, name: step.target }).pipe(
          Effect.flatMap((file) =>
            workspace.deleteMemory({
              projectId,
              name: step.target,
              expectedRevision: file.revision,
            }),
          ),
          Effect.ignore,
        );
    }
    if (mismatch) return yield* new MachineHandoffError({ code: "memory_mismatch" });
    return steps.length;
  });
