/**
 * Opening pages in a browser installed on the machine, in a chosen profile.
 *
 * Chromium-family browsers keep each signed-in identity in its own profile
 * directory. Passing `--profile-directory=<dir>` to the browser opens the URL
 * in that profile, or hands it to the running browser, which opens it there.
 * That lets a user send a page to, say, the Chrome profile signed in to a
 * Google Ads account, which the in-app browser has no session for.
 *
 * Profiles are enumerated the same way cookie import does it (Chromium's
 * `Local State`), and a launch only ever uses a browser and profile that this
 * enumeration found: the renderer names them, it never supplies a path.
 * Launches go through `execFile`-style argument arrays, never a shell.
 *
 * macOS: `open -na <App.app> --args --profile-directory=<dir> <url>`.
 * Windows and Linux: the browser executable with the same arguments. Anything
 * not found falls back to the OS default browser.
 *
 * @module ExternalBrowsers
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - The browser must outlive this app, so it is spawned detached and unreferenced, which the scoped Effect process API does not model.
import * as NodeChildProcess from "node:child_process";

import {
  EXTERNAL_BROWSER_IDS,
  type BrowserImportSourceId,
  type ExternalBrowser,
  type ExternalBrowserId,
  type ExternalBrowserTarget,
  type OpenInExternalBrowserInput,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import {
  BROWSER_IMPORT_SOURCES,
  readChromiumDeclaredProfiles,
  sourcePathContext,
  type BrowserImportPathContext,
} from "./BrowserImport/Sources.ts";

export interface ExternalBrowserDefinition {
  readonly id: ExternalBrowserId;
  readonly name: string;
  /** The cookie-import source whose user-data directory this browser shares. */
  readonly sourceId: BrowserImportSourceId;
  /** App bundle names looked for in /Applications and ~/Applications. */
  readonly macAppNames: ReadonlyArray<string>;
  /** Executable names looked for on PATH. */
  readonly linuxExecutables: ReadonlyArray<string>;
  /** Executable paths relative to Program Files or %LOCALAPPDATA%. */
  readonly windowsExecutable?: ReadonlyArray<string>;
  /** User-data directory relative to %LOCALAPPDATA%. */
  readonly windowsUserData?: ReadonlyArray<string>;
}

export const EXTERNAL_BROWSER_DEFINITIONS: ReadonlyArray<ExternalBrowserDefinition> = [
  {
    id: "chrome",
    name: "Chrome",
    sourceId: "chrome",
    macAppNames: ["Google Chrome.app"],
    linuxExecutables: ["google-chrome", "google-chrome-stable"],
    windowsExecutable: ["Google", "Chrome", "Application", "chrome.exe"],
    windowsUserData: ["Google", "Chrome", "User Data"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    sourceId: "edge",
    macAppNames: ["Microsoft Edge.app"],
    linuxExecutables: ["microsoft-edge", "microsoft-edge-stable"],
    windowsExecutable: ["Microsoft", "Edge", "Application", "msedge.exe"],
    windowsUserData: ["Microsoft", "Edge", "User Data"],
  },
  {
    id: "brave",
    name: "Brave",
    sourceId: "brave",
    macAppNames: ["Brave Browser.app"],
    linuxExecutables: ["brave-browser", "brave"],
    windowsExecutable: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    windowsUserData: ["BraveSoftware", "Brave-Browser", "User Data"],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    sourceId: "vivaldi",
    macAppNames: ["Vivaldi.app"],
    linuxExecutables: ["vivaldi", "vivaldi-stable"],
    windowsExecutable: ["Vivaldi", "Application", "vivaldi.exe"],
    windowsUserData: ["Vivaldi", "User Data"],
  },
  {
    id: "helium",
    name: "Helium",
    sourceId: "helium",
    macAppNames: ["Helium.app"],
    linuxExecutables: ["helium"],
  },
];

/** An installed browser: how to launch it and which profiles it has. */
export interface InstalledExternalBrowser extends ExternalBrowser {
  /** The app bundle (macOS) or executable (Windows, Linux) to launch. */
  readonly launchPath: string;
}

export interface ExternalBrowserLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** The URL as an http(s) href without credentials, or null. */
export function parseExternalWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username.length > 0 || url.password.length > 0) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The process to start. The URL is always the last argument and, being
 * http(s), can never be read as a flag.
 */
export function buildExternalBrowserLaunch(input: {
  readonly platform: NodeJS.Platform;
  readonly launchPath: string;
  readonly profileDirectory: string | undefined;
  readonly url: string;
}): ExternalBrowserLaunch {
  const browserArgs = [
    ...(input.profileDirectory === undefined
      ? []
      : [`--profile-directory=${input.profileDirectory}`]),
    input.url,
  ];
  if (input.platform === "darwin") {
    // -n starts a new instance so the arguments reach Chrome even when it is
    // already running; Chrome forwards them to the running one and exits.
    return { command: "open", args: ["-na", input.launchPath, "--args", ...browserArgs] };
  }
  return { command: input.launchPath, args: browserArgs };
}

/**
 * The installed browser and profile a target names, or null when either is
 * not one the enumeration found. A target without a profile opens the
 * browser's last-used profile.
 */
export function resolveExternalBrowserTarget(
  browsers: ReadonlyArray<InstalledExternalBrowser>,
  target: ExternalBrowserTarget,
): { readonly browser: InstalledExternalBrowser; readonly profileDirectory?: string } | null {
  const browser = browsers.find((candidate) => candidate.id === target.browserId);
  if (!browser) return null;
  if (target.profileDirectory === undefined) return { browser };
  const profile = browser.profiles.find(
    (candidate) => candidate.directory === target.profileDirectory,
  );
  return profile ? { browser, profileDirectory: profile.directory } : null;
}

const pathEntryIs = Effect.fnUntraced(function* (path: string, type: "File" | "Directory") {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((info) => info.type === type),
    Effect.orElseSucceed(() => false),
  );
});

/** Where macOS apps live; overridable so tests never see the real machine. */
export const macApplicationRoots = (context: BrowserImportPathContext): ReadonlyArray<string> => [
  "/Applications",
  context.path.join(context.home, "Applications"),
];

const findLaunchPath = Effect.fnUntraced(function* (
  definition: ExternalBrowserDefinition,
  context: BrowserImportPathContext,
  environment: NodeJS.ProcessEnv,
  applicationRoots: ReadonlyArray<string>,
) {
  const { path } = context;
  if (context.platform === "darwin") {
    for (const root of applicationRoots) {
      for (const appName of definition.macAppNames) {
        const candidate = path.join(root, appName);
        if (yield* pathEntryIs(candidate, "Directory")) return candidate;
      }
    }
    return undefined;
  }
  if (context.platform === "win32") {
    if (!definition.windowsExecutable) return undefined;
    const roots = [
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"],
      context.localAppData,
    ].filter((root): root is string => typeof root === "string" && root.length > 0);
    for (const root of roots) {
      const candidate = path.join(root, ...definition.windowsExecutable);
      if (yield* pathEntryIs(candidate, "File")) return candidate;
    }
    return undefined;
  }
  const searchPath = (environment.PATH ?? "").split(":").filter((entry) => entry.length > 0);
  for (const directory of searchPath) {
    for (const executable of definition.linuxExecutables) {
      const candidate = path.join(directory, executable);
      if (yield* pathEntryIs(candidate, "File")) return candidate;
    }
  }
  return undefined;
});

const userDataDirectory = (
  definition: ExternalBrowserDefinition,
  context: BrowserImportPathContext,
): string | undefined => {
  if (context.platform === "win32") {
    return definition.windowsUserData && context.localAppData
      ? context.path.join(context.localAppData, ...definition.windowsUserData)
      : undefined;
  }
  const source = BROWSER_IMPORT_SOURCES.find((candidate) => candidate.id === definition.sourceId);
  return source?.userDataDirectory(context);
};

/** Installed Chromium-family browsers with the profiles each declares. */
export const listInstalledExternalBrowsers = Effect.fn("ExternalBrowsers.listInstalled")(function* (
  context: BrowserImportPathContext,
  environment: NodeJS.ProcessEnv,
  applicationRoots: ReadonlyArray<string> = macApplicationRoots(context),
) {
  const found = yield* Effect.forEach(
    EXTERNAL_BROWSER_DEFINITIONS,
    Effect.fnUntraced(function* (definition) {
      const launchPath = yield* findLaunchPath(definition, context, environment, applicationRoots);
      if (launchPath === undefined) return undefined;
      const root = userDataDirectory(definition, context);
      const profiles = root === undefined ? [] : yield* readChromiumDeclaredProfiles(root, context);
      return {
        id: definition.id,
        name: definition.name,
        launchPath,
        profiles: profiles.map((profile) => ({
          directory: profile.directory,
          name: profile.name,
          ...(profile.account === undefined ? {} : { account: profile.account }),
        })),
      } satisfies InstalledExternalBrowser;
    }),
    { concurrency: EXTERNAL_BROWSER_IDS.length },
  );
  return found.filter((browser) => browser !== undefined);
});

export type SpawnDetached = (launch: ExternalBrowserLaunch) => Effect.Effect<boolean>;

/** Starts the process detached from this app; true once it has spawned. */
export const spawnDetached: SpawnDetached = (launch) =>
  Effect.callback<boolean>((resume) => {
    try {
      const child = NodeChildProcess.spawn(launch.command, [...launch.args], {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: false,
      });
      child.once("error", () => resume(Effect.succeed(false)));
      child.once("spawn", () => {
        child.unref();
        resume(Effect.succeed(true));
      });
    } catch {
      resume(Effect.succeed(false));
    }
  });

/**
 * Opens the URL in the target browser and profile. False, without launching
 * anything, when the URL is not http(s) or the target is not installed.
 */
export const openInInstalledBrowser = Effect.fn("ExternalBrowsers.open")(function* (input: {
  readonly request: OpenInExternalBrowserInput;
  readonly browsers: ReadonlyArray<InstalledExternalBrowser>;
  readonly platform: NodeJS.Platform;
  readonly spawn: SpawnDetached;
}) {
  const url = parseExternalWebUrl(input.request.url);
  if (url === null) return false;
  const resolved = resolveExternalBrowserTarget(input.browsers, input.request.target);
  if (resolved === null) return false;
  return yield* input.spawn(
    buildExternalBrowserLaunch({
      platform: input.platform,
      launchPath: resolved.browser.launchPath,
      profileDirectory: resolved.profileDirectory,
      url,
    }),
  );
});

export class ExternalBrowsers extends Context.Service<
  ExternalBrowsers,
  {
    readonly list: Effect.Effect<ReadonlyArray<ExternalBrowser>>;
    readonly open: (input: OpenInExternalBrowserInput) => Effect.Effect<boolean>;
    /**
     * Opens a link clicked in the app where "Open links in" says: the chosen
     * browser profile when one is set and still installed, else the OS
     * default browser.
     */
    readonly openLink: (rawUrl: string) => Effect.Effect<boolean>;
  }
>()("@specweave-studio/desktop/preview/ExternalBrowsers") {}

export const make = (
  options: {
    readonly spawn?: SpawnDetached;
    /** macOS app folders to search; tests point this at a scratch directory. */
    readonly applicationRoots?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const spawn = options.spawn ?? spawnDetached;
    const fileSystem = yield* FileSystem.FileSystem;
    const context = yield* sourcePathContext;
    const environment = yield* HostProcessEnvironment;
    const shell = yield* ElectronShell.ElectronShell;
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;

    const listInstalled = listInstalledExternalBrowsers(
      context,
      environment,
      options.applicationRoots,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

    const open = (request: OpenInExternalBrowserInput) =>
      Effect.gen(function* () {
        const browsers = yield* listInstalled;
        return yield* openInInstalledBrowser({
          request,
          browsers,
          platform: context.platform,
          spawn,
        });
      });

    const openLink = (rawUrl: string) =>
      Effect.gen(function* () {
        const target = yield* clientSettings.get.pipe(
          Effect.map(
            Option.flatMap((settings) =>
              settings.browserLinkTarget === "system"
                ? Option.fromNullishOr(settings.browserExternalTarget)
                : Option.none(),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<ExternalBrowserTarget>()),
        );
        if (Option.isSome(target) && parseExternalWebUrl(rawUrl) !== null) {
          if (yield* open({ url: rawUrl, target: target.value })) return true;
        }
        return yield* shell.openExternal(rawUrl);
      });

    return ExternalBrowsers.of({
      list: listInstalled.pipe(
        Effect.map((browsers) =>
          browsers.map(({ launchPath: _launchPath, ...browser }) => browser),
        ),
      ),
      open,
      openLink,
    });
  });

export const layer = Layer.effect(ExternalBrowsers, make());
