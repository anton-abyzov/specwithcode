// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test hashes a file to compare with the saved answer.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopArtifactApp,
  DesktopArtifactAppPowerEvent,
  DesktopArtifactAppPowerReply,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ArtifactAppGrants from "./ArtifactAppGrants.ts";
import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import * as ArtifactAppPowerService from "./ArtifactAppPowerService.ts";
import * as ArtifactAppPowersHost from "./ArtifactAppPowersHost.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);
const WC = 42;
const OTHER_WC = 43;
const V1 = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const V2 = "thread-1-1f8fad5b-d9cb-469f-a165-70867728950e-html";
const URL_1 = "http://127.0.0.1:3773/assets/v1?token=t";
const ALL = ["notifications", "tray", "always-on-top", "global-shortcuts"] as const;

const page = (permissions: ReadonlyArray<string> | null, body = "page") =>
  `<!doctype html><html><head>${
    permissions === null
      ? ""
      : `<script type="application/specwithcode-app+json">${JSON.stringify({ permissions })}</script>`
  }</head><body>${body}</body></html>`;

const appFor = (installId: string, environmentId = "environment-local"): DesktopArtifactApp => ({
  installId,
  name: installId === ID ? "Bonsai" : "Other",
  environmentId,
  threadId: "thread-1",
  attachmentId: V1,
  title: "Bonsai",
  installedAt: "2026-11-24T12:00:00.000Z",
});

interface FakeTray {
  readonly input: ArtifactAppPowersHost.ArtifactAppTrayInput;
  destroyed: boolean;
}

interface Fixture {
  readonly powers: ArtifactAppPowerService.ArtifactAppPowerService["Service"];
  readonly grants: ArtifactAppGrants.ArtifactAppGrants["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
  readonly grantsPath: string;
  readonly writePage: (attachmentId: string, html: string) => Effect.Effect<void>;
  /** The button the next dialogs answer with. */
  answer: number;
  /** When set, a dialog waits on it before answering. */
  dialogGate: Deferred.Deferred<void> | undefined;
  readonly dialogs: Array<Electron.MessageBoxOptions>;
  readonly apps: Map<string, DesktopArtifactApp>;
  localPages: Option.Option<ArtifactAppPowersHost.ArtifactAppLocalPages>;
  readonly windowIds: Map<number, string>;
  readonly liveWindows: Map<string, Electron.BrowserWindow>;
  readonly onVersion: Map<string, boolean>;
  readonly versionUrls: Array<readonly [string, string | null]>;
  readonly closedListeners: Array<(installId: string) => void>;
  readonly strayedListeners: Array<(installId: string) => void>;
  /** When set, finding the page's file waits on it: a request stays in flight. */
  pagesGate: Deferred.Deferred<void> | undefined;
  readonly opened: Array<string>;
  readonly closed: Array<string>;
  readonly notifications: Array<{ title: string; body: string; onClick: () => void }>;
  notificationsSupported: boolean;
  readonly trays: Array<FakeTray>;
  trayAvailable: boolean;
  readonly registered: Map<string, () => void>;
  /** Accelerators some other app holds. */
  readonly takenElsewhere: Set<string>;
  appAccelerators: Option.Option<ReadonlyArray<string>>;
  readonly onTop: Map<Electron.BrowserWindow, boolean>;
  readonly sent: Array<{ window: Electron.BrowserWindow; channel: string; payload: unknown }>;
  failGrantWrites: boolean;
}

const windowOf = (installId: string) => ({ installId }) as unknown as Electron.BrowserWindow;

const withFixture = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  options: { readonly platform?: NodeJS.Platform } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A private test home per test; nothing touches the person's attachments or user data.
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-desktop-artifact-app-powers-test-",
    });
    const attachmentsDir = path.join(home, "userdata", "attachments");
    yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
    const grantsPath = path.join(home, "userdata", ArtifactAppGrants.ARTIFACT_APP_GRANTS_FILE);

    const state = {
      fileSystem,
      attachmentsDir,
      grantsPath,
      writePage: (attachmentId: string, html: string) =>
        fileSystem
          .writeFileString(path.join(attachmentsDir, `${attachmentId}.html`), html)
          .pipe(Effect.orDie),
      answer: 0,
      dialogGate: undefined,
      dialogs: [],
      apps: new Map([
        [ID, appFor(ID)],
        [OTHER_ID, appFor(OTHER_ID)],
      ]),
      localPages: Option.some({ environmentId: "environment-local", attachmentsDir }),
      windowIds: new Map([
        [WC, ID],
        [OTHER_WC, OTHER_ID],
      ]),
      liveWindows: new Map([
        [ID, windowOf(ID)],
        [OTHER_ID, windowOf(OTHER_ID)],
      ]),
      onVersion: new Map(),
      versionUrls: [],
      closedListeners: [],
      strayedListeners: [],
      pagesGate: undefined,
      opened: [],
      closed: [],
      notifications: [],
      notificationsSupported: true,
      trays: [],
      trayAvailable: true,
      registered: new Map(),
      takenElsewhere: new Set(),
      appAccelerators: Option.some(["CmdOrCtrl+Shift+P", "CmdOrCtrl+C"]),
      onTop: new Map(),
      sent: [],
      failGrantWrites: false,
    } as Omit<Fixture, "powers" | "grants"> as Fixture;

    const hostLayer = Layer.succeed(
      ArtifactAppPowersHost.ArtifactAppPowersHost,
      ArtifactAppPowersHost.ArtifactAppPowersHost.of({
        platform: options.platform ?? "darwin",
        localPages: Effect.gen(function* () {
          if (state.pagesGate !== undefined) yield* Deferred.await(state.pagesGate);
          return state.localPages;
        }),
        showNotification: (input) =>
          Effect.sync(() => {
            if (!state.notificationsSupported) return false;
            state.notifications.push(input);
            return true;
          }),
        createTray: (input) =>
          Effect.sync(() => {
            if (!state.trayAvailable) return Option.none();
            const tray: FakeTray = { input, destroyed: false };
            state.trays.push(tray);
            return Option.some({
              destroy: () => {
                tray.destroyed = true;
              },
            });
          }),
        registerShortcut: (accelerator, onPress) =>
          Effect.sync(() => {
            if (state.takenElsewhere.has(accelerator) || state.registered.has(accelerator)) {
              return false;
            }
            state.registered.set(accelerator, onPress);
            return true;
          }),
        unregisterShortcut: (accelerator) =>
          Effect.sync(() => {
            state.registered.delete(accelerator);
          }),
        isShortcutRegistered: (accelerator) => Effect.sync(() => state.registered.has(accelerator)),
        appAccelerators: Effect.sync(() => state.appAccelerators),
        setAlwaysOnTop: (window, on) =>
          Effect.sync(() => {
            state.onTop.set(window, on);
            return true;
          }),
        sendToWindow: (window, channel, payload) =>
          Effect.sync(() => {
            state.sent.push({ window, channel, payload });
          }),
      }),
    );
    const windowsLayer = Layer.mock(ArtifactAppWindows.ArtifactAppWindows)({
      installIdForWebContents: (id) =>
        Effect.sync(() => {
          const installId = state.windowIds.get(id);
          return installId !== undefined && state.liveWindows.has(installId)
            ? Option.some(installId)
            : Option.none();
        }),
      windowForInstall: (installId) =>
        Effect.sync(() => Option.fromUndefinedOr(state.liveWindows.get(installId))),
      setVersionUrl: (installId, url) =>
        Effect.sync(() => {
          state.versionUrls.push([installId, Option.getOrNull(url)]);
          state.onVersion.set(installId, Option.isSome(url));
        }),
      isFrameOnVersion: (installId) => Effect.sync(() => state.onVersion.get(installId) === true),
      onClosed: (listener) =>
        Effect.sync(() => {
          state.closedListeners.push(listener);
        }),
      onFrameStrayed: (listener) =>
        Effect.sync(() => {
          state.strayedListeners.push(listener);
        }),
      open: (installId) =>
        Effect.sync(() => {
          state.opened.push(installId);
          return "focused" as const;
        }),
      close: (installId) =>
        Effect.sync(() => {
          state.closed.push(installId);
        }),
    });
    const recordsLayer = Layer.mock(ArtifactAppRecords.ArtifactAppRecords)({
      get: (installId) => Effect.sync(() => Option.fromUndefinedOr(state.apps.get(installId))),
    });
    // Only the dialog seam is used; the rest of the installer's host is not this test's.
    const dialogsLayer = Layer.succeed(ArtifactAppInstaller.ArtifactAppInstallerHost, {
      showMessageBox: (_owner: unknown, dialog: Electron.MessageBoxOptions) =>
        Effect.gen(function* () {
          state.dialogs.push(dialog);
          if (state.dialogGate !== undefined) yield* Deferred.await(state.dialogGate);
          return state.answer;
        }),
    } as unknown as ArtifactAppInstaller.ArtifactAppInstallerHost["Service"]);
    // The real store on a private file, with writes that can be made to fail.
    const grantsLayer = Layer.effect(
      ArtifactAppGrants.ArtifactAppGrants,
      Effect.gen(function* () {
        const real = yield* Effect.service(ArtifactAppGrants.ArtifactAppGrants).pipe(
          Effect.provide(ArtifactAppGrants.layer(grantsPath)),
        );
        const failing = (
          effect: Effect.Effect<void, ArtifactAppGrants.ArtifactAppGrantsWriteError>,
        ): Effect.Effect<void, ArtifactAppGrants.ArtifactAppGrantsWriteError> =>
          Effect.suspend(() =>
            state.failGrantWrites
              ? Effect.fail(
                  new ArtifactAppGrants.ArtifactAppGrantsWriteError({
                    operation: "replace-file",
                    path: grantsPath,
                    cause: new Error("disk full"),
                  }),
                )
              : effect,
          );
        return ArtifactAppGrants.ArtifactAppGrants.of({
          find: real.find,
          record: (grant) => failing(real.record(grant)),
          forget: (installId) => failing(real.forget(installId)),
        });
      }),
    );
    const powers = yield* Effect.service(ArtifactAppPowerService.ArtifactAppPowerService).pipe(
      Effect.provide(
        ArtifactAppPowerService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(hostLayer, windowsLayer, recordsLayer, dialogsLayer, grantsLayer),
          ),
        ),
      ),
    );
    const grants = yield* Effect.service(ArtifactAppGrants.ArtifactAppGrants).pipe(
      Effect.provide(ArtifactAppGrants.layer(grantsPath)),
    );
    return yield* body(Object.assign(state, { powers, grants }));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const open = (fixture: Fixture, attachmentId = V1, url = URL_1, wc = WC) =>
  fixture.powers.permissions(wc, { action: "open", attachmentId, url });

const ask = (
  fixture: Fixture,
  method: string,
  params: unknown,
  options: { readonly attachmentId?: string; readonly wc?: number } = {},
) =>
  fixture.powers.power(options.wc ?? WC, {
    attachmentId: options.attachmentId ?? V1,
    method,
    params,
  });

const notify = (
  fixture: Fixture,
  options?: { readonly attachmentId?: string; readonly wc?: number },
) => ask(fixture, "app/notify", { title: "Break", body: "Stand up" }, options);

const REFUSED: DesktopArtifactAppPowerReply = { ok: false, error: "not-allowed" };
const OK: DesktopArtifactAppPowerReply = { ok: true };

/** Opens V1 declaring every power, with the person pressing Allow. */
const granted = (fixture: Fixture) =>
  Effect.gen(function* () {
    yield* fixture.writePage(V1, page(ALL));
    fixture.answer = 0;
    const state = yield* open(fixture);
    assert.deepEqual(state.granted, [...ALL]);
    return state;
  });

/** Lets the forked reactions to a press, a click or a closed window finish. */
const settle = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      // @effect-diagnostics-next-line globalTimers:off -- The reactions read real files; the test clock does not move them.
      setTimeout(resolve, 20);
    }),
);

describe("ArtifactAppPowerService consent", () => {
  it.effect(
    "asks once per version, with Cancel as the default, and saves the answer for its bytes",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.writePage(V1, page(["tray", "notifications"]));
          const state = yield* open(fixture);
          assert.deepEqual(state, {
            attachmentId: V1,
            declared: ["notifications", "tray"],
            granted: ["notifications", "tray"],
          });
          assert.equal(fixture.dialogs.length, 1);
          const [dialog] = fixture.dialogs;
          assert.equal(dialog?.message, "Allow Bonsai to do this on your computer?");
          assert.deepEqual(dialog?.buttons, ["Allow", "Cancel"]);
          assert.equal(dialog?.defaultId, 1);
          assert.equal(dialog?.cancelId, 1);
          assert.include(dialog?.detail, "Show notifications");
          assert.include(dialog?.detail, "Add an item to the menu bar");
          assert.notInclude(dialog?.detail, "keyboard shortcuts");
          // The frame may be at this version's address and nowhere else.
          assert.deepEqual(fixture.versionUrls, [[ID, URL_1]]);

          const html = yield* fixture.fileSystem.readFile(`${fixture.attachmentsDir}/${V1}.html`);
          const sha256 = NodeCrypto.createHash("sha256").update(html).digest("hex");
          const saved = yield* fixture.grants.find(ID, V1);
          assert.equal(Option.getOrUndefined(saved)?.sha256, sha256);
          assert.deepEqual(Option.getOrUndefined(saved)?.powers, ["notifications", "tray"]);

          // Opening the same bytes again does not ask.
          assert.deepEqual((yield* open(fixture)).granted, ["notifications", "tray"]);
          assert.equal(fixture.dialogs.length, 1);
          assert.deepEqual(yield* notify(fixture), OK);
        }),
      ),
  );

  it.effect("grants nothing unless the person pressed Allow", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.writePage(V1, page(ALL));
        yield* fixture.writePage(V2, page(ALL));
        // Cancel, a closed or failed dialog, and any other number.
        for (const [index, answer] of [1, -1, 2, Number.NaN].entries()) {
          fixture.answer = answer;
          const version = index % 2 === 0 ? V1 : V2;
          // A fresh file each time, so every round asks.
          yield* fixture.writePage(version, page(ALL, `round ${index}`));
          const state = yield* open(fixture, version);
          assert.deepEqual(state.granted, [], String(answer));
          assert.deepEqual(state.declared, [...ALL]);
          assert.equal(fixture.dialogs.length, index + 1);
          assert.deepEqual(yield* notify(fixture, { attachmentId: version }), REFUSED);
        }
        assert.deepEqual(fixture.notifications, []);
        // A "no" is remembered: the same bytes do not ask again.
        fixture.answer = 0;
        const before = fixture.dialogs.length;
        assert.deepEqual((yield* open(fixture, V2)).granted, []);
        assert.equal(fixture.dialogs.length, before);
      }),
    ),
  );

  it.effect("asks again for a newer version and for the same version when its file changed", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        assert.equal(fixture.dialogs.length, 1);

        // A newer version of the page: its own question, and Cancel grants nothing.
        yield* fixture.writePage(V2, page(ALL));
        fixture.answer = 1;
        assert.deepEqual((yield* open(fixture, V2)).granted, []);
        assert.equal(fixture.dialogs.length, 2);
        assert.deepEqual(yield* notify(fixture, { attachmentId: V2 }), REFUSED);

        // The first version again, unchanged: still allowed, no question.
        assert.deepEqual((yield* open(fixture, V1)).granted, [...ALL]);
        assert.equal(fixture.dialogs.length, 2);

        // The same version with other bytes: the old answer says nothing about them.
        yield* fixture.writePage(V1, page(ALL, "rewritten by an agent"));
        assert.deepEqual((yield* open(fixture, V1)).granted, []);
        assert.equal(fixture.dialogs.length, 3);
        assert.deepEqual(yield* notify(fixture), REFUSED);
      }),
    ),
  );

  it.effect("never asks for a version that declares nothing", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        for (const html of [page(null), page([]), page(["files", "run-programs"]), "{not html"]) {
          yield* fixture.writePage(V1, html);
          assert.deepEqual(yield* open(fixture), { attachmentId: V1, declared: [], granted: [] });
        }
        assert.deepEqual(fixture.dialogs, []);
        assert.deepEqual(yield* notify(fixture), REFUSED);
        // The frame is still held to the version.
        assert.deepEqual(fixture.versionUrls.at(-1), [ID, URL_1]);
      }),
    ),
  );

  it.effect("drops an answer given after the window moved to another version", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.writePage(V1, page(ALL));
        yield* fixture.writePage(V2, page(null));
        fixture.dialogGate = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(open(fixture, V1));
        yield* settle;
        assert.equal(fixture.dialogs.length, 1);
        // The window moves on while the dialog is still up.
        assert.deepEqual((yield* open(fixture, V2)).granted, []);
        fixture.answer = 0;
        yield* Deferred.succeed(fixture.dialogGate, undefined);
        yield* Fiber.join(first);
        assert.isTrue(Option.isNone(yield* fixture.grants.find(ID, V1)));
        assert.deepEqual(yield* notify(fixture), REFUSED);
        assert.deepEqual(yield* notify(fixture, { attachmentId: V2 }), REFUSED);
      }),
    ),
  );

  it.effect("keeps an Allow that could not be saved from granting anything", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.writePage(V1, page(ALL));
        fixture.failGrantWrites = true;
        assert.deepEqual((yield* open(fixture)).granted, []);
        assert.deepEqual(yield* notify(fixture), REFUSED);
      }),
    ),
  );
});

describe("ArtifactAppPowerService refusals", () => {
  it.effect("refuses every request it cannot tie to a granted, unchanged, open version", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        assert.deepEqual(yield* notify(fixture), OK);
        const expectRefused = (label: string, change: () => void, restore: () => void) =>
          Effect.gen(function* () {
            change();
            assert.deepEqual(yield* notify(fixture), REFUSED, label);
            restore();
            // Back as it was, the same request is allowed again: the change was the only reason.
            assert.deepEqual(yield* notify(fixture), OK, `${label} (restored)`);
          });

        // The caller is not an installed page's window.
        assert.deepEqual(yield* notify(fixture, { wc: 7 }), REFUSED);
        // Another install's window has no grant of its own.
        assert.deepEqual(yield* notify(fixture, { wc: OTHER_WC }), REFUSED);
        // A version other than the one the window has open.
        assert.deepEqual(yield* notify(fixture, { attachmentId: V2 }), REFUSED);
        assert.deepEqual(yield* notify(fixture, { attachmentId: `../${V1}` }), REFUSED);

        yield* expectRefused(
          "the window cannot be found",
          () => fixture.liveWindows.delete(ID),
          () => fixture.liveWindows.set(ID, windowOf(ID)),
        );
        yield* expectRefused(
          "a frame left the version",
          () => fixture.onVersion.set(ID, false),
          () => fixture.onVersion.set(ID, true),
        );
        const app = fixture.apps.get(ID)!;
        yield* expectRefused(
          "the install is no longer recorded",
          () => fixture.apps.delete(ID),
          () => fixture.apps.set(ID, app),
        );
        yield* expectRefused(
          "the page belongs to another machine",
          () => fixture.apps.set(ID, appFor(ID, "environment-remote")),
          () => fixture.apps.set(ID, app),
        );
        const local = fixture.localPages;
        yield* expectRefused(
          "this machine's pages cannot be located",
          () => {
            fixture.localPages = Option.none();
          },
          () => {
            fixture.localPages = local;
          },
        );
        yield* expectRefused(
          "the pages folder is another one",
          () => {
            fixture.localPages = Option.some({
              environmentId: "environment-local",
              attachmentsDir: `${fixture.attachmentsDir}-missing`,
            });
          },
          () => {
            fixture.localPages = local;
          },
        );
        assert.equal(fixture.notifications.length, 7);
      }),
    ),
  );

  it.effect("refuses when the grants cannot be read, are malformed or name other bytes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const good = yield* fixture.fileSystem.readFileString(fixture.grantsPath);
        const document = JSON.parse(good) as { grants: Array<Record<string, unknown>> };
        const [grant] = document.grants;
        for (const contents of [
          "{not json",
          "",
          JSON.stringify({ version: 2, grants: document.grants }),
          JSON.stringify({ version: 1, grants: [] }),
          JSON.stringify({ version: 1, grants: [{ ...grant, sha256: "0".repeat(64) }] }),
          JSON.stringify({ version: 1, grants: [{ ...grant, powers: ["tray"] }] }),
          JSON.stringify({ version: 1, grants: [{ ...grant, powers: [] }] }),
          JSON.stringify({ version: 1, grants: [{ ...grant, installId: OTHER_ID }] }),
          JSON.stringify({ version: 1, grants: [{ ...grant, attachmentId: V2 }] }),
          JSON.stringify({ version: 1, grants: [grant, grant] }),
        ]) {
          yield* fixture.fileSystem.writeFileString(fixture.grantsPath, contents);
          assert.deepEqual(yield* notify(fixture), REFUSED, contents.slice(0, 60));
        }
        yield* fixture.fileSystem.remove(fixture.grantsPath);
        assert.deepEqual(yield* notify(fixture), REFUSED, "missing");
        // A folder where the file should be: unreadable.
        yield* fixture.fileSystem.makeDirectory(fixture.grantsPath);
        assert.deepEqual(yield* notify(fixture), REFUSED, "unreadable");
        yield* fixture.fileSystem.remove(fixture.grantsPath, { recursive: true });
        yield* fixture.fileSystem.writeFileString(fixture.grantsPath, good);
        assert.deepEqual(yield* notify(fixture), OK);
      }),
    ),
  );

  it.effect(
    "refuses once the page's file changed, went missing or is not a file, and releases what it held",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const original = page(ALL);
          const filePath = `${fixture.attachmentsDir}/${V1}.html`;
          for (const [label, change] of [
            ["rewritten", fixture.writePage(V1, page(ALL, "rewritten"))],
            ["one byte appended", fixture.writePage(V1, `${original} `)],
            ["manifest dropped", fixture.writePage(V1, page(null))],
            ["removed", fixture.fileSystem.remove(filePath).pipe(Effect.orDie)],
            [
              "a folder",
              fixture.fileSystem
                .remove(filePath)
                .pipe(Effect.andThen(fixture.fileSystem.makeDirectory(filePath)), Effect.orDie),
            ],
          ] as const) {
            yield* fixture.fileSystem.remove(filePath, { recursive: true, force: true });
            yield* fixture.fileSystem.remove(fixture.grantsPath, { force: true });
            yield* granted(fixture);
            assert.deepEqual(
              yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] }),
              OK,
              label,
            );
            assert.deepEqual(
              yield* ask(fixture, "app/shortcut/register", { accelerator: "CmdOrCtrl+Alt+B" }),
              OK,
              label,
            );
            assert.deepEqual(
              yield* ask(fixture, "app/window/always-on-top", { on: true }),
              OK,
              label,
            );
            const tray = fixture.trays.at(-1)!;
            const press = fixture.registered.get("Command+Alt+B")!;

            yield* change;
            const sentBefore = fixture.sent.length;
            // A press after the change tells the page nothing, and ends everything it held.
            press();
            yield* settle;
            assert.equal(fixture.sent.length, sentBefore, label);
            assert.isTrue(tray.destroyed, label);
            assert.deepEqual([...fixture.registered.keys()], [], label);
            assert.equal(fixture.onTop.get(fixture.liveWindows.get(ID)!), false, label);
            assert.deepEqual(yield* notify(fixture), REFUSED, label);
            assert.deepEqual(
              yield* ask(fixture, "app/shortcut/register", { accelerator: "CmdOrCtrl+Alt+B" }),
              REFUSED,
              label,
            );
          }
          assert.deepEqual(fixture.notifications, []);
        }),
      ),
  );

  it.effect("refuses a power the answer does not include, and leaves the others alone", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.writePage(V1, page(["tray"]));
        assert.deepEqual((yield* open(fixture)).granted, ["tray"]);
        assert.deepEqual(yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] }), OK);
        assert.deepEqual(yield* notify(fixture), REFUSED);
        assert.deepEqual(yield* ask(fixture, "app/window/always-on-top", { on: true }), REFUSED);
        assert.deepEqual(
          yield* ask(fixture, "app/shortcut/register", { accelerator: "CmdOrCtrl+Alt+B" }),
          REFUSED,
        );
        assert.isFalse(fixture.trays[0]?.destroyed);
        assert.deepEqual(fixture.notifications, []);
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.deepEqual([...fixture.onTop.values()], []);
      }),
    ),
  );

  it.effect("answers malformed requests with an error and does nothing", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const invalid: DesktopArtifactAppPowerReply = { ok: false, error: "invalid-request" };
        assert.deepEqual(yield* ask(fixture, "app/files/read", { path: "/etc/passwd" }), invalid);
        assert.deepEqual(yield* ask(fixture, "app/notify", { title: "" }), invalid);
        assert.deepEqual(yield* ask(fixture, "app/notify", null), invalid);
        assert.deepEqual(
          yield* ask(fixture, "app/shortcut/register", { accelerator: "Ctrl+C" }),
          invalid,
        );
        assert.deepEqual(fixture.notifications, []);
        assert.deepEqual([...fixture.registered.keys()], []);
      }),
    ),
  );
});

describe("ArtifactAppPowerService powers", () => {
  it.effect(
    "shows notifications under the app's name, focuses on click, and caps them at ten a minute",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* granted(fixture);
          for (let index = 0; index < 10; index += 1) assert.deepEqual(yield* notify(fixture), OK);
          assert.deepEqual(yield* notify(fixture), { ok: false, error: "rate-limited" });
          assert.equal(fixture.notifications.length, 10);
          assert.equal(fixture.notifications[0]?.title, "Bonsai");
          assert.equal(fixture.notifications[0]?.body, "Break\nStand up");
          fixture.notifications[0]?.onClick();
          yield* settle;
          assert.deepEqual(fixture.opened, [ID]);
          // Opening the version again does not reset the count.
          yield* open(fixture);
          assert.deepEqual(yield* notify(fixture), { ok: false, error: "rate-limited" });
          yield* TestClock.adjust("61 seconds");
          assert.deepEqual(yield* notify(fixture), OK);
          fixture.notificationsSupported = false;
          assert.deepEqual(yield* notify(fixture), { ok: false, error: "unavailable" });
        }),
      ),
  );

  it.effect("keeps one tray item per install and tells the page which item was clicked", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const set = (label: string) =>
          ask(fixture, "app/tray/set", {
            title: "5m",
            tooltip: "Break timer",
            items: [
              { id: "start", label },
              { id: "stop", label: "Stop" },
            ],
          });
        assert.deepEqual(yield* set("Start"), OK);
        assert.deepEqual(yield* set("Resume"), OK);
        // The second call replaced the first: one item at a time.
        assert.equal(fixture.trays.length, 2);
        assert.isTrue(fixture.trays[0]?.destroyed);
        const tray = fixture.trays[1]!;
        assert.isFalse(tray.destroyed);
        assert.equal(tray.input.title, "5m");
        assert.equal(tray.input.tooltip, "Bonsai: Break timer");
        assert.deepEqual(
          tray.input.items.map((item) => item.label),
          ["Resume", "Stop"],
        );
        assert.equal(tray.input.openLabel, "Open Bonsai");
        assert.equal(tray.input.closeLabel, "Close Bonsai");

        tray.input.items[1]?.onClick();
        tray.input.onOpen();
        tray.input.onClose();
        yield* settle;
        const event: DesktopArtifactAppPowerEvent = {
          attachmentId: V1,
          method: "app/tray/clicked",
          params: { id: "stop" },
        };
        assert.deepEqual(fixture.sent, [
          {
            window: fixture.liveWindows.get(ID)!,
            channel: "desktop:artifact-app-power-event",
            payload: event,
          },
        ]);
        assert.deepEqual(fixture.opened, [ID]);
        assert.deepEqual(fixture.closed, [ID]);

        // The item goes away when the window closes.
        fixture.liveWindows.delete(ID);
        for (const listener of fixture.closedListeners) listener(ID);
        yield* settle;
        assert.isTrue(tray.destroyed);

        fixture.liveWindows.set(ID, windowOf(ID));
        yield* open(fixture);
        fixture.trayAvailable = false;
        assert.deepEqual(yield* set("Start"), { ok: false, error: "unavailable" });
      }),
    ),
  );

  it.effect("keeps the window above others and stops when asked", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const window = fixture.liveWindows.get(ID)!;
        assert.deepEqual(yield* ask(fixture, "app/window/always-on-top", { on: true }), OK);
        assert.equal(fixture.onTop.get(window), true);
        assert.deepEqual(yield* ask(fixture, "app/window/always-on-top", { on: false }), OK);
        assert.equal(fixture.onTop.get(window), false);
      }),
    ),
  );

  it.effect("registers only free accelerators, at most four, and reports a press", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* fixture.writePage(V2, page(ALL));
        yield* open(fixture, V2, URL_1, OTHER_WC);
        const register = (accelerator: string, wc = WC) =>
          ask(
            fixture,
            "app/shortcut/register",
            { accelerator },
            { wc, attachmentId: wc === WC ? V1 : V2 },
          );
        const taken: DesktopArtifactAppPowerReply = { ok: false, error: "shortcut-taken" };

        assert.deepEqual(yield* register("CmdOrCtrl+Shift+B"), OK);
        assert.deepEqual([...fixture.registered.keys()], ["Command+Shift+B"]);
        // The same page asking again, in another spelling, already has it.
        assert.deepEqual(yield* register("Shift+Cmd+b"), OK);
        // Another install cannot take it.
        assert.deepEqual(yield* register("CmdOrCtrl+Shift+B", OTHER_WC), taken);
        // The app's own accelerator, a system one, and one another app holds.
        assert.deepEqual(yield* register("CmdOrCtrl+Shift+P"), taken);
        assert.deepEqual(yield* register("Cmd+Shift+4"), taken);
        fixture.takenElsewhere.add("Command+Alt+K");
        assert.deepEqual(yield* register("Cmd+Alt+K"), taken);
        // Without the app's accelerators there is no telling: refused.
        const known = fixture.appAccelerators;
        fixture.appAccelerators = Option.none();
        assert.deepEqual(yield* register("Cmd+Alt+J"), taken);
        fixture.appAccelerators = known;
        assert.deepEqual([...fixture.registered.keys()], ["Command+Shift+B"]);

        for (const accelerator of ["Cmd+Alt+1", "Cmd+Alt+2", "Cmd+Alt+3"]) {
          assert.deepEqual(yield* register(accelerator), OK);
        }
        assert.deepEqual(yield* register("Cmd+Alt+4"), { ok: false, error: "shortcut-limit" });
        assert.equal(fixture.registered.size, 4);
        // The limit is per install.
        assert.deepEqual(yield* register("Cmd+Alt+4", OTHER_WC), OK);

        fixture.registered.get("Command+Shift+B")?.();
        yield* settle;
        assert.deepEqual(fixture.sent.at(-1)?.payload, {
          attachmentId: V1,
          method: "app/shortcut/pressed",
          params: { accelerator: "CmdOrCtrl+Shift+B" },
        });
        assert.equal(fixture.sent.at(-1)?.window, fixture.liveWindows.get(ID));

        assert.deepEqual(
          yield* ask(fixture, "app/shortcut/unregister", { accelerator: "Cmd+Alt+1" }),
          OK,
        );
        // Unregistering another install's shortcut changes nothing.
        assert.deepEqual(
          yield* ask(fixture, "app/shortcut/unregister", { accelerator: "Cmd+Alt+4" }),
          OK,
        );
        assert.deepEqual([...fixture.registered.keys()].toSorted(), [
          "Command+Alt+2",
          "Command+Alt+3",
          "Command+Alt+4",
          "Command+Shift+B",
        ]);
      }),
    ),
  );

  it.effect("releases a page's shortcuts when its window closes or its version changes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* fixture.writePage(V2, page(ALL));
        yield* open(fixture, V2, URL_1, OTHER_WC);
        const register = (accelerator: string, wc = WC) =>
          ask(
            fixture,
            "app/shortcut/register",
            { accelerator },
            { wc, attachmentId: wc === WC ? V1 : V2 },
          );
        yield* register("Cmd+Alt+1");
        yield* register("Cmd+Alt+2", OTHER_WC);
        yield* ask(fixture, "app/window/always-on-top", { on: true });
        yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] });

        // The window shows another version: everything the first one held is gone.
        yield* fixture.writePage(V2, page(ALL));
        yield* open(fixture, V2);
        assert.deepEqual([...fixture.registered.keys()], ["Command+Alt+2"]);
        assert.isTrue(fixture.trays[0]?.destroyed);
        assert.equal(fixture.onTop.get(fixture.liveWindows.get(ID)!), false);
        // And the old version can no longer ask from this window.
        assert.deepEqual(yield* register("Cmd+Alt+1"), REFUSED);

        // The other window closes: its shortcut is released too.
        fixture.liveWindows.delete(OTHER_ID);
        for (const listener of fixture.closedListeners) listener(OTHER_ID);
        yield* settle;
        assert.deepEqual([...fixture.registered.keys()], []);

        // "close" from the window releases and lets the frame go nowhere.
        yield* open(fixture, V1);
        yield* register("Cmd+Alt+1");
        assert.deepEqual(yield* fixture.powers.permissions(WC, { action: "close" }), {
          attachmentId: null,
          declared: [],
          granted: [],
        });
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.deepEqual(fixture.versionUrls.at(-1), [ID, null]);
        assert.deepEqual(yield* notify(fixture), REFUSED);
      }),
    ),
  );
});

describe("ArtifactAppPowerService permissions", () => {
  it.effect("lists what this version has, turns all of it off at once, and can ask again", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] });
        yield* ask(fixture, "app/shortcut/register", { accelerator: "Cmd+Alt+1" });
        yield* ask(fixture, "app/window/always-on-top", { on: true });
        assert.deepEqual(yield* fixture.powers.permissions(WC, { action: "get" }), {
          attachmentId: V1,
          declared: [...ALL],
          granted: [...ALL],
        });

        const off = yield* fixture.powers.permissions(WC, { action: "turn-off" });
        assert.deepEqual(off, { attachmentId: V1, declared: [...ALL], granted: [] });
        assert.isTrue(fixture.trays[0]?.destroyed);
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.equal(fixture.onTop.get(fixture.liveWindows.get(ID)!), false);
        assert.deepEqual(
          Option.map(yield* fixture.grants.find(ID, V1), (grant) => grant.powers),
          Option.some([]),
        );
        assert.deepEqual(yield* notify(fixture), REFUSED);
        // Still off after the window opens the version again, and without a question.
        assert.deepEqual((yield* open(fixture)).granted, []);
        assert.equal(fixture.dialogs.length, 1);

        // "Ask again" shows the dialog; Cancel keeps it off, Allow turns it back on.
        fixture.answer = 1;
        assert.deepEqual((yield* fixture.powers.permissions(WC, { action: "ask" })).granted, []);
        assert.equal(fixture.dialogs.length, 2);
        fixture.answer = 0;
        assert.deepEqual((yield* fixture.powers.permissions(WC, { action: "ask" })).granted, [
          ...ALL,
        ]);
        assert.deepEqual(yield* notify(fixture), OK);
      }),
    ),
  );

  it.effect("stays off when turning off could not be saved", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* ask(fixture, "app/shortcut/register", { accelerator: "Cmd+Alt+1" });
        fixture.failGrantWrites = true;
        const off = yield* fixture.powers.permissions(WC, { action: "turn-off" });
        assert.deepEqual(off.granted, []);
        // The saved answer still says Allow, yet nothing is allowed.
        assert.deepEqual(
          Option.map(yield* fixture.grants.find(ID, V1), (grant) => grant.powers),
          Option.some([...ALL]),
        );
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.deepEqual(yield* notify(fixture), REFUSED);
        assert.deepEqual((yield* open(fixture)).granted, []);
        assert.deepEqual(yield* notify(fixture), REFUSED);
        assert.deepEqual((yield* fixture.powers.permissions(WC, { action: "get" })).granted, []);
      }),
    ),
  );

  it.effect("stays off when it was turned off while the page's file could not be read", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const filePath = `${fixture.attachmentsDir}/${V1}.html`;
        const html = yield* fixture.fileSystem.readFileString(filePath);
        yield* fixture.fileSystem.remove(filePath);
        fixture.failGrantWrites = true;
        assert.deepEqual(
          (yield* fixture.powers.permissions(WC, { action: "turn-off" })).granted,
          [],
        );
        // The same bytes come back and the saved answer still says Allow.
        yield* fixture.fileSystem.writeFileString(filePath, html);
        assert.deepEqual(yield* notify(fixture), REFUSED);
        assert.deepEqual((yield* fixture.powers.permissions(WC, { action: "get" })).granted, []);
      }),
    ),
  );

  it.effect("tells a page nothing once its window cannot be found", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* ask(fixture, "app/shortcut/register", { accelerator: "Cmd+Alt+1" });
        yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [{ id: "a", label: "A" }] });
        const press = fixture.registered.get("Command+Alt+1")!;
        const tray = fixture.trays[0]!;
        // The window is gone, and nothing has said so yet.
        fixture.liveWindows.delete(ID);
        press();
        tray.input.items[0]?.onClick();
        yield* settle;
        assert.deepEqual(fixture.sent, []);
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.isTrue(tray.destroyed);
      }),
    ),
  );

  it.effect.each([
    [
      "its window closed",
      (fixture: Fixture) => {
        fixture.liveWindows.delete(ID);
        for (const listener of fixture.closedListeners) listener(ID);
      },
    ],
    [
      // Nothing has told the service: only asking the windows again shows it.
      "its window was replaced",
      (fixture: Fixture) => {
        fixture.liveWindows.set(ID, windowOf(ID));
      },
    ],
    [
      "its frame left the version",
      (fixture: Fixture) => {
        fixture.onVersion.set(ID, false);
      },
    ],
  ] as const)("refuses a request in flight when %s before it could act", ([, change]) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        const gate = yield* Deferred.make<void>();
        fixture.pagesGate = gate;
        // The request has passed its first checks and is reading the page's file.
        const request = yield* Effect.forkChild(notify(fixture));
        yield* settle;
        change(fixture);
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* Fiber.join(request), REFUSED);
        yield* settle;
        assert.deepEqual(fixture.notifications, []);
      }),
    ),
  );

  it.effect("gives everything back the moment a frame leaves the version", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* ask(fixture, "app/shortcut/register", { accelerator: "Cmd+Alt+1" });
        yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] });
        yield* ask(fixture, "app/window/always-on-top", { on: true });
        const window = fixture.liveWindows.get(ID)!;
        // No request, press or click follows: the leaving itself releases.
        fixture.onVersion.set(ID, false);
        for (const listener of fixture.strayedListeners) listener(ID);
        yield* settle;
        assert.deepEqual([...fixture.registered.keys()], []);
        assert.isTrue(fixture.trays[0]!.destroyed);
        assert.equal(fixture.onTop.get(window), false);
        // The Permissions menu shows nothing granted for a frame that left.
        assert.deepEqual((yield* fixture.powers.permissions(WC, { action: "get" })).granted, []);
      }),
    ),
  );

  it.effect("starts clean on a new answer: what an earlier one let the page hold is gone", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* granted(fixture);
        yield* ask(fixture, "app/tray/set", { tooltip: "Timer", items: [] });
        yield* ask(fixture, "app/shortcut/register", { accelerator: "Cmd+Alt+1" });
        // The file now declares less, and the person allows that.
        yield* fixture.writePage(V1, page(["notifications"]));
        const state = yield* fixture.powers.permissions(WC, { action: "ask" });
        assert.deepEqual(state.granted, ["notifications"]);
        assert.isTrue(fixture.trays[0]!.destroyed);
        assert.deepEqual([...fixture.registered.keys()], []);
      }),
    ),
  );

  it.effect(
    "answers a window that is not an installed page with nothing, and changes nothing",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.writePage(V1, page(ALL));
          const none = { attachmentId: null, declared: [], granted: [] };
          assert.deepEqual(yield* open(fixture, V1, URL_1, 7), none);
          for (const action of ["get", "ask", "turn-off", "close"] as const) {
            assert.deepEqual(yield* fixture.powers.permissions(7, { action }), none);
            // And an installed page with no version open.
            assert.deepEqual(yield* fixture.powers.permissions(WC, { action }), none);
          }
          assert.deepEqual(fixture.dialogs, []);
          assert.deepEqual(fixture.versionUrls, [[ID, null]]);
        }),
      ),
  );

  it.effect("names the system tray outside macOS", () =>
    withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.writePage(V1, page(["tray"]));
          yield* open(fixture);
          assert.include(fixture.dialogs[0]?.detail, "Add an item to the system tray");
        }),
      { platform: "linux" },
    ),
  );
});
