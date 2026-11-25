import * as NodeOS from "node:os";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

export const TelemetryIdentitySource = Schema.Literals(["anonymous"]);
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    source: TelemetryIdentitySource,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityHashError extends Schema.TaggedError<TelemetryIdentityHashError>()(
  "TelemetryIdentityHashError",
  {
    source: TelemetryIdentitySource,
    algorithm: Schema.Literal("SHA-256"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to hash ${this.source} telemetry identity with ${this.algorithm}.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError
  | TelemetryIdentityHashError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  if (cause instanceof Schema.SchemaError) {
    return { causeKind: "schema" };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      source: error.source,
      ...("filePath" in error ? { filePath: error.filePath } : {}),
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (
  fileSystem: FileSystem.FileSystem,
  source: TelemetryIdentitySource,
  filePath: string,
) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new TelemetryIdentityReadError({
                source,
                filePath,
                cause,
              }),
            ),
    }),
  );

const hash = (source: TelemetryIdentitySource, value: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", new TextEncoder().encode(value))),
    Effect.map(Hex.encode),
    Effect.mapError(
      (cause) =>
        new TelemetryIdentityHashError({
          source,
          algorithm: "SHA-256",
          cause,
        }),
    ),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, "anonymous", anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/**
 * getTelemetryIdentifier - an install is identified only by a random id kept at
 * <SpecWithCode root>/telemetry/anonymous-id (~/.specwithcode; legacy
 * ~/.specweave-studio), hashed. Provider sign-in files (Codex auth.json,
 * Claude's .claude.json) are never read: their account ids name a person or a
 * whole team. The home directory parameter is kept for callers and tests.
 *
 * Only an unreadable or unwritable id file warns.
 */
export const getTelemetryIdentifierForHome = Effect.fn("getTelemetryIdentifierForHome")(
  function* (_homeDirectory: string) {
    const anonymousId = yield* upsertAnonymousId.pipe(
      Effect.asSome,
      Effect.catchTags({
        TelemetryIdentityReadError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryAnonymousIdGenerationError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryAnonymousIdPersistenceError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isSome(anonymousId)) {
      return yield* hash("anonymous", anonymousId.value);
    }

    return null;
  },
  Effect.tapError(logTelemetryIdentityError),
  Effect.orElseSucceed(() => null),
);

export const getTelemetryIdentifier = Effect.suspend(() =>
  getTelemetryIdentifierForHome(NodeOS.homedir()),
);
