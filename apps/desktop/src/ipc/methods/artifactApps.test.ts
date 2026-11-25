import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ArtifactAppInstaller from "../../artifactApps/ArtifactAppInstaller.ts";
import * as ArtifactAppRecords from "../../artifactApps/ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "../../artifactApps/ArtifactAppWindows.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
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
  const layer = Layer.mergeAll(
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
  return { layer, installs, uninstalled, revealed };
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
});
