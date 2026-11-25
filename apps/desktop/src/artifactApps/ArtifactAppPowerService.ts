/**
 * Decides what an installed page may do on the desktop. A page declares its
 * powers in its own file; the person allows them for one version in a native
 * dialog; and every request is checked again when it runs:
 *
 * - it comes from an installed page's own window, for that window's install;
 * - it names the version that window has open, whose frame never left it;
 * - the install is still recorded and its page is a file on this machine;
 * - the file's bytes still hash to what the person's answer was given for;
 * - that answer includes the power.
 *
 * Anything that cannot be shown to hold means no power: an unreadable grant,
 * manifest or file, a window that cannot be found, and any failure on the way
 * all end in a refusal, never in a default that allows.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hashing the page file needs sha256; nothing here is random.
import * as NodeCrypto from "node:crypto";

import type {
  ArtifactAppPower,
  DesktopArtifactApp,
  DesktopArtifactAppPermissions,
  DesktopArtifactAppPermissionsInput,
  DesktopArtifactAppPowerEvent,
  DesktopArtifactAppPowerInput,
  DesktopArtifactAppPowerReply,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { ARTIFACT_APP_POWER_EVENT_CHANNEL } from "../ipc/channels.ts";
import * as ArtifactAppGrants from "./ArtifactAppGrants.ts";
import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import {
  ARTIFACT_APP_CONSENT_ALLOW,
  ARTIFACT_APP_SHORTCUT_LIMIT,
  admitArtifactAppNotification,
  artifactAppConsentDialog,
  artifactAppPageFileName,
  isArtifactAppAcceleratorFree,
  normalizeArtifactAppAccelerator,
  readArtifactAppManifest,
  readArtifactAppPowerRequest,
  type ArtifactAppPowerRequest,
} from "./ArtifactAppPowers.ts";
import * as ArtifactAppPowersHost from "./ArtifactAppPowersHost.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

// html_render publishes at most 25 MiB; a larger file is not a page this app wrote.
const PAGE_MAX_BYTES = 32 * 1024 * 1024;
const REQUESTS_WAITING_LIMIT = 8;

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-powers");

export class ArtifactAppPowerService extends Context.Service<
  ArtifactAppPowerService,
  {
    /** The Permissions state of the calling window, after the action. Empty for any other caller. */
    readonly permissions: (
      webContentsId: number,
      input: DesktopArtifactAppPermissionsInput,
    ) => Effect.Effect<DesktopArtifactAppPermissions>;
    /** Runs one request from the calling window's page, or refuses it. */
    readonly power: (
      webContentsId: number,
      input: DesktopArtifactAppPowerInput,
    ) => Effect.Effect<DesktopArtifactAppPowerReply>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppPowerService") {}

const NO_PERMISSIONS: DesktopArtifactAppPermissions = {
  attachmentId: null,
  declared: [],
  granted: [],
};
const OK: DesktopArtifactAppPowerReply = { ok: true };
const refuse = (
  error: Extract<DesktopArtifactAppPowerReply, { ok: false }>["error"],
): DesktopArtifactAppPowerReply => ({ ok: false, error });

/** The version a window has open and what it holds on the desktop. */
interface Session {
  readonly attachmentId: string;
  /** What the file declared when the version was opened; shown when it can no longer be read. */
  declared: ReadonlyArray<ArtifactAppPower>;
  tray: ArtifactAppPowersHost.ArtifactAppTrayHandle | undefined;
  onTop: boolean;
}

/** The page's file as read just now: the bytes' hash and what those same bytes declare. */
interface VersionRead {
  readonly app: DesktopArtifactApp;
  readonly sha256: string;
  readonly declared: ReadonlyArray<ArtifactAppPower>;
}

/** A version whose every check passed just now, and the powers it has. */
interface Verified {
  readonly window: Electron.BrowserWindow;
  readonly app: DesktopArtifactApp;
  readonly powers: ReadonlyArray<ArtifactAppPower>;
}

const versionKey = (installId: string, attachmentId: string) => `${installId}\n${attachmentId}`;

const make = Effect.gen(function* () {
  const host = yield* ArtifactAppPowersHost.ArtifactAppPowersHost;
  // The same native dialog seam the install confirmation uses.
  const dialogs = yield* ArtifactAppInstaller.ArtifactAppInstallerHost;
  const grants = yield* ArtifactAppGrants.ArtifactAppGrants;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // Requests and releases never interleave: a release waits for the request in flight.
  const lock = yield* Semaphore.make(1);

  const sessions = new Map<string, Session>();
  // Canonical accelerator -> the install holding it and the spelling the page gave.
  const shortcuts = new Map<string, { readonly installId: string; readonly accelerator: string }>();
  const notificationTimes = new Map<string, ReadonlyArray<number>>();
  // Versions turned off or declined in this run, with the file hash that was refused (null: any).
  // It holds even when the answer could not be saved.
  const turnedOff = new Map<string, string | null>();
  const isTurnedOff = (installId: string, attachmentId: string, sha256: string) => {
    const key = versionKey(installId, attachmentId);
    if (!turnedOff.has(key)) return false;
    const refused = turnedOff.get(key);
    return refused === null || refused === undefined || refused === sha256;
  };
  const asking = new Set<string>();

  const readVersion = (
    installId: string,
    attachmentId: string,
  ): Effect.Effect<Option.Option<VersionRead>> =>
    Effect.gen(function* () {
      const app = yield* records.get(installId);
      if (Option.isNone(app)) return Option.none<VersionRead>();
      const fileName = artifactAppPageFileName(attachmentId);
      if (fileName === null) return Option.none<VersionRead>();
      const local = yield* host.localPages;
      // Only this machine's own pages are files here.
      if (Option.isNone(local) || local.value.environmentId !== app.value.environmentId) {
        return Option.none<VersionRead>();
      }
      const filePath = path.join(local.value.attachmentsDir, fileName);
      const info = yield* fileSystem.stat(filePath);
      if (info.type !== "File" || !(Number(info.size) <= PAGE_MAX_BYTES)) {
        return Option.none<VersionRead>();
      }
      // One read: the hash and the manifest come from the same bytes.
      const bytes = yield* fileSystem.readFile(filePath);
      if (!(bytes.byteLength <= PAGE_MAX_BYTES)) return Option.none<VersionRead>();
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const declared = readArtifactAppManifest(new TextDecoder("utf-8").decode(bytes));
      return Option.some<VersionRead>({ app: app.value, sha256, declared });
    }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<VersionRead>())));

  /** What the person's saved answer allows for the bytes on disk right now. */
  const grantedNow = (
    installId: string,
    attachmentId: string,
  ): Effect.Effect<{
    readonly version: Option.Option<VersionRead>;
    readonly powers: ReadonlyArray<ArtifactAppPower>;
  }> =>
    Effect.gen(function* () {
      const version = yield* readVersion(installId, attachmentId);
      if (Option.isNone(version) || isTurnedOff(installId, attachmentId, version.value.sha256)) {
        return { version, powers: [] };
      }
      const grant = yield* grants.find(installId, attachmentId);
      if (Option.isNone(grant) || grant.value.sha256 !== version.value.sha256) {
        return { version, powers: [] };
      }
      const allowed = new Set<ArtifactAppPower>(grant.value.powers);
      return { version, powers: version.value.declared.filter((power) => allowed.has(power)) };
    }).pipe(
      Effect.catchCause(() => Effect.succeed({ version: Option.none<VersionRead>(), powers: [] })),
    );

  /** Gives back everything the install holds on the desktop. The one teardown. */
  const releaseHeld = (installId: string, session: Session | undefined) =>
    Effect.gen(function* () {
      // A copy: entries are deleted while walking.
      for (const [canonical, owner] of Array.from(shortcuts)) {
        if (owner.installId !== installId) continue;
        shortcuts.delete(canonical);
        yield* host.unregisterShortcut(canonical);
      }
      if (session === undefined) return;
      const { tray, onTop } = session;
      session.tray = undefined;
      session.onTop = false;
      tray?.destroy();
      if (onTop) {
        const window = yield* windows.windowForInstall(installId);
        if (Option.isSome(window)) yield* host.setAlwaysOnTop(window.value, false);
      }
    });
  const releaseUnlocked = (installId: string) => releaseHeld(installId, sessions.get(installId));
  const release = (installId: string) => lock.withPermits(1)(releaseUnlocked(installId));

  yield* windows.onClosed((installId) => {
    // The version ends here and now, so a request already in flight finds no session when
    // it comes to act. The notification count stays: closing a window does not start a new minute.
    const session = sessions.get(installId);
    sessions.delete(installId);
    runFork(lock.withPermits(1)(releaseHeld(installId, session)));
  });
  // A frame that left its version, or a page process that ended, gives everything back at once.
  yield* windows.onFrameStrayed((installId) => {
    runFork(release(installId));
  });

  /**
   * The checks every use of a power passes, at the moment of use. None means
   * the version has no standing at all; otherwise the powers it has now.
   */
  const verify = (installId: string, session: Session): Effect.Effect<Option.Option<Verified>> =>
    Effect.gen(function* () {
      if (sessions.get(installId) !== session) return Option.none<Verified>();
      const window = yield* windows.windowForInstall(installId);
      if (Option.isNone(window)) return Option.none<Verified>();
      if (!(yield* windows.isFrameOnVersion(installId))) return Option.none<Verified>();
      const { version, powers } = yield* grantedNow(installId, session.attachmentId);
      if (Option.isNone(version) || powers.length === 0) return Option.none<Verified>();
      // The file was read meanwhile. The window may have closed, been replaced, moved to
      // another version, or its frame may have left: each is asked again, now.
      if (sessions.get(installId) !== session) return Option.none<Verified>();
      const current = yield* windows.windowForInstall(installId);
      if (Option.isNone(current) || current.value !== window.value) return Option.none<Verified>();
      if (!(yield* windows.isFrameOnVersion(installId))) return Option.none<Verified>();
      // So may the person's mind: "Turn off all" or a refusal given while the saved answer
      // was being read counts from the moment it was given, not from when it is saved.
      if (isTurnedOff(installId, session.attachmentId, version.value.sha256)) {
        return Option.none<Verified>();
      }
      return Option.some<Verified>({ window: window.value, app: version.value.app, powers });
    }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<Verified>())));

  /** Tells the page a tray item was clicked or a shortcut pressed, if it may still know. */
  const emit = (
    installId: string,
    session: Session,
    power: ArtifactAppPower,
    event: DesktopArtifactAppPowerEvent,
  ) =>
    // Under the lock, like a request: turning off or closing cannot slip in between the
    // check and the event.
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const verified = yield* verify(installId, session);
          if (Option.isNone(verified)) return yield* releaseUnlocked(installId);
          if (!verified.value.powers.includes(power)) return;
          yield* host.sendToWindow(verified.value.window, ARTIFACT_APP_POWER_EVENT_CHANNEL, event);
        }),
      )
      .pipe(Effect.catchCause(() => release(installId)));

  const run = Effect.fnUntraced(function* (
    installId: string,
    session: Session,
    request: ArtifactAppPowerRequest,
    verified: Verified,
  ) {
    switch (request.method) {
      case "app/notify": {
        const admission = admitArtifactAppNotification(
          notificationTimes.get(installId) ?? [],
          yield* Clock.currentTimeMillis,
        );
        notificationTimes.set(installId, admission.sent);
        if (!admission.admitted) return refuse("rate-limited");
        const shown = yield* host.showNotification({
          // Always the app's own name, so a page cannot pass for another app.
          title: verified.app.name,
          body: request.body.length > 0 ? `${request.title}\n${request.body}` : request.title,
          onClick: () => runFork(windows.open(installId)),
        });
        return shown ? OK : refuse("unavailable");
      }
      case "app/tray/set": {
        session.tray?.destroy();
        session.tray = undefined;
        const tray = yield* host.createTray({
          title: request.title,
          tooltip: `${verified.app.name}: ${request.tooltip}`,
          items: request.items.map((item) => ({
            label: item.label,
            onClick: () =>
              runFork(
                emit(installId, session, "tray", {
                  attachmentId: session.attachmentId,
                  method: "app/tray/clicked",
                  params: { id: item.id },
                }),
              ),
          })),
          openLabel: `Open ${verified.app.name}`,
          closeLabel: `Close ${verified.app.name}`,
          onOpen: () => runFork(windows.open(installId)),
          onClose: () => runFork(windows.close(installId)),
        });
        if (Option.isNone(tray)) return refuse("unavailable");
        session.tray = tray.value;
        return OK;
      }
      case "app/window/always-on-top": {
        const applied = yield* host.setAlwaysOnTop(verified.window, request.on);
        session.onTop = request.on && applied;
        return applied ? OK : refuse("unavailable");
      }
      case "app/shortcut/unregister": {
        const canonical = normalizeArtifactAppAccelerator(request.accelerator, host.platform);
        if (canonical === null) return refuse("invalid-request");
        if (shortcuts.get(canonical)?.installId === installId) {
          shortcuts.delete(canonical);
          yield* host.unregisterShortcut(canonical);
        }
        return OK;
      }
      case "app/shortcut/register": {
        const canonical = normalizeArtifactAppAccelerator(request.accelerator, host.platform);
        if (canonical === null) return refuse("invalid-request");
        const owner = shortcuts.get(canonical);
        if (owner !== undefined)
          return owner.installId === installId ? OK : refuse("shortcut-taken");
        const held = [...shortcuts.values()].filter((entry) => entry.installId === installId);
        if (held.length >= ARTIFACT_APP_SHORTCUT_LIMIT) return refuse("shortcut-limit");
        const appAccelerators = yield* host.appAccelerators;
        if (
          // Without the app's own accelerators there is no telling whether this one is free.
          Option.isNone(appAccelerators) ||
          !isArtifactAppAcceleratorFree({
            canonical,
            platform: host.platform,
            appAccelerators: appAccelerators.value,
          }) ||
          (yield* host.isShortcutRegistered(canonical))
        ) {
          return refuse("shortcut-taken");
        }
        const accelerator = request.accelerator;
        const registered = yield* host.registerShortcut(canonical, () =>
          runFork(
            emit(installId, session, "global-shortcuts", {
              attachmentId: session.attachmentId,
              method: "app/shortcut/pressed",
              params: { accelerator },
            }),
          ),
        );
        if (!registered) return refuse("shortcut-taken");
        shortcuts.set(canonical, { installId, accelerator });
        return OK;
      }
    }
  });

  // Requests run one at a time, and each reads the page's file. A window may keep only a few
  // waiting, so a page cannot hold up "Turn off all" or the other installed pages.
  const waiting = new Map<number, number>();
  const admitted = <A>(webContentsId: number, effect: Effect.Effect<A>, refused: A) =>
    Effect.suspend(() => {
      const count = waiting.get(webContentsId) ?? 0;
      if (count >= REQUESTS_WAITING_LIMIT) return Effect.succeed(refused);
      waiting.set(webContentsId, count + 1);
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const left = (waiting.get(webContentsId) ?? 1) - 1;
            if (left > 0) waiting.set(webContentsId, left);
            else waiting.delete(webContentsId);
          }),
        ),
      );
    });

  const power: ArtifactAppPowerService["Service"]["power"] = (webContentsId, input) =>
    admitted(webContentsId, answer(webContentsId, input), refuse("rate-limited"));
  const answer = (
    webContentsId: number,
    input: DesktopArtifactAppPowerInput,
  ): Effect.Effect<DesktopArtifactAppPowerReply> =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const installId = yield* windows.installIdForWebContents(webContentsId);
          if (Option.isNone(installId)) return refuse("not-allowed");
          const session = sessions.get(installId.value);
          // Only the version this window has open may ask.
          if (session === undefined || session.attachmentId !== input.attachmentId) {
            return refuse("not-allowed");
          }
          const request = readArtifactAppPowerRequest(input.method, input.params);
          if (request === undefined) return refuse("invalid-request");
          const verified = yield* verify(installId.value, session);
          if (Option.isNone(verified)) {
            // The grant ended (the file changed, the frame left, it was turned off): nothing stays.
            yield* releaseUnlocked(installId.value);
            return refuse("not-allowed");
          }
          if (!verified.value.powers.includes(request.power)) return refuse("not-allowed");
          return yield* run(installId.value, session, request, verified.value);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          logWarning("installed page power request failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(refuse("not-allowed")),
          ),
        ),
      );

  const state = (installId: string, session: Session) =>
    Effect.gen(function* () {
      const { version, powers } = yield* grantedNow(installId, session.attachmentId);
      // Asked after the file was read: a frame that left its version has no powers to show.
      const standing =
        (yield* windows.isFrameOnVersion(installId)) && sessions.get(installId) === session;
      const permissions: DesktopArtifactAppPermissions = {
        attachmentId: session.attachmentId,
        declared: Option.match(version, {
          onNone: () => session.declared,
          onSome: (read) => read.declared,
        }),
        granted: standing ? powers : [],
      };
      return permissions;
    });

  /** Shows the native dialog for these bytes and saves the answer against their hash. */
  const askConsent = Effect.fnUntraced(function* (
    installId: string,
    session: Session,
    version: VersionRead,
  ) {
    const window = yield* windows.windowForInstall(installId);
    // No window to ask in means no question and no grant.
    if (Option.isNone(window) || asking.has(installId)) return;
    asking.add(installId);
    const response = yield* dialogs
      .showMessageBox(
        window,
        artifactAppConsentDialog({
          name: version.app.name,
          powers: version.declared,
          platform: host.platform,
        }),
      )
      .pipe(
        Effect.catchCause(() => Effect.succeed(-1)),
        Effect.ensuring(Effect.sync(() => asking.delete(installId))),
      );
    // The window closed or moved to another version while the dialog was up: the answer is for nothing.
    if (sessions.get(installId) !== session) return;
    // Only the Allow button allows. A closed dialog, a failed one and any other number do not.
    const allowed = response === ARTIFACT_APP_CONSENT_ALLOW;
    const key = versionKey(installId, session.attachmentId);
    if (!allowed) turnedOff.set(key, version.sha256);
    // A new answer starts clean: what an earlier answer let the page hold may not be in this one.
    yield* release(installId);
    const saved = yield* grants
      .record({
        installId,
        attachmentId: session.attachmentId,
        // The bytes read before the dialog are the ones the person was asked about.
        sha256: version.sha256,
        powers: allowed ? version.declared : [],
        answeredAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logWarning("installed page consent could not be saved", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
    // The newest answer is Allow: an earlier "off" from this run no longer stands. What is
    // granted still comes from the saved answer alone.
    if (allowed) turnedOff.delete(key);
    yield* logInfo("installed page consent answered", { installId, allowed, saved });
  });

  const open = Effect.fnUntraced(function* (
    installId: string,
    input: Extract<DesktopArtifactAppPermissionsInput, { action: "open" }>,
  ) {
    // Whatever the window showed before holds nothing from here on.
    yield* release(installId);
    const session: Session = {
      attachmentId: input.attachmentId,
      declared: [],
      tray: undefined,
      onTop: false,
    };
    sessions.set(installId, session);
    yield* windows.setVersionUrl(installId, Option.some(input.url));
    const version = yield* readVersion(installId, input.attachmentId);
    if (Option.isNone(version) || sessions.get(installId) !== session) {
      return yield* state(installId, session);
    }
    session.declared = version.value.declared;
    // A version that declares nothing never asks.
    if (version.value.declared.length === 0) return yield* state(installId, session);
    const grant = yield* grants.find(installId, input.attachmentId);
    const answered =
      (Option.isSome(grant) && grant.value.sha256 === version.value.sha256) ||
      isTurnedOff(installId, input.attachmentId, version.value.sha256);
    if (!answered) yield* askConsent(installId, session, version.value);
    return yield* state(installId, session);
  });

  const turnOff = Effect.fnUntraced(function* (installId: string, session: Session) {
    // First, and in memory: the grant is over even if nothing below works.
    const key = versionKey(installId, session.attachmentId);
    turnedOff.set(key, null);
    yield* release(installId);
    const version = yield* readVersion(installId, session.attachmentId);
    // Once the bytes are known the refusal is for them; a changed file asks again.
    if (Option.isSome(version)) turnedOff.set(key, version.value.sha256);
    const earlier = yield* grants.find(installId, session.attachmentId);
    const sha256 = Option.isSome(version)
      ? version.value.sha256
      : Option.isSome(earlier)
        ? earlier.value.sha256
        : undefined;
    if (sha256 !== undefined) {
      yield* grants
        .record({
          installId,
          attachmentId: session.attachmentId,
          sha256,
          powers: [],
          answeredAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.catchCause((cause) =>
            logWarning("installed page powers were turned off but not saved", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
    return yield* state(installId, session);
  });

  const permissions: ArtifactAppPowerService["Service"]["permissions"] = (webContentsId, input) =>
    Effect.gen(function* () {
      const installId = yield* windows.installIdForWebContents(webContentsId);
      if (Option.isNone(installId)) return NO_PERMISSIONS;
      if (input.action === "open") return yield* open(installId.value, input);
      const session = sessions.get(installId.value);
      if (input.action === "close") {
        yield* release(installId.value);
        sessions.delete(installId.value);
        yield* windows.setVersionUrl(installId.value, Option.none());
        return NO_PERMISSIONS;
      }
      if (session === undefined) return NO_PERMISSIONS;
      if (input.action === "turn-off") return yield* turnOff(installId.value, session);
      if (input.action === "ask") {
        const version = yield* readVersion(installId.value, session.attachmentId);
        if (Option.isSome(version) && version.value.declared.length > 0) {
          session.declared = version.value.declared;
          yield* askConsent(installId.value, session, version.value);
        }
      }
      return yield* state(installId.value, session);
    }).pipe(
      Effect.catchCause((cause) =>
        logWarning("installed page permissions request failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(NO_PERMISSIONS)),
      ),
    );

  return ArtifactAppPowerService.of({ permissions, power });
});

export const layer = Layer.effect(ArtifactAppPowerService, make);
