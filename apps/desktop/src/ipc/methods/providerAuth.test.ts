import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

const callback = vi.hoisted(() => ({
  receive: vi.fn(async () => "http://localhost:1455/auth/callback?code=ok"),
}));
vi.mock("../../app/CodexAuthCallback.ts", () => ({
  receiveCodexAuthCallback: callback.receive,
  cancelCodexAuthCallback: vi.fn(),
  CodexAuthCallbackError: class extends Error {},
}));

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { receiveProviderAuthCallback } from "./providerAuth.ts";

const mainWindow = { id: 1 } as Electron.BrowserWindow;
const projectWindow = { id: 2 } as Electron.BrowserWindow;

const receiveFrom = (sender: number | undefined) => {
  const revealed: Array<Electron.BrowserWindow> = [];
  return receiveProviderAuthCallback
    .handler(
      "https://auth.openai.com/oauth/authorize?state=abc",
      sender === undefined
        ? undefined
        : ({ sender: { id: sender } } as Electron.IpcMainInvokeEvent),
    )
    .pipe(
      Effect.provideService(ElectronShell.ElectronShell, {
        openExternal: () => Effect.void,
      } as unknown as ElectronShell.ElectronShell["Service"]),
      Effect.provideService(ElectronWindow.ElectronWindow, {
        appWindowForWebContents: (id: number) =>
          Effect.succeed(id === 20 ? Option.some(projectWindow) : Option.none()),
        currentMainOrFirst: Effect.succeedSome(mainWindow),
        reveal: (window: Electron.BrowserWindow) =>
          Effect.sync(() => {
            revealed.push(window);
          }),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.map(() => revealed),
    );
};

it.effect("brings back the project window a sign-in was started from", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* receiveFrom(20), [projectWindow]);
  }),
);

it.effect("brings back the main window for any other sender", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* receiveFrom(99), [mainWindow]);
    assert.deepEqual(yield* receiveFrom(undefined), [mainWindow]);
  }),
);
