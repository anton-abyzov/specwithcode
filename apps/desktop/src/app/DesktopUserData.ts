import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

/** The SingletonLock link Chromium keeps in a profile points at `<host>-<pid>`. */
const lockOwnerPid = (lockTarget: string): number | undefined => {
  const pid = Number(/-(\d+)$/.exec(lockTarget)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists and belongs to someone else.
    return (cause as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
};

/**
 * Select Electron's profile independently of the server's Studio home.
 *
 * A packaged install keeps its profile in `SpecWithCode`. An install from
 * before that name has it in `studio-v2`; the first start that finds no app
 * using it renames the folder, which keeps every Chromium database and the
 * Windows safeStorage key as they are, and leaves a `studio-v2` link behind
 * so an older build started later opens the same profile. A rename that
 * fails changes nothing: this start keeps `studio-v2` and the next one tries
 * again.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly isProcessRunning?: (pid: number) => boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    if (input.isDevelopment) {
      const legacyPath = path.join(input.appDataDirectory, "SpecWeave Studio (Dev)");
      return (yield* inspect(legacyPath))
        ? legacyPath
        : path.join(input.appDataDirectory, "studio-dev");
    }
    const brandedPath = path.join(input.appDataDirectory, "SpecWithCode");
    const previousPath = path.join(input.appDataDirectory, "studio-v2");
    const legacyPath = path.join(input.appDataDirectory, "SpecWeave Studio (Alpha)");
    const linkTarget = (resourcePath: string) =>
      fs.readLink(resourcePath).pipe(
        Effect.map((target): string | undefined => target),
        Effect.orElseSucceed(() => undefined),
      );
    // The move is optional, so nothing it looks at may stop startup.
    const present = (resourcePath: string) =>
      fs.exists(resourcePath).pipe(Effect.orElseSucceed(() => false));
    const renamePreviousProfile = Effect.gen(function* () {
      const previousLink = yield* linkTarget(previousPath);
      if (previousLink !== undefined) {
        // The link an earlier start left behind. Any other link is the user's own
        // and keeps its name.
        return (
          path.resolve(input.appDataDirectory, previousLink) === path.resolve(brandedPath) &&
          (yield* present(brandedPath))
        );
      }
      // Where Chromium keeps a lock (Linux), a running app holds this profile open
      // under its old path. Leave it alone.
      const lockTarget = yield* linkTarget(path.join(previousPath, "SingletonLock"));
      const ownerPid = lockTarget === undefined ? undefined : lockOwnerPid(lockTarget);
      if (ownerPid !== undefined && (input.isProcessRunning ?? isProcessRunning)(ownerPid)) {
        return false;
      }
      // One rename on one volume. It fails when `SpecWithCode` already holds files
      // or, on Windows, while anything in the profile is open.
      const renamed = yield* fs.rename(previousPath, brandedPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!renamed) return false;
      yield* fs.symlink(brandedPath, previousPath).pipe(Effect.ignore);
      return true;
    });
    const resolveDestination = Effect.gen(function* () {
      if (yield* present(path.join(brandedPath, "Local State"))) return brandedPath;
      // A `studio-v2` that cannot be inspected is still the profile to open.
      const previousExists = yield* fs.exists(previousPath).pipe(Effect.orElseSucceed(() => true));
      if (!previousExists) return brandedPath;
      return (yield* renamePreviousProfile) ? brandedPath : previousPath;
    });
    const destinationPath = yield* resolveDestination;
    // Chromium databases require their own profile for each running version.
    if (input.platform !== "win32") return destinationPath;
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* inspect(destinationState)) return destinationPath;
    const legacyState = path.join(legacyPath, "Local State");
    const sourceState = (yield* inspect(legacyState))
      ? legacyState
      : path.join(input.appDataDirectory, "studio", "Local State");
    if (!(yield* inspect(sourceState))) return destinationPath;
    // Windows safeStorage keys live here. Copy only these preferences, never locked databases.
    const state = yield* fs
      .readFileString(sourceState)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "read", sourceState),
        ),
      );
    yield* fs
      .makeDirectory(destinationPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(
            cause,
            "create-directory",
            destinationPath,
          ),
        ),
      );
    yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.mapError((cause) =>
        DesktopUserDataInitializationError.fromFileSystem(cause, "write", destinationState),
      ),
    );
    return destinationPath;
  },
);
