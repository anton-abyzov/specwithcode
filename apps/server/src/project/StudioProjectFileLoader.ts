/**
 * StudioProjectFileLoader - Effect service that loads the checked-in `specweave-studio.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module StudioProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { STUDIO_PROJECT_FILE_NAME, type StudioProjectFile } from "@specweave-studio/contracts";
import { StudioProjectFileFromJson } from "@specweave-studio/shared/studioProjectFile";

const decodeStudioProjectFileJson = Schema.decodeEffect(StudioProjectFileFromJson);

export class StudioProjectFileLoadError extends Schema.TaggedError<StudioProjectFileLoadError>()(
  "StudioProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${STUDIO_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for specweave-studio.json project file loading. */
export class StudioProjectFileLoader extends Context.Service<
  StudioProjectFileLoader,
  {
    /**
     * Load and decode `specweave-studio.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<StudioProjectFile>>;
  }
>()("specweave-studio/project/StudioProjectFileLoader") {}

const logStudioProjectFileLoadError = (error: StudioProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: StudioProjectFileLoader["Service"]["load"] = Effect.fn(
    "StudioProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, STUDIO_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logStudioProjectFileLoadError(
                new StudioProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<StudioProjectFile>();
    }
    return yield* decodeStudioProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logStudioProjectFileLoadError(
            new StudioProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<StudioProjectFile>())),
      }),
    );
  });

  return StudioProjectFileLoader.of({ load });
});

export const layer = Layer.effect(StudioProjectFileLoader, make);
