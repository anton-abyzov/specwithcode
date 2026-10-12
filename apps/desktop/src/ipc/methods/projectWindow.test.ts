import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { openProjectWindow } from "./projectWindow.ts";

const windowLayer = (opened: Array<DesktopWindow.OpenProjectWindowInput>) =>
  Layer.mock(DesktopWindow.DesktopWindow)({
    openProjectWindow: (input) =>
      Effect.sync(() => {
        opened.push(input);
        return {} as Electron.BrowserWindow;
      }),
  });

describe("openProjectWindow", () => {
  it.effect("opens the window for the project the renderer named", () => {
    const opened: Array<DesktopWindow.OpenProjectWindowInput> = [];

    return Effect.gen(function* () {
      yield* openProjectWindow.handler({ projectKey: "git:acme/app", title: "App" });
      yield* openProjectWindow.handler({ projectKey: "path:/work/site" });

      assert.deepEqual(opened, [
        { projectKey: "git:acme/app", title: "App" },
        { projectKey: "path:/work/site" },
      ]);
    }).pipe(Effect.provide(windowLayer(opened)));
  });

  it.effect("rejects a payload without a usable project key", () => {
    const opened: Array<DesktopWindow.OpenProjectWindowInput> = [];

    return Effect.gen(function* () {
      for (const payload of [
        undefined,
        {},
        { projectKey: "" },
        { projectKey: 42 },
        { projectKey: "x".repeat(1025) },
        { projectKey: "repo", title: "t".repeat(257) },
      ]) {
        const exit = yield* Effect.exit(openProjectWindow.handler(payload));
        assert.equal(exit._tag, "Failure");
      }
      assert.deepEqual(opened, []);
    }).pipe(Effect.provide(windowLayer(opened)));
  });
});
