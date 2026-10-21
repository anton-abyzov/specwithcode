import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type DesktopUpdateActionResult,
  DesktopUpdateActionResultSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateInstallOptionsSchema,
} from "./desktopUpdateActions.ts";
import { type DesktopUpdateState, DesktopUpdateStateSchema } from "./desktopUpdateState.ts";

// The desktop encodes each updater answer with these schemas before a window
// sees it: a key they leave out never reaches the window.

const state: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.64",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.0.65",
  downloadedVersion: "1.0.65",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "The update did not install.",
  errorContext: "install",
  canRetry: true,
};

const encodeAction = (result: DesktopUpdateActionResult) =>
  Schema.encodeUnknownSync(DesktopUpdateActionResultSchema)(result);

describe("an updater answer sent to a window", () => {
  it("says whether an install was accepted and finished", () => {
    expect(encodeAction({ accepted: true, completed: true, state })).toMatchObject({
      accepted: true,
      completed: true,
    });
  });

  it("says an accepted install failed and the app stayed open", () => {
    expect(encodeAction({ accepted: true, completed: false, failed: true, state })).toMatchObject({
      accepted: true,
      completed: false,
      failed: true,
    });
  });

  it("says why an install was refused", () => {
    expect(
      encodeAction({ accepted: false, completed: false, reason: "no-download", state }),
    ).toMatchObject({ accepted: false, reason: "no-download" });
  });

  it("says whether a check ran", () => {
    expect(
      Schema.encodeUnknownSync(DesktopUpdateCheckResultSchema)({ checked: true, state }),
    ).toMatchObject({ checked: true });
  });
});

const decodeState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);
const decodeInstallOptions = Schema.decodeUnknownSync(DesktopUpdateInstallOptionsSchema);

describe("what a window and the desktop read from each other", () => {
  it("a window reads the state of a check in progress", () => {
    expect(decodeState({ ...state, status: "checking" })).toMatchObject({ status: "checking" });
  });

  it("the desktop reads the version an install asks for", () => {
    expect(decodeInstallOptions({ expectedVersion: "1.0.64" })).toEqual({
      expectedVersion: "1.0.64",
    });
  });

  it("the desktop refuses an install request whose version is not text", () => {
    expect(() => decodeInstallOptions({ expectedVersion: 1064 })).toThrow();
  });
});
