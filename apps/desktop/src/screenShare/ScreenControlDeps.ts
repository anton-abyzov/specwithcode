// @effect-diagnostics nodeBuiltinImport:off -- The helper is a file in the app's bundle, checked before it is started.
/**
 * Control of this Mac's screen, as the session rules need it (1519): where
 * the helper is, whether the app holds Accessibility, where each display is,
 * and the flag computer use reads.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { currentPermissions } from "../computerUse/MacComputerUse.ts";
import { screenControlled } from "./screenControl.logic.ts";
import {
  releaseWithFreshHelper,
  SCREEN_CONTROL_HELPER_NAME,
  startScreenControlHelper,
} from "./ScreenControlHelper.ts";
import type { ScreenShareControlDeps } from "./screenShareSession.logic.ts";

/** The helper ships at `Resources/screen-control`; a development run builds it into `native/screen-control/.build`. */
export const screenControlHelperPath = (input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
}): string =>
  input.isPackaged
    ? NodePath.join(input.resourcesPath, "screen-control", SCREEN_CONTROL_HELPER_NAME)
    : NodePath.join(input.rootDir, "native/screen-control/.build", SCREEN_CONTROL_HELPER_NAME);

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

export function makeScreenControlDeps(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
}): ScreenShareControlDeps {
  const path = screenControlHelperPath(input);
  return {
    available: async () =>
      isExecutable(path) && (await currentPermissions().catch(() => null))?.accessibility === true,
    start: (events) =>
      isExecutable(path)
        ? startScreenControlHelper({ path, ...events })
        : Promise.resolve({ kind: "unavailable" }),
    bounds: (displayId) => {
      const display = Electron.screen
        .getAllDisplays()
        .find((candidate) => String(candidate.id) === displayId);
      return display === undefined ? null : display.bounds;
    },
    releaseOrphaned: (held) => void releaseWithFreshHelper(path, held).catch(() => undefined),
    controlled: (on) => screenControlled.set(on),
  };
}
