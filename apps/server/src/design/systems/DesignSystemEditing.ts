// @effect-diagnostics nodeBuiltinImport:off - Resolves the project checkout a system's sources are read from.
/**
 * Editing a design system by hand, and the files kept beside it.
 *
 * - `create` starts an empty system, with Light and Dark unless the person
 *   picks modes. `apply` runs the shared reducer under the store's revision
 *   check, so a stale editor gets `conflict` with the revision on disk.
 * - Stored files live in the system's `files/` folder (`SystemFilesStore`).
 * - Source files are the ones `system.sources` records with kind `file`. They
 *   are read from the project checkout through `readInsideRoot`, with its
 *   exclusions and 2 MiB cap; a path the system does not list is never read.
 *
 * People write here, from the owner's sessions and from members alike, as
 * with renaming a system; agents keep proposing through import. Roots come
 * from `DesignSystemRoots`, which resolves an owner the way the design service
 * does, so only owners on this machine are reached.
 */
import * as NodeFSP from "node:fs/promises";

import {
  DESIGN_SYSTEM_FILES_MAX_BYTES,
  DESIGN_SYSTEM_FILES_MAX_COUNT,
  DesignError,
  type DesignSystem,
  type DesignSystemAddress,
  type DesignSystemApplyInput,
  type DesignSystemCreateInput,
  type DesignSystemFile,
  type DesignSystemFileDeleteInput,
  type DesignSystemFileDeleteResult,
  type DesignSystemFileMoveInput,
  type DesignSystemFilePutInput,
  type DesignSystemFilePutResult,
  type DesignSystemFileReadInput,
  type DesignSystemFileReadResult,
  type DesignSystemFilesResult,
  type DesignSystemGetResult,
} from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import {
  DESIGN_SYSTEM_DEFAULT_MODES,
  applyDesignSystemOperations,
  newDesignSystem,
} from "@specweave-studio/shared/designSystemOps";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Store from "../DesignStore.ts";
import {
  type DesignOwnerRoots,
  type DesignSystemCaller,
  DesignSystemRoots,
} from "./DesignSystemService.ts";
import {
  type RootPathProblem,
  RootPathError,
  readInsideRoot,
  statInsideRoot,
} from "./scanCandidates.ts";
import * as SystemFiles from "./SystemFilesStore.ts";

export class DesignSystemEditing extends Context.Service<
  DesignSystemEditing,
  {
    /** A new, empty system in `owner`. People only. */
    readonly create: (
      caller: DesignSystemCaller,
      input: DesignSystemCreateInput,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    /** Operations at `expectedRevision`, stored as the next revision. People only. */
    readonly apply: (
      caller: DesignSystemCaller,
      input: DesignSystemApplyInput,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    /** Stored files, then the recorded source files of a project's system. */
    readonly files: (
      caller: DesignSystemCaller,
      input: DesignSystemAddress,
    ) => Effect.Effect<DesignSystemFilesResult, DesignError>;
    readonly fileRead: (
      caller: DesignSystemCaller,
      input: DesignSystemFileReadInput,
    ) => Effect.Effect<DesignSystemFileReadResult, DesignError>;
    /** Stored files only, people only, like the rest of the writes. */
    readonly filePut: (
      caller: DesignSystemCaller,
      input: DesignSystemFilePutInput,
    ) => Effect.Effect<DesignSystemFilePutResult, DesignError>;
    readonly fileDelete: (
      caller: DesignSystemCaller,
      input: DesignSystemFileDeleteInput,
    ) => Effect.Effect<DesignSystemFileDeleteResult, DesignError>;
    readonly fileMove: (
      caller: DesignSystemCaller,
      input: DesignSystemFileMoveInput,
    ) => Effect.Effect<DesignSystemFilePutResult, DesignError>;
  }
>()("specweave-studio/design/systems/DesignSystemEditing") {}

const isDesignError = Schema.is(DesignError);

/** What a source file that cannot be read is, for the file list and for a read. */
const SOURCE_PROBLEMS: Readonly<
  Record<RootPathProblem, { readonly code: DesignError["code"]; readonly unavailable: string }>
> = {
  "outside-root": { code: "forbidden", unavailable: "Outside the project." },
  "symlink-outside-root": { code: "forbidden", unavailable: "Links outside the project." },
  missing: { code: "not_found", unavailable: "Missing from the checkout." },
  "too-large": { code: "too_large", unavailable: "Over 2 MiB, too large to open here." },
  "not-a-file": { code: "invalid", unavailable: "A folder, not a file." },
  excluded: {
    code: "forbidden",
    unavailable: "Never read: hidden folders, generated output and secret files are excluded.",
  },
  budget: { code: "operation_failed", unavailable: "Could not be read now." },
};

const toDesignError = (cause: unknown): DesignError => {
  if (isDesignError(cause)) return cause;
  if (cause instanceof Store.DesignStoreProblem) {
    return new DesignError({
      code: cause.code,
      detail: cause.message,
      ...(cause.currentRevision === undefined ? {} : { currentRevision: cause.currentRevision }),
    });
  }
  if (cause instanceof RootPathError) {
    const problem = SOURCE_PROBLEMS[cause.reason];
    return new DesignError({ code: problem.code, detail: `${cause.path}: ${problem.unavailable}` });
  }
  return new DesignError({
    code: "operation_failed",
    detail: "The design system could not be read or saved. Try again.",
  });
};

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toDesignError });

const invalid = (detail: string) => new DesignError({ code: "invalid", detail });

/** Agents read, and propose changes through import; only people write here. */
const peopleOnly = (caller: DesignSystemCaller, detail: string) =>
  caller.audience === "agents"
    ? Effect.fail(new DesignError({ code: "forbidden", detail }))
    : Effect.void;

const refOf = (resolved: DesignOwnerRoots, systemId: string) => ({
  owner: resolved.owner,
  systemId,
  path: `${resolved.refPrefix}${systemId}/${Store.DESIGN_SYSTEM_FILE}`,
});

const SOURCE_TYPES: Readonly<Record<string, string>> = {
  ts: "text/typescript",
  tsx: "text/typescript",
  mts: "text/typescript",
  cts: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  scss: "text/x-scss",
  sass: "text/x-sass",
  less: "text/x-less",
};

/** Sources are read as text: a known type by extension, else plain text. */
const sourceMimeType = (path: string) => {
  const stored = SystemFiles.systemFileMimeType(path);
  if (stored !== "application/octet-stream") return stored;
  return SOURCE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";
};

/** Paths `system` was read from in its owner's checkout, each once, sorted. */
const sourcePaths = (system: DesignSystem) =>
  [
    ...new Set(
      system.sources.filter((source) => source.kind === "file").map((source) => source.location),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

/** One recorded source in the file list, with why it cannot be opened when it cannot. */
const sourceEntry = async (realRoot: string | null, path: string): Promise<DesignSystemFile> => {
  const entry = { path, origin: "source" as const, mimeType: sourceMimeType(path) };
  if (realRoot === null) {
    return { ...entry, bytes: 0, unavailable: SOURCE_PROBLEMS.missing.unavailable };
  }
  try {
    const stat = await statInsideRoot(realRoot, path);
    return { ...entry, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (!(error instanceof RootPathError)) throw error;
    return { ...entry, bytes: 0, unavailable: SOURCE_PROBLEMS[error.reason].unavailable };
  }
};

/** Base64 as browsers write it; anything else is refused rather than half-decoded. */
const decodeBase64 = (data: string) =>
  data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ? Effect.succeed(Buffer.from(data, "base64"))
    : Effect.fail(invalid("The file data is not base64."));

const make = Effect.gen(function* () {
  const roots = yield* DesignSystemRoots;

  const create: DesignSystemEditing["Service"]["create"] = (caller, input) =>
    Effect.gen(function* () {
      yield* peopleOnly(
        caller,
        "Agents cannot create design systems here. Propose one through import, or ask the user.",
      );
      if (input.name.trim().length === 0) {
        return yield* invalid("A design system needs a name.");
      }
      const modes = input.modes ?? DESIGN_SYSTEM_DEFAULT_MODES;
      const ids = new Set<string>();
      for (const mode of modes) {
        if (mode.name.trim().length === 0) return yield* invalid("Every mode needs a name.");
        if (ids.has(mode.id)) return yield* invalid(`Two modes have the id ${mode.id}.`);
        ids.add(mode.id);
      }
      const resolved = yield* roots.resolveForWrite(caller, input.owner);
      const now = DateTime.formatIso(yield* DateTime.now);
      const system = newDesignSystem({
        id: designId("s"),
        name: input.name,
        description: input.description,
        modes,
        now,
      });
      const stored = yield* attempt(() =>
        Store.writeDesignSystem(resolved.designRoot, system, {
          expectedRevision: null,
          actor: caller.actor,
          now,
        }),
      );
      return { ref: refOf(resolved, stored.id), system: stored };
    }).pipe(Effect.withSpan("DesignSystemEditing.create"));

  const apply: DesignSystemEditing["Service"]["apply"] = (caller, input) =>
    Effect.gen(function* () {
      yield* peopleOnly(
        caller,
        "Agents cannot edit design systems here. Propose a change through import, or ask the user.",
      );
      const resolved = yield* roots.resolve(caller, input.owner);
      const now = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* attempt(() =>
        Store.updateDesignSystem(resolved.designRoot, input.systemId, {
          expectedRevision: input.expectedRevision,
          actor: caller.actor,
          now,
          change: (current) => {
            const outcome = applyDesignSystemOperations(current, input.operations, {
              actor: caller.actor,
              now,
            });
            if (outcome.ok) return outcome.system;
            throw new Store.DesignStoreProblem(
              outcome.code,
              input.operations.length > 1
                ? `Operation ${outcome.index + 1}: ${outcome.detail}`
                : outcome.detail,
            );
          },
        }),
      );
      return { ref: refOf(resolved, stored.id), system: stored };
    }).pipe(Effect.withSpan("DesignSystemEditing.apply"));

  const files: DesignSystemEditing["Service"]["files"] = (caller, input) =>
    Effect.gen(function* () {
      const resolved = yield* roots.resolve(caller, input.owner);
      const system = yield* attempt(() =>
        Store.readDesignSystem(resolved.designRoot, input.systemId),
      );
      const stored = yield* attempt(() =>
        SystemFiles.listSystemFiles(resolved.designRoot, input.systemId),
      );
      // A Playground has no checkout, so its systems have no source files to show.
      const projectRoot = resolved.projectRoot;
      const sources =
        projectRoot === null
          ? []
          : yield* attempt(async () => {
              const realRoot = await NodeFSP.realpath(projectRoot).catch(() => null);
              const entries: DesignSystemFile[] = [];
              for (const path of sourcePaths(system)) {
                entries.push(await sourceEntry(realRoot, path));
              }
              return entries;
            });
      return {
        files: [...stored.files, ...sources],
        usedBytes: stored.usedBytes,
        limitBytes: DESIGN_SYSTEM_FILES_MAX_BYTES,
        limitFiles: DESIGN_SYSTEM_FILES_MAX_COUNT,
      };
    }).pipe(Effect.withSpan("DesignSystemEditing.files"));

  const fileRead: DesignSystemEditing["Service"]["fileRead"] = (caller, input) =>
    Effect.gen(function* () {
      const resolved = yield* roots.resolve(caller, input.owner);
      if (input.origin === "stored") {
        const read = yield* attempt(() =>
          SystemFiles.readSystemFile(resolved.designRoot, input.systemId, input.path),
        );
        const text = SystemFiles.isTextSystemFile(input.path);
        return {
          file: read.file,
          encoding: text ? ("utf8" as const) : ("base64" as const),
          data: read.bytes.toString(text ? "utf8" : "base64"),
        };
      }
      const projectRoot = resolved.projectRoot;
      if (projectRoot === null) {
        return yield* invalid("A Playground design system has no project files to open.");
      }
      const system = yield* attempt(() =>
        Store.readDesignSystem(resolved.designRoot, input.systemId),
      );
      // Only a path the system records is read, never one the client makes up.
      if (!sourcePaths(system).includes(input.path)) {
        return yield* new DesignError({
          code: "forbidden",
          detail: `This design system was not read from ${input.path}, so it cannot be opened here.`,
        });
      }
      const source = yield* attempt(async () =>
        readInsideRoot(await NodeFSP.realpath(projectRoot), input.path),
      );
      return {
        file: {
          path: input.path,
          origin: "source" as const,
          bytes: Buffer.byteLength(source.text),
          mimeType: sourceMimeType(input.path),
        },
        encoding: "utf8" as const,
        data: source.text,
      };
    }).pipe(Effect.withSpan("DesignSystemEditing.fileRead"));

  const writesRefused =
    "Agents cannot change a design system's files. Ask the user to do it on the system's page.";

  const filePut: DesignSystemEditing["Service"]["filePut"] = (caller, input) =>
    Effect.gen(function* () {
      yield* peopleOnly(caller, writesRefused);
      const resolved = yield* roots.resolve(caller, input.owner);
      const bytes = yield* decodeBase64(input.data);
      const file = yield* attempt(() =>
        SystemFiles.putSystemFile(resolved.designRoot, input.systemId, input.path, bytes),
      );
      return { file };
    }).pipe(Effect.withSpan("DesignSystemEditing.filePut"));

  const fileDelete: DesignSystemEditing["Service"]["fileDelete"] = (caller, input) =>
    Effect.gen(function* () {
      yield* peopleOnly(caller, writesRefused);
      const resolved = yield* roots.resolve(caller, input.owner);
      const deleted = yield* attempt(() =>
        SystemFiles.deleteSystemFile(resolved.designRoot, input.systemId, input.path),
      );
      return { deleted };
    }).pipe(Effect.withSpan("DesignSystemEditing.fileDelete"));

  const fileMove: DesignSystemEditing["Service"]["fileMove"] = (caller, input) =>
    Effect.gen(function* () {
      yield* peopleOnly(caller, writesRefused);
      const resolved = yield* roots.resolve(caller, input.owner);
      const file = yield* attempt(() =>
        SystemFiles.moveSystemFile(resolved.designRoot, input.systemId, input.from, input.to),
      );
      return { file };
    }).pipe(Effect.withSpan("DesignSystemEditing.fileMove"));

  return DesignSystemEditing.of({
    create,
    apply,
    files,
    fileRead,
    filePut,
    fileDelete,
    fileMove,
  });
});

export const layer = Layer.effect(DesignSystemEditing, make);
