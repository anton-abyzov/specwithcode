/**
 * The person's answers to "may this page use these powers": a 0600 JSON file
 * in the app's user data, one answer per install and version. An answer names
 * the sha256 of the bytes it was given for, so it says nothing about a file
 * that changed afterwards.
 *
 * Reading never grants by mistake: a file that is missing, malformed, from a
 * newer build or unreadable, an entry that does not decode, and two entries
 * for one version all read as "no answer".
 */
import { ArtifactAppInstallIdSchema, ArtifactAppPowerSchema } from "@specweave-studio/contracts";
import { fromLenientJson } from "@specweave-studio/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeArtifactAppPrivateFileWriter } from "./ArtifactAppPrivateFile.ts";

export const ARTIFACT_APP_GRANTS_FILE = "artifact-app-grants.json";

const GRANTS_VERSION = 1;
// A page republished many times leaves one answer per version; only the newest are kept.
const GRANTS_PER_INSTALL_LIMIT = 20;

export const ArtifactAppGrantSchema = Schema.Struct({
  installId: ArtifactAppInstallIdSchema,
  attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  /** The sha256 of the page file's bytes the answer was given for, in lowercase hex. */
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  /** The powers allowed; empty when the person said no or turned them off. */
  powers: Schema.Array(ArtifactAppPowerSchema),
  /** ISO time of the answer. */
  answeredAt: Schema.String,
});
export type ArtifactAppGrant = typeof ArtifactAppGrantSchema.Type;

export class ArtifactAppGrantsWriteError extends Schema.TaggedError<ArtifactAppGrantsWriteError>()(
  "ArtifactAppGrantsWriteError",
  {
    operation: Schema.Literals([
      "read-grants",
      "encode-document",
      "create-directory",
      "write-temporary-file",
      "replace-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Installed page grants write failed during ${this.operation} at ${this.path}.`;
  }
}

export class ArtifactAppGrants extends Context.Service<
  ArtifactAppGrants,
  {
    /** The answer recorded for this install and version; none when there is no usable one. */
    readonly find: (
      installId: string,
      attachmentId: string,
    ) => Effect.Effect<Option.Option<ArtifactAppGrant>>;
    /** Records the answer, replacing an earlier one for the same install and version. */
    readonly record: (grant: ArtifactAppGrant) => Effect.Effect<void, ArtifactAppGrantsWriteError>;
    /** Forgets every answer for the install. */
    readonly forget: (installId: string) => Effect.Effect<void, ArtifactAppGrantsWriteError>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppGrants") {}

const decodeEnvelope = Schema.decodeUnknownOption(
  fromLenientJson(Schema.Struct({ version: Schema.Number, grants: Schema.Array(Schema.Unknown) })),
);
const decodeGrant = Schema.decodeUnknownOption(ArtifactAppGrantSchema);
const encodeDocument = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(GRANTS_VERSION),
      grants: Schema.Array(ArtifactAppGrantSchema),
    }),
  ),
);

type GrantsRead =
  | { readonly _tag: "Grants"; readonly grants: ReadonlyArray<ArtifactAppGrant> }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "NewerVersion"; readonly version: number };

class UnsupportedGrantsVersion extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Installed page grants use version ${version}, newer than this build reads.`);
    this.version = version;
  }
}

const keyOf = (grant: { readonly installId: string; readonly attachmentId: string }) =>
  `${grant.installId}\n${grant.attachmentId}`;

function parseGrants(raw: string): GrantsRead {
  const envelope = decodeEnvelope(raw);
  if (Option.isNone(envelope)) return { _tag: "Malformed" };
  const { version, grants: entries } = envelope.value;
  if (version > GRANTS_VERSION) return { _tag: "NewerVersion", version };
  if (version !== GRANTS_VERSION) return { _tag: "Malformed" };
  const byKey = new Map<string, ArtifactAppGrant>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    const grant = decodeGrant(entry);
    if (Option.isNone(grant)) continue;
    const key = keyOf(grant.value);
    // Two answers for one version cannot both be the person's last word, so neither counts.
    if (byKey.has(key)) ambiguous.add(key);
    byKey.set(key, grant.value);
  }
  for (const key of ambiguous) byKey.delete(key);
  return { _tag: "Grants", grants: [...byKey.values()] };
}

const make = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeLock = yield* Semaphore.make(1);
  const writePrivateFile = makeArtifactAppPrivateFileWriter({ fileSystem, path, filePath });

  const readGrants: Effect.Effect<GrantsRead, PlatformError.PlatformError> = fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.map(parseGrants),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<GrantsRead>({ _tag: "Grants", grants: [] })
            : Effect.fail(error),
      }),
    );

  const warn = (message: string, annotations: Record<string, unknown>) =>
    Effect.logWarning(message).pipe(
      Effect.annotateLogs({ component: "desktop-artifact-app-grants", grantsPath: filePath }),
      Effect.annotateLogs(annotations),
    );

  // Whatever goes wrong here, the answer is "no grants".
  const list: Effect.Effect<ReadonlyArray<ArtifactAppGrant>> = readGrants.pipe(
    Effect.flatMap((read) => {
      switch (read._tag) {
        case "Grants":
          return Effect.succeed(read.grants);
        case "Malformed":
          return warn("installed page grants are malformed; reading none", {}).pipe(
            Effect.as<ReadonlyArray<ArtifactAppGrant>>([]),
          );
        case "NewerVersion":
          return warn("installed page grants are from a newer build; reading none", {
            version: read.version,
          }).pipe(Effect.as<ReadonlyArray<ArtifactAppGrant>>([]));
      }
    }),
    Effect.catchCause(() =>
      warn("installed page grants could not be read; reading none", {}).pipe(
        Effect.as<ReadonlyArray<ArtifactAppGrant>>([]),
      ),
    ),
    Effect.withSpan("desktop.artifactAppGrants.list"),
  );

  // A write starts from what is on disk. A missing or malformed file counts as empty; an
  // unreadable or newer one is never overwritten, and the write fails instead.
  const readForWrite: Effect.Effect<
    ReadonlyArray<ArtifactAppGrant>,
    ArtifactAppGrantsWriteError
  > = readGrants.pipe(
    Effect.mapError(
      (cause) =>
        new ArtifactAppGrantsWriteError({ operation: "read-grants", path: filePath, cause }),
    ),
    Effect.flatMap((read) => {
      switch (read._tag) {
        case "Grants":
          return Effect.succeed(read.grants);
        case "Malformed":
          return warn("installed page grants are malformed; replacing them", {}).pipe(
            Effect.as<ReadonlyArray<ArtifactAppGrant>>([]),
          );
        case "NewerVersion":
          return Effect.fail(
            new ArtifactAppGrantsWriteError({
              operation: "read-grants",
              path: filePath,
              cause: new UnsupportedGrantsVersion(read.version),
            }),
          );
      }
    }),
  );

  const writeGrants = Effect.fnUntraced(function* (grants: ReadonlyArray<ArtifactAppGrant>) {
    const encoded = yield* encodeDocument({ version: GRANTS_VERSION, grants }).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactAppGrantsWriteError({ operation: "encode-document", path: filePath, cause }),
      ),
    );
    yield* writePrivateFile(`${encoded}\n`).pipe(
      Effect.mapError(
        (error) =>
          new ArtifactAppGrantsWriteError({
            operation: error.operation,
            path: error.path,
            cause: error.cause,
          }),
      ),
    );
  });

  const record = Effect.fn("desktop.artifactAppGrants.record")(function* (grant: ArtifactAppGrant) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const key = keyOf(grant);
        const others = (yield* readForWrite).filter((existing) => keyOf(existing) !== key);
        const sameInstall = others.filter((existing) => existing.installId === grant.installId);
        // Entries are kept in the order they were answered, so the oldest come first.
        const dropped = new Set(
          sameInstall.slice(0, Math.max(0, sameInstall.length - (GRANTS_PER_INSTALL_LIMIT - 1))),
        );
        yield* writeGrants([...others.filter((existing) => !dropped.has(existing)), grant]);
      }),
    );
  });

  const forget = Effect.fn("desktop.artifactAppGrants.forget")(function* (installId: string) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const grants = yield* readForWrite;
        const next = grants.filter((existing) => existing.installId !== installId);
        if (next.length !== grants.length) yield* writeGrants(next);
      }),
    );
  });

  return ArtifactAppGrants.of({
    find: (installId, attachmentId) =>
      list.pipe(
        Effect.map((grants) =>
          Option.fromNullishOr(
            grants.find(
              (existing) =>
                existing.installId === installId && existing.attachmentId === attachmentId,
            ),
          ),
        ),
      ),
    record,
    forget,
  });
});

/** The grants store at `filePath`, normally `<userData>/artifact-app-grants.json`. */
export const layer = (
  filePath: string,
): Layer.Layer<ArtifactAppGrants, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ArtifactAppGrants, make(filePath));
