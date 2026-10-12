import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

const AppPackageMetadata = Schema.Struct({
  studioCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<
      string,
      DesktopUserData.DesktopUserDataInitializationError
    >;
    /**
     * Runs before Electron's `ready`. On macOS it leaves the app name alone:
     * see `setsNameBeforeReady`.
     */
    readonly configureBeforeReady: Effect.Effect<void>;
    readonly configure: Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/app/DesktopAppIdentity") {}

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

/**
 * Electron names the macOS Keychain item that encrypts saved data
 * ("<name> Safe Storage") from `app.name` as it stands when the main message
 * loop is created, which is before `ready`. Until then `app.name` is the
 * packaged package.json `name`, "studio" (see STAGE_PACKAGE_NAME in
 * scripts/build-desktop-artifact.ts). A `setName` before `ready` could win
 * that race and point every install at a new, empty Keychain item, so on
 * macOS the name is set only after `ready`.
 */
export function setsNameBeforeReady(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const userDataContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveEmbeddedCommitHash = Effect.gen(function* () {
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        decodeAppPackageMetadata(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(parsed.studioCommitHash).pipe(Option.flatMap(normalizeCommitHash)),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  });

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) {
      yield* Ref.set(commitHashCache, Option.some(override));
      return override;
    }

    if (!environment.isPackaged) {
      const empty = Option.none<string>();
      yield* Ref.set(commitHashCache, Option.some(empty));
      return empty;
    }

    const commitHash = yield* resolveEmbeddedCommitHash;
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const userDataPath = DesktopUserData.resolveUserDataPath(environment).pipe(
    Effect.provide(userDataContext),
  );

  const configureWith = (input: { readonly setName: boolean }) =>
    Effect.gen(function* () {
      const commitHash = yield* resolveAboutCommitHash;
      if (input.setName) {
        yield* electronApp.setName(environment.electronAppName);
      }
      yield* electronApp.setAboutPanelOptions({
        applicationName: environment.displayName,
        applicationVersion: environment.appVersion,
        version: Option.getOrElse(commitHash, () => "unknown"),
      });

      if (environment.platform === "win32") {
        yield* electronApp.setAppUserModelId(environment.appUserModelId);
      }

      // Unpackaged runs only. A packaged bundle already carries its icon in
      // Info.plist, so setting the dock tile again changes nothing except to
      // overwrite a custom icon the user attached to the app themselves.
      if (environment.platform === "darwin" && !environment.isPackaged) {
        const iconPaths = yield* assets.iconPaths;
        yield* Option.match(iconPaths.png, {
          onNone: () => Effect.void,
          onSome: electronApp.setDockIcon,
        });
      }
    });

  const configureBeforeReady = configureWith({
    setName: setsNameBeforeReady(environment.platform),
  }).pipe(Effect.withSpan("desktop.appIdentity.configureBeforeReady"));
  const configure = configureWith({ setName: true }).pipe(
    Effect.withSpan("desktop.appIdentity.configure"),
  );

  return DesktopAppIdentity.of({
    resolveUserDataPath: userDataPath,
    configureBeforeReady,
    configure,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
