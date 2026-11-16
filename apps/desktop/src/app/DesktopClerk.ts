import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

import {
  codexAuthDeliveryUrl,
  readCodexAuthHandoff,
} from "@specweave-studio/shared/codexAuthHandoff";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@specweave-studio/shared/providerAuthReturnUrl";
import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@specweave-studio/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { CONNECT_SIGN_IN_STATE_CHANNEL } from "../ipc/channels.ts";
import { clerkOAuthRedirectUrl, installClerkOAuthTransport } from "./DesktopClerkOAuthTransport.ts";
import { clerkTokenFilePath, withOwnerOnlyTokenFile } from "./DesktopClerkTokenStorage.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWindow.DesktopWindow
      | Scope.Scope
    >;
  }
>()("@specweave-studio/desktop/app/DesktopClerk") {}

function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__,
);

const desktopClerkRenderer = (isDevelopment: boolean) => ({
  scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
  host: ElectronProtocol.DESKTOP_HOST,
});

function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: withOwnerOnlyTokenFile(storage({ path: stateDir }), clerkTokenFilePath(stateDir)),
    passkeys: true,
    renderer: desktopClerkRenderer(isDevelopment),
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  // The SDK bridge acquires Electron's profile-scoped single-instance lock.
  // Must not yield: the bridge registers a scheme Electron rejects once ready.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );
  // Chromium opens its GPU caches at the first event-loop turn, before ready, so
  // this runs here, synchronously. Only the instance holding the profile lock
  // may touch them; outside Electron (tests) there is no version to key on.
  const electronVersion: string | undefined = process.versions.electron;
  if (bridge.isPrimaryInstance && electronVersion !== undefined) {
    yield* DesktopUserData.clearStaleGpuCaches({ userDataPath, electronVersion });
  }

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      // The SDK refuses a second sign-in while one waits for the browser and
      // tells the window nothing. Take over that one request; the redirect
      // URL, token storage, passkeys and the instance lock stay the SDK's.
      // Its own callback listeners stay registered and never fire, because
      // its waiting slot stays empty. Released before the bridge, and safe
      // in either order: both remove the same handler, which cannot throw.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          installClerkOAuthTransport({
            ipcMain: Electron.ipcMain,
            app: {
              on: (eventName, listener) => Electron.app.on(eventName as never, listener),
              removeListener: (eventName, listener) =>
                Electron.app.removeListener(eventName as never, listener),
            },
            openExternal: (url) =>
              runPromise(shell.openExternal(url)).then((opened) => {
                if (!opened) throw new Error("The system browser did not open.");
              }),
            focusWindow: (sender) => {
              void runPromise(
                electronWindow.appWindowForWebContents(sender.id).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (window) => electronWindow.reveal(window),
                    }),
                  ),
                  Effect.ignoreCause,
                ),
              );
            },
            redirectUrl: clerkOAuthRedirectUrl(desktopClerkRenderer(environment.isDevelopment)),
            stateChannel: CONNECT_SIGN_IN_STATE_CHANNEL,
            log: ({ event, ...fields }) => {
              void runPromise(
                Effect.logInfo(`Connect sign-in: ${event}`).pipe(Effect.annotateLogs(fields)),
              );
            },
          }),
        ),
        (removeOAuthTransport) => Effect.sync(removeOAuthTransport),
      );

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const args = yield* HostProcessArguments;
      args.some((value) => startProviderAuthHandoff(value));
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        if (startProviderAuthHandoff(url) || resumeProviderAuth(url)) event.preventDefault();
      });
      yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
        if (argv?.some((value) => startProviderAuthHandoff(value) || resumeProviderAuth(value)))
          return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
              return;
            }
            // The main window was closed while a project window stayed open.
            // Launching the app again brings the main window back, as it does
            // when nothing is open; a project window comes forward only when
            // the main window cannot be opened yet.
            yield* desktopWindow.activate.pipe(Effect.ignoreCause);
            if (Option.isSome(yield* electronWindow.main)) return;
            const [appWindow] = yield* electronWindow.appWindows;
            if (appWindow !== undefined) yield* electronWindow.reveal(appWindow);
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
