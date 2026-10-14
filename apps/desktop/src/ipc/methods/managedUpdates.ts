import {
  ManagedUpdateError,
  ManagedUpdateLocalConsentRequest,
  ManagedUpdateStatus,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLocalService from "../../backend/DesktopLocalService.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  controllerFromAttachedBearer,
  findManagedUpdateInstallations,
  invokeManagedUpdateHelper,
  managedInstallationOwner,
  selectAttachedManagedInstallation,
  selectManagedUpdateHelper,
  validateAttachedManagedRuntime,
  type LocalManagedUpdateInvocation,
  type ManagedInstallationOwner,
  type ManagedLocalInstallation,
} from "../../updates/managedUpdateInstallations.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

interface ResolvedManagedInstallation {
  readonly owner: ManagedInstallationOwner;
  readonly installation: ManagedLocalInstallation;
  readonly helper: string;
}

/** Injectable I/O boundary; tests use synthetic installations and never call native helpers. */
export interface ManagedUpdateConsentAdapter {
  readonly resolve: (
    environment: DesktopEnvironment.DesktopEnvironment["Service"],
    service: DesktopLocalService.AttachedLocalService,
    target: ManagedUpdateLocalConsentRequest,
  ) => ResolvedManagedInstallation;
  readonly invoke: (
    resolved: ResolvedManagedInstallation,
    request: LocalManagedUpdateInvocation,
  ) => Promise<ManagedUpdateStatus>;
}

export const resolveManagedUpdateConsentInstallation: ManagedUpdateConsentAdapter["resolve"] = (
  environment,
  service,
  target,
) => {
  const owner = managedInstallationOwner(environment.homeDirectory);
  const installation = selectAttachedManagedInstallation(
    findManagedUpdateInstallations(owner),
    service,
    target,
  );
  validateAttachedManagedRuntime(installation, service, owner);
  const helper = selectManagedUpdateHelper(
    [
      ...environment.resolveResourcePathCandidates("studio-updater/managed_updates.py"),
      ...(environment.isDevelopment
        ? [
            environment.path.join(
              environment.rootDir,
              "scripts",
              "studio-fleet",
              "managed_updates.py",
            ),
          ]
        : []),
      environment.path.join(installation.release, "studio-updater", "managed_updates.py"),
      environment.path.join(
        owner.homeDirectory,
        ".local",
        "share",
        "specweave-studio",
        "updater",
        "managed_updates.py",
      ),
    ],
    owner,
  );
  if (helper === null) throw new ManagedUpdateError({ code: "unsupported" });
  return { owner, installation, helper };
};

const adapter: ManagedUpdateConsentAdapter = {
  resolve: resolveManagedUpdateConsentInstallation,
  invoke: (resolved, request) =>
    invokeManagedUpdateHelper(resolved.helper, resolved.installation, resolved.owner, request),
};

const managedError = (cause: unknown) =>
  Schema.is(ManagedUpdateError)(cause) ? cause : new ManagedUpdateError({ code: "unavailable" });

const attachmentKey = (service: DesktopLocalService.AttachedLocalService) =>
  JSON.stringify([
    service.baseDir,
    service.descriptor.environmentId,
    service.runtime.pid,
    service.runtime.port,
    service.runtime.origin,
    service.runtime.serviceManaged,
    service.httpBaseUrl.href,
  ]);

/** Only the current main app document may ask for a native ownership decision. */
const ensureSender = Effect.fn("desktop.managedUpdates.ensureSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  const frame = event && "senderFrame" in event ? event.senderFrame : undefined;
  if (
    event === undefined ||
    Option.isNone(main) ||
    event.sender !== main.value.webContents ||
    frame === undefined ||
    frame !== main.value.webContents.mainFrame
  )
    return yield* new ManagedUpdateError({ code: "unauthorized" });
  const trustedUrl = yield* Effect.try({
    try: () => {
      const url = new URL(main.value.webContents.getURL());
      return (
        (url.protocol === "studio:" &&
          url.hostname === "app" &&
          url.username === "" &&
          url.password === "" &&
          url.port === "") ||
        (environment.isDevelopment &&
          Option.isSome(environment.devServerUrl) &&
          url.origin === environment.devServerUrl.value.origin)
      );
    },
    catch: () => new ManagedUpdateError({ code: "unauthorized" }),
  });
  if (!trustedUrl) return yield* new ManagedUpdateError({ code: "unauthorized" });
});

export function makeManagedUpdateConsentMethod(io: ManagedUpdateConsentAdapter = adapter) {
  return DesktopIpc.makeIpcMethod({
    channel: IpcChannels.MANAGED_UPDATE_CONSENT_CHANNEL,
    payload: ManagedUpdateLocalConsentRequest,
    result: Schema.NullOr(ManagedUpdateStatus),
    handler: Effect.fn("desktop.ipc.managedUpdates.requestConsent")(function* (input, event) {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* ensureSender(event, environment);
      if (environment.platform !== "darwin")
        return yield* new ManagedUpdateError({ code: "unsupported" });
      const localService = yield* DesktopLocalService.DesktopLocalService;
      const service = yield* localService.attached;
      if (Option.isNone(service)) return yield* new ManagedUpdateError({ code: "unmanaged" });
      const original = attachmentKey(service.value);
      yield* Effect.try({
        try: () => io.resolve(environment, service.value, input),
        catch: managedError,
      });
      const dialog = yield* ElectronDialog.ElectronDialog;
      const answer = yield* dialog.showMessageBox({
        type: "question",
        title: "Manage service updates",
        noLink: true,
        message:
          input.action === "enroll"
            ? "Allow update management for this service?"
            : "Revoke update management for this service?",
        detail: `Installation: ${input.installationId}\nEnvironment: ${input.environmentId}\n\nExisting automatic update preferences remain unchanged.`,
        buttons: ["Cancel", input.action === "enroll" ? "Allow management" : "Revoke management"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return null;

      const revalidate = Effect.gen(function* () {
        yield* ensureSender(event, environment);
        const current = yield* localService.attached;
        if (Option.isNone(current) || attachmentKey(current.value) !== original) {
          return yield* new ManagedUpdateError({ code: "binding-changed" });
        }
        return yield* Effect.try({
          try: () => io.resolve(environment, current.value, input),
          catch: managedError,
        });
      });
      yield* revalidate;
      // The main process obtains its own attached-service credential only after confirmation.
      const bearer = yield* localService.bearerToken.pipe(Effect.mapError(managedError));
      const now = yield* Clock.currentTimeMillis;
      const controller = yield* Effect.try({
        try: () => controllerFromAttachedBearer(bearer, now),
        catch: managedError,
      });
      const resolved = yield* revalidate;
      const target = {
        installationId: input.installationId,
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
      };
      const status = yield* Effect.tryPromise({
        try: () =>
          io.invoke(resolved, {
            action: input.action === "enroll" ? "enroll-local" : "revoke-local",
            environmentId: service.value.descriptor.environmentId,
            controller,
            input: { ...target, ...(input.action === "enroll" ? { consent: true as const } : {}) },
            approval: { kind: "native-owner", confirmed: true, ...target },
          }),
        catch: managedError,
      });
      if (
        status.installationId !== input.installationId ||
        status.environmentId !== input.environmentId
      ) {
        return yield* new ManagedUpdateError({ code: "binding-changed" });
      }
      return status;
    }),
  });
}

export const requestManagedUpdateConsent = makeManagedUpdateConsentMethod();
