import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ArtifactAppInstaller from "../../artifactApps/ArtifactAppInstaller.ts";
import * as ArtifactAppPowerService from "../../artifactApps/ArtifactAppPowerService.ts";
import * as ArtifactAppRecords from "../../artifactApps/ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "../../artifactApps/ArtifactAppWindows.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  artifactAppPermissions,
  artifactAppPower,
  getArtifactApp,
  installArtifactApp,
  listArtifactApps,
  revealArtifactApp,
  uninstallArtifactApp,
} from "./artifactApps.ts";

const ID = "a".repeat(32);
const app: DesktopArtifactApp = {
  installId: ID,
  name: "Board",
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Board",
  installedAt: "2026-11-24T12:00:00.000Z",
};
const callingWindow = { id: 7 } as Electron.BrowserWindow;

const setup = () => {
  const installs: Array<{ readonly title: string; readonly owner: unknown }> = [];
  const uninstalled: Array<string> = [];
  const revealed: Array<string> = [];
  const permissionCalls: Array<readonly [number, unknown]> = [];
  const powerCalls: Array<readonly [number, unknown]> = [];
  const layer = Layer.mergeAll(
    Layer.mock(ArtifactAppPowerService.ArtifactAppPowerService)({
      permissions: (webContentsId, input) =>
        Effect.sync(() => {
          permissionCalls.push([webContentsId, input]);
          return { attachmentId: "v-1", declared: ["tray" as const], granted: [] };
        }),
      power: (webContentsId, input) =>
        Effect.sync(() => {
          powerCalls.push([webContentsId, input]);
          return { ok: true as const };
        }),
    }),
    Layer.mock(ArtifactAppInstaller.ArtifactAppInstaller)({
      install: (input, options) =>
        Effect.sync(() => {
          installs.push({ title: input.title, owner: options?.owner });
          return { status: "installed" as const, app };
        }),
      uninstall: (installId) =>
        Effect.sync(() => {
          uninstalled.push(installId);
          return true;
        }),
      reveal: (installId) =>
        Effect.sync(() => {
          revealed.push(installId);
          return false;
        }),
    }),
    Layer.mock(ArtifactAppRecords.ArtifactAppRecords)({
      list: Effect.succeed([app]),
      get: (installId) => Effect.succeed(installId === ID ? Option.some(app) : Option.none()),
    }),
    Layer.mock(ArtifactAppWindows.ArtifactAppWindows)({
      installIdForWebContents: (id) => Effect.succeed(id === 42 ? Option.some(ID) : Option.none()),
    }),
    Layer.mock(ElectronWindow.ElectronWindow)({
      appWindowForWebContents: (id) =>
        Effect.succeed(id === 42 ? Option.some(callingWindow) : Option.none()),
    }),
  );
  return { layer, installs, uninstalled, revealed, permissionCalls, powerCalls };
};

const event = (id: number) => ({ sender: { id } });

describe("artifact app IPC", () => {
  it.effect("installs with the calling window as the dialog owner", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const result = yield* installArtifactApp.handler(
        {
          environmentId: "environment-1",
          threadId: "thread-1",
          attachmentId: "a-1",
          title: "Board",
        },
        event(42),
      );
      assert.deepEqual(result, { status: "installed", app });
      assert.deepEqual(fixture.installs, [{ title: "Board", owner: Option.some(callingWindow) }]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("rejects malformed install, uninstall and reveal payloads", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      for (const payload of [
        undefined,
        {},
        { environmentId: "", threadId: "t", attachmentId: "a", title: "x" },
        { environmentId: "e", threadId: "t", attachmentId: "a", title: "" },
        { environmentId: "e", threadId: "t", attachmentId: "a", title: "x".repeat(201) },
      ]) {
        assert.equal(
          (yield* Effect.exit(installArtifactApp.handler(payload, event(42))))._tag,
          "Failure",
        );
      }
      for (const payload of [
        undefined,
        {},
        { installId: "../x" },
        { installId: ID.toUpperCase() },
      ]) {
        assert.equal((yield* Effect.exit(uninstallArtifactApp.handler(payload)))._tag, "Failure");
        assert.equal((yield* Effect.exit(revealArtifactApp.handler(payload)))._tag, "Failure");
      }
      assert.deepEqual(fixture.installs, []);
      assert.deepEqual(fixture.uninstalled, []);
      assert.deepEqual(fixture.revealed, []);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("uninstalls, reveals and lists through the installer and records", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      assert.isTrue(yield* uninstallArtifactApp.handler({ installId: ID }));
      assert.isFalse(yield* revealArtifactApp.handler({ installId: ID }));
      assert.deepEqual(yield* listArtifactApps.handler(undefined), [app]);
      assert.deepEqual(fixture.uninstalled, [ID]);
      assert.deepEqual(fixture.revealed, [ID]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("answers get with the calling window's install, null elsewhere", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      assert.deepEqual(yield* getArtifactApp.handler(undefined, event(42)), app);
      assert.isNull(yield* getArtifactApp.handler(undefined, event(1)));
      assert.isNull(yield* getArtifactApp.handler(undefined));
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("hands power and permission requests to the service with the calling window", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const open = { action: "open", attachmentId: "v-1", url: "http://127.0.0.1:1/a" };
      assert.deepEqual(yield* artifactAppPermissions.handler(open, event(42)), {
        attachmentId: "v-1",
        declared: ["tray"],
        granted: [],
      });
      const request = { attachmentId: "v-1", method: "app/notify", params: { title: "t" } };
      assert.deepEqual(yield* artifactAppPower.handler(request, event(42)), { ok: true });
      // The service decides from the sender; the payload carries no install.
      assert.deepEqual(fixture.permissionCalls, [[42, open]]);
      assert.deepEqual(fixture.powerCalls, [[42, request]]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refuses power and permission requests with no sender or a malformed payload", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      assert.deepEqual(yield* artifactAppPermissions.handler({ action: "turn-off" }), {
        attachmentId: null,
        declared: [],
        granted: [],
      });
      assert.deepEqual(
        yield* artifactAppPower.handler({ attachmentId: "v-1", method: "app/notify", params: {} }),
        { ok: false, error: "not-allowed" },
      );
      for (const payload of [
        undefined,
        {},
        { action: "grant" },
        { action: "open" },
        { action: "open", attachmentId: "", url: "http://127.0.0.1:1/a" },
        { action: "open", attachmentId: "v-1", url: "" },
        { action: "open", attachmentId: "v-1", url: "x".repeat(8193) },
      ]) {
        assert.equal(
          (yield* Effect.exit(artifactAppPermissions.handler(payload, event(42))))._tag,
          "Failure",
        );
      }
      for (const payload of [
        undefined,
        {},
        { method: "app/notify", params: {} },
        { attachmentId: "", method: "app/notify", params: {} },
        { attachmentId: "v-1", method: "", params: {} },
        { attachmentId: "v-1", method: "x".repeat(65), params: {} },
        { attachmentId: "v-1", method: 7, params: {} },
      ]) {
        assert.equal(
          (yield* Effect.exit(artifactAppPower.handler(payload, event(42))))._tag,
          "Failure",
        );
      }
      assert.deepEqual(fixture.permissionCalls, []);
      assert.deepEqual(fixture.powerCalls, []);
    }).pipe(Effect.provide(fixture.layer));
  });
});
